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

import { accessConfig, accessIdentity, verifyAccessJwt } from "./access.js";

const STATE_KEY = "hive:state:v1";

// A caller may not push more than this in one request, and the stored document
// may not grow past the second. KV's own ceiling is 25 MB, which is far past the
// point where every GET on a phone would already be unusable.
const MAX_BODY_BYTES = 256 * 1024;
const MAX_DOC_BYTES = 1024 * 1024;

// Keys are built client-side as "<week>:<day>:<item>" (app.js `K`), and the
// notes bucket keys on the week id alone. Rather than pin that shape — which
// would break the day a bucket earns a new one — reject only what no key
// should ever contain: control characters, newlines, and unbounded length.
const MAX_KEY_LENGTH = 200;
const MAX_VALUE_LENGTH = 4_000;
const KEY_PATTERN = /^[0-9A-Za-z][0-9A-Za-z:_.\- ]*$/;

// "Start the week over" names one week. Two shapes exist: the school track keys
// on the Sunday's date (public/weeks/2026-08-10.json), and every topic track
// keys on a unit id (public/topics/*/index.json — "body-01", "money-01").
// Both end in a segment that pins them to a single week, which is the point:
// without it the prefix is a free-text match over every bucket, so
// {"prefix":"2"} erased every week ever recorded in one request.
const WEEK_ID_PATTERN = /^(\d{4}-\d{2}-\d{2}|[a-z][a-z0-9]*-\d{2,})$/;

/* The only hostname whose requests may touch the household record. The demo
 * build is the same code with no KV binding and this constant rewritten, so
 * two independent things have to be wrong before a public deployment can read
 * or write a real week. See docs/demo-deployment.md. */
const DATA_HOSTNAME = "app.example.invalid";
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0"];
const isDataHost = h => h === DATA_HOSTNAME || LOCAL_HOSTS.includes(h);

// Local development only. Set DEV_TRUST_LOCAL_IDENTITY="true" in .dev.vars
// (untracked, see .dev.vars.example). Never set it in wrangler.jsonc.
//
// `wrangler dev` reads the vars out of wrangler.jsonc, where ACCESS_AUD is
// filled in for production, so .dev.vars blanks both Access vars alongside the
// flag — that is the whole reason the example file sets three lines and not
// one. .dev.vars wins over wrangler.jsonc there and is read nowhere else.
//
// Inert whenever Access is validly configured, which a working production must
// be — so on a healthy deployment this cannot take effect even if the variable
// were somehow set there. The gap it does not close: a deployment whose Access
// vars are *malformed* is also "not configured", so a Worker carrying both a
// broken ACCESS_AUD and this variable would trust the email header. That needs
// two independent mistakes, and the first one alone already answers 503 to
// every request, which is hard to miss — but it is a residual, not a proof, so
// every request served this way says so in the log.
const trustsLocalIdentity = env => env?.DEV_TRUST_LOCAL_IDENTITY === "true" && !accessConfig(env);

// Every top-level bucket is a flat map keyed by "<week>:<day>:<item>".
// Flat keys are what make the delta merge safe — two devices touching
// different activities never collide, even inside the same day.
const BUCKETS = ["checks", "stretch", "feelings", "helps", "notes", "stars", "games", "notices"];

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
      // public/_headers covers the static shell; a Worker response is built
      // here and gets none of that, so set the same floor on both.
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });
}

// An identity is REQUIRED for every /api/ call, and nothing about the
// configuration can turn that requirement off. Setting ACCESS_TEAM_DOMAIN and
// ACCESS_AUD only ever strengthens this — it swaps the header Access injects
// for the signed assertion Access issues — so a blank or fat-fingered var can
// never silently degrade the check the way a header fallback would.
//
// That is the property that matters here: before this, a request arriving with
// no Access headers at all was served the whole household record. Now the worst
// an ungated deployment does is 401, which is what the first-deploy incident in
// DEPLOY.md needed and did not have.
async function whoami(request, env) {
  // The one path that mints an identity without a signed assertion, for local
  // development where no Access sits in front. It is opt-in through a var that
  // only ever lives in .dev.vars — untracked, and absent from wrangler.jsonc —
  // so it cannot be switched on by a deploy or by editing committed config.
  //
  // Deliberately not keyed on the hostname: `wrangler dev` serves the request
  // under the route configured in wrangler.jsonc, not as localhost, so a
  // hostname check would be dead code here and a false comfort.
  if (trustsLocalIdentity(env)) {
    // Loud on purpose. In development this is noise in a terminal nobody reads;
    // in production it is the one line that says the API is not verifying
    // anything, and it should be impossible to look at the logs and miss it.
    console.warn("DEV_TRUST_LOCAL_IDENTITY is active: serving /api/ without verifying an Access assertion. This must never be set on the deployed Worker.");
    return (request.headers.get("Cf-Access-Authenticated-User-Email") || "").trim() || "local";
  }

  // Unconfigured is a refusal, not a downgrade. Requiring the plain
  // Cf-Access-Authenticated-User-Email header instead would be no defence in
  // the one scenario this exists for: if Access is not in front of the Worker,
  // that header is set by the caller, so an attacker supplies their own and is
  // back to full read, write and delete. train-every-day's handleExport takes
  // the same position, and the sibling endpoint that did not is the bug filed
  // against that repo.
  const config = accessConfig(env);
  if (!config) return null;

  const result = await verifyAccessJwt(request.headers.get("Cf-Access-Jwt-Assertion"), config);
  if (!result.ok) return null;
  const identity = accessIdentity(result.claims);
  return identity?.type === "user" ? identity.email : null;
}

// Rejects anything a client has no business writing: unnamed keys, keys long
// enough to bloat the document on their own, and values that are not the
// booleans, numbers and short strings every bucket actually stores.
function invalidEntry(key, value) {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) return "bad key";
  if (!KEY_PATTERN.test(key)) return "bad key";
  if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return "bad value";
  }
  if (typeof value === "string" && value.length > MAX_VALUE_LENGTH) return "bad value";
  return null;
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

    // Said out loud, because the alternative is every request answering 401 and
    // nobody knowing why. Refusing is still the right answer — see whoami.
    if (!trustsLocalIdentity(env) && !accessConfig(env)) {
      console.error("ACCESS_TEAM_DOMAIN/ACCESS_AUD are unset or malformed; refusing every /api/ request until they are valid.");
      return json({ error: "access is not configured" }, 503);
    }

    const email = await whoami(request, env);
    if (!email) return json({ error: "unauthorized" }, 401);

    if (url.pathname === "/api/whoami") {
      return json({ email, gated: Boolean(email) });
    }

    if (url.pathname === "/api/state") {
      if (request.method === "GET") {
        return json(await readState(env));
      }

      if (request.method === "POST") {
        // Measure the bytes rather than trusting Content-Length, which a
        // chunked request simply omits.
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
          return json({ error: "too large" }, 413);
        }

        let delta;
        try {
          delta = JSON.parse(raw);
        } catch {
          return json({ error: "expected a JSON body" }, 400);
        }

        const state = await readState(env);
        // Every bad entry is named, not just the first. The client pushes a
        // coalesced batch, so "this delta is bad" leaves it nothing to do but
        // throw the whole thing away — including the checkmarks and stars that
        // were fine. Naming them lets it drop exactly what was refused and keep
        // the rest. Still all-or-nothing against KV: the loop below writes into
        // a local copy and the put is skipped entirely if anything was refused.
        const invalid = [];
        for (const bucket of BUCKETS) {
          const incoming = delta && delta[bucket];
          if (!incoming || typeof incoming !== "object") continue;
          for (const [k, v] of Object.entries(incoming)) {
            const problem = invalidEntry(k, v);
            if (problem) {
              // The whole key, never a shortened one: the client matches on it
              // to decide what to drop, and the entry most likely to be refused
              // is the one that is too long. Bounded by the body cap above —
              // these keys came out of a request that is already limited.
              invalid.push({ bucket, key: k, problem });
              continue;
            }
            // Explicit false/null is a real value here (an unchecked box),
            // so assign rather than skip falsy.
            state[bucket][k] = v;
          }
        }
        // `error` stays the first problem so the existing shape still holds.
        if (invalid.length) return json({ error: invalid[0].problem, invalid }, 400);
        state.updatedAt = Date.now();
        state.updatedBy = email;

        const serialized = JSON.stringify(state);
        // Checked before the write, not after: KV rejects an oversized value
        // with an exception that would surface as a bare 500.
        if (new TextEncoder().encode(serialized).byteLength > MAX_DOC_BYTES) {
          return json({ error: "household record is full" }, 507);
        }
        try {
          await env.HIVE.put(STATE_KEY, serialized);
        } catch {
          return json({ error: "could not save" }, 503);
        }
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
        if (!WEEK_ID_PATTERN.test(prefix)) return json({ error: "prefix must be a week id" }, 400);

        const state = await readState(env);
        for (const bucket of BUCKETS) {
          for (const k of Object.keys(state[bucket])) {
            // Match on the week boundary, not on the raw string. Keys are
            // "<week>:<day>:<item>", or the week alone in the notes bucket, so
            // this deletes exactly one week and cannot spill into the next id
            // that happens to share a leading substring.
            if (k === prefix || k.startsWith(prefix + ":")) delete state[bucket][k];
          }
        }
        state.updatedAt = Date.now();
        state.updatedBy = email;
        try {
          await env.HIVE.put(STATE_KEY, JSON.stringify(state));
        } catch {
          return json({ error: "could not save" }, 503);
        }
        return json(state);
      }

      return json({ error: "method not allowed" }, 405);
    }

    return json({ error: "not found" }, 404);
  },
};
