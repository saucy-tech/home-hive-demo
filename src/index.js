/**
 * The Home Hive — API worker.
 *
 * Static assets are served first (see wrangler.jsonc); this only ever runs for
 * paths that don't match a file, which in practice means /api/*.
 *
 * State model: ONE shared household document. Both parents write to it from
 * whatever device is in hand, so the merge below is deliberately delta-based —
 * a phone that's been asleep since Tuesday must not be able to resurrect
 * Tuesday's view of the week by PUTing everything it thinks it knows. Clients
 * send only what changed; the server merges and returns the whole truth back.
 */

const STATE_KEY = "hive:state:v1";

/* The only hostname whose requests may touch the household record. The demo
 * build is the same code with no KV binding and this constant rewritten, so
 * two independent things have to be wrong before a public deployment can read
 * or write a real week. See docs/demo-deployment.md. */
const DATA_HOSTNAME = "app.example.invalid";
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0"];
const isDataHost = h => h === DATA_HOSTNAME || LOCAL_HOSTS.includes(h);

// Every top-level bucket is a flat map keyed by "<week>:<day>:<item>".
// Flat keys are what make the delta merge safe — two devices touching
// different activities never collide, even inside the same day.
const BUCKETS = ["checks", "stretch", "feelings", "helps", "notes", "stars", "games"];

function emptyState() {
  const s = {};
  for (const b of BUCKETS) s[b] = {};
  s.updatedAt = 0;
  s.updatedBy = null;
  return s;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // This data is per-household and gated; never let a proxy hold it.
      "cache-control": "no-store",
    },
  });
}

function whoami(request) {
  // Cloudflare Access injects this once the hostname is gated. Empty locally.
  return request.headers.get("Cf-Access-Authenticated-User-Email") || "";
}

async function readState(env) {
  const raw = await env.HIVE.get(STATE_KEY);
  if (!raw) return emptyState();
  try {
    // Merge over a fresh skeleton so a doc written by an older build still
    // comes back with every bucket present.
    return Object.assign(emptyState(), JSON.parse(raw));
  } catch {
    return emptyState();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      // Belt and braces: assets normally never reach the worker.
      return env.ASSETS.fetch(request);
    }

    // Barrier: the API does not exist anywhere but production. A demo build
    // has no KV binding either, so neither check alone is load-bearing.
    if (!isDataHost(url.hostname) || !env.HIVE) {
      return json({ error: "not found" }, 404);
    }

    const email = whoami(request);

    if (url.pathname === "/api/whoami") {
      return json({ email, gated: Boolean(email) });
    }

    if (url.pathname === "/api/state") {
      if (request.method === "GET") {
        return json(await readState(env));
      }

      if (request.method === "POST") {
        let delta;
        try {
          delta = await request.json();
        } catch {
          return json({ error: "expected a JSON body" }, 400);
        }

        const state = await readState(env);
        for (const bucket of BUCKETS) {
          const incoming = delta && delta[bucket];
          if (!incoming || typeof incoming !== "object") continue;
          for (const [k, v] of Object.entries(incoming)) {
            // Explicit false/null is a real value here (an unchecked box),
            // so assign rather than skip falsy.
            state[bucket][k] = v;
          }
        }
        state.updatedAt = Date.now();
        state.updatedBy = email || "local";

        await env.HIVE.put(STATE_KEY, JSON.stringify(state));
        return json(state);
      }

      if (request.method === "DELETE") {
        // "Start the week over" wipes only the keys the client names, so one
        // week can be reset without losing the rest of the year.
        let body;
        try {
          body = await request.json();
        } catch {
          body = {};
        }
        const prefix = typeof body.prefix === "string" ? body.prefix : null;
        if (!prefix) return json({ error: "prefix required" }, 400);

        const state = await readState(env);
        for (const bucket of BUCKETS) {
          for (const k of Object.keys(state[bucket])) {
            if (k.startsWith(prefix)) delete state[bucket][k];
          }
        }
        state.updatedAt = Date.now();
        state.updatedBy = email || "local";
        await env.HIVE.put(STATE_KEY, JSON.stringify(state));
        return json(state);
      }

      return json({ error: "method not allowed" }, 405);
    }

    return json({ error: "not found" }, 404);
  },
};
