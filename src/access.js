// Cloudflare Access JWT verification.
//
// Ported verbatim from train-every-day/access.js. Keep the two copies identical
// so a fix to one is an obvious copy to the other.
//
// Access signs every request it admits with RS256 and publishes the matching
// public keys at https://<team-domain>/cdn-cgi/access/certs. Verifying that
// signature is what makes an identity claim trustworthy on its own; the plain
// Cf-Access-Authenticated-User-Email header is only as trustworthy as whatever
// routing sits in front of the Worker.

const CERTS_TTL_MS = 3_600_000;
// An unrecognized kid earns one refetch, so a key Access rotated mid-TTL starts
// working without waiting an hour. That refetch is throttled to once per this
// interval per certs URL, because the alternative is one outbound request per
// inbound token: anyone who can reach the Worker can mint syntactically valid
// JWTs carrying a random kid, and each would otherwise become a fetch to the
// Access certs endpoint. A refresh that FAILED is throttled the same way and
// whether or not it was forced, because an isolate holding no usable keys never
// forces one: it would otherwise meet a certs endpoint that is down with a clean
// slate on every token and hand the amplification straight back. Rotation still
// resolves on the first such token.
const REFRESH_COOLDOWN_MS = 60_000;
const CLOCK_SKEW_SECONDS = 60;
const TEAM_DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

const certCache = new Map();
// One shared fetch per certs URL while it is in flight. The cooldown below is a
// timestamp, not a lock: without this, a burst of requests carrying unknown kids
// all read the cache before any of them has written a result back, and each
// issues its own certs fetch. Coalescing bounds a concurrent burst to one
// request; the cooldown bounds a sequential one.
const certsInFlight = new Map();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Exported for tests: the cache outlives a single request inside a Worker
// isolate, which is the point, but must not leak between test cases.
export function resetAccessKeyCache() {
  certCache.clear();
  certsInFlight.clear();
}

function base64UrlToBytes(value) {
  if (typeof value !== "string" || value.length === 0 || /[^A-Za-z0-9_-]/.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch (_) {
    return null;
  }
}

function decodeJsonSegment(segment) {
  const bytes = base64UrlToBytes(segment);
  if (!bytes) return null;
  let parsed;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch (_) {
    return null;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

function trimmedVar(env, name) {
  const value = env?.[name];
  return typeof value === "string" ? value.trim() : "";
}

// Returns null when the deployment has not been told which Access team and
// application to trust. Callers treat that as "not configured" and fail closed
// rather than guessing an issuer.
export function accessConfig(env) {
  const teamDomain = trimmedVar(env, "ACCESS_TEAM_DOMAIN");
  const audience = trimmedVar(env, "ACCESS_AUD");
  if (!teamDomain || !audience || !TEAM_DOMAIN_PATTERN.test(teamDomain)) return null;
  return {
    audience,
    issuer: `https://${teamDomain}`,
    certsUrl: `https://${teamDomain}/cdn-cgi/access/certs`
  };
}

// `cooldownFrom` is stamped whenever another fetch must not follow immediately:
// every forced refetch, and every refresh that failed. A first-or-expired fetch
// that SUCCEEDS deliberately leaves it alone, so a key rotation right after a
// cold start still resolves on the token that carries it rather than stalling.
async function refreshCerts(config, { now, fetchImpl, force }) {
  const pending = certsInFlight.get(config.certsUrl);
  if (pending) return pending;

  // Whatever keys are already cached carry over untouched, and their expiry is
  // not extended: a refresh that did not work must neither cost the working set
  // that verification is still using nor lengthen its life.
  const holdOff = () => {
    const previous = certCache.get(config.certsUrl);
    certCache.set(config.certsUrl, {
      keys: previous?.keys ?? [],
      expiresAt: previous?.expiresAt ?? now,
      cooldownFrom: now
    });
  };

  // Recorded before the request, not after it. A certs endpoint that is
  // unreachable, answers non-2xx, or returns something that is not JSON throws
  // before any write, so stamping only on success would mean the throttle
  // lapses during exactly the upstream failure it exists to survive.
  if (force) holdOff();

  const request = (async () => {
    try {
      const response = await fetchImpl(config.certsUrl);
      if (!response.ok) throw new Error(`Access certs request failed with ${response.status}`);
      const body = await response.json();
      const keys = Array.isArray(body?.keys) ? body.keys : [];
      // A successful unforced refresh carries the existing stamp forward rather
      // than setting one. The exception worth knowing about the forced case: a
      // refetch in the preceding minute — including one an unknown kid provoked
      // — means a rotation published in that window is not seen until the
      // cooldown lapses.
      certCache.set(config.certsUrl, {
        keys,
        expiresAt: now + CERTS_TTL_MS,
        cooldownFrom: certCache.get(config.certsUrl)?.cooldownFrom
      });
      return keys;
    } catch (error) {
      // The unforced callers — a cold isolate and a lapsed TTL — reach here
      // with nothing recorded, which is the hole a forced-only stamp left.
      holdOff();
      throw error;
    }
  })();

  certsInFlight.set(config.certsUrl, request);
  try {
    return await request;
  } finally {
    certsInFlight.delete(config.certsUrl);
  }
}

async function findSigningKey(config, kid, { now, fetchImpl, force }) {
  const cached = certCache.get(config.certsUrl);
  const usable = cached !== undefined && cached.expiresAt > now;
  const lookup = () => cached.keys.find((key) => key?.kid === kid) || null;

  if (!force && usable) return lookup();

  // A refresh still in flight is the exception to the cooldown: it is stamped
  // when that request starts, so answering from the cache here would hand every
  // caller that arrived during a rotation the stale keys the refresh is on its
  // way to replacing. Those callers fall through and wait for it instead, which
  // costs them nothing — refreshCerts hands back the request already running.
  const refreshing = certsInFlight.has(config.certsUrl);
  if (!refreshing && cached?.cooldownFrom !== undefined && now - cached.cooldownFrom < REFRESH_COOLDOWN_MS) {
    // This interval's fetch is already spent — on somebody else's unknown kid,
    // or against an endpoint that was down a moment ago. Answer from what is
    // cached rather than asking again.
    if (usable) return lookup();
    // Nothing usable is cached, so the honest answer is not "no such key", it
    // is "no keys" — and the caller turns that into `access keys unavailable`.
    throw new Error("Access certs refresh is throttled after a recent failure");
  }

  const keys = await refreshCerts(config, { now, fetchImpl, force });
  return keys.find((key) => key?.kid === kid) || null;
}

function rejected(error) {
  return { ok: false, error };
}

// Resolves to { ok: true, claims } only when the token is signed by the
// configured Access team, issued for this application, and currently valid.
export async function verifyAccessJwt(token, config, options = {}) {
  const now = options.now ?? Date.now();
  const fetchImpl = options.fetch ?? fetch;
  const subtle = options.subtle ?? crypto.subtle;

  if (typeof token !== "string") return rejected("missing token");
  const segments = token.split(".");
  if (segments.length !== 3) return rejected("malformed token");
  const [headerSegment, payloadSegment, signatureSegment] = segments;

  const header = decodeJsonSegment(headerSegment);
  if (!header || header.alg !== "RS256" || typeof header.kid !== "string") {
    return rejected("unsupported token header");
  }
  const signature = base64UrlToBytes(signatureSegment);
  if (!signature) return rejected("malformed signature");

  let jwk;
  try {
    // Access rotates signing keys, so an unrecognized kid earns one refetch
    // before it is treated as a forgery.
    jwk = await findSigningKey(config, header.kid, { now, fetchImpl, force: false })
      ?? await findSigningKey(config, header.kid, { now, fetchImpl, force: true });
  } catch (_) {
    return rejected("access keys unavailable");
  }
  if (!jwk) return rejected("unknown signing key");

  let valid;
  try {
    const key = await subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    valid = await subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      encoder.encode(`${headerSegment}.${payloadSegment}`)
    );
  } catch (_) {
    return rejected("unusable signing key");
  }
  if (!valid) return rejected("signature mismatch");

  const claims = decodeJsonSegment(payloadSegment);
  if (!claims) return rejected("malformed claims");
  if (claims.iss !== config.issuer) return rejected("unexpected issuer");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(config.audience)) return rejected("unexpected audience");

  const seconds = Math.floor(now / 1000);
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS <= seconds) {
    return rejected("expired token");
  }
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > seconds) {
    return rejected("token not yet valid");
  }
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_SECONDS > seconds) {
    return rejected("token issued in the future");
  }
  return { ok: true, claims };
}

// A browser session carries the signed-in email; a service token carries only
// the token's common name, which no user ever owns.
export function accessIdentity(claims) {
  const email = typeof claims?.email === "string" ? claims.email.trim() : "";
  if (email) return { type: "user", email };
  const serviceName = typeof claims?.common_name === "string" ? claims.common_name.trim() : "";
  if (serviceName) return { type: "service", serviceName };
  return null;
}
