// Per-IP abuse control for the WSS load balancer (#6444) — README.md's own
// pre-launch TODO: "a public wss proxy is a DoS amplifier" with nothing
// enforcing that yet. Two independent, additive budgets, both checked at
// CONNECT time (before any upstream dial — the cheapest possible rejection
// point):
//   - a concurrent-connection CAP: each open client holds a client socket
//     AND an upstream socket for its whole session, unlike a stateless HTTP
//     request, so unbounded concurrency from one IP is a real fd/memory
//     exhaustion vector, not just noisy traffic.
//   - a rolling connection-ATTEMPT rate limit: bounds connect-storm/
//     reconnect-loop abuse independent of how long any one connection
//     stays open (a client that opens-and-immediately-closes in a tight
//     loop never trips the concurrent cap).
// In-memory only — wss-lb is a single Railway container with no shared
// store, unlike workers/request-handlers/rpc-proxy.mjs's Cloudflare-side
// RPC_RATE_LIMITER (a Workers Rate Limiting binding). Same spirit
// (per-client-IP budget, reject with retry-after), different mechanism —
// that binding doesn't exist outside Cloudflare. Pure + clock-injectable
// for tests; server.ts wires in the real Date.now/setInterval.

// Cloudflare terminates TLS in front of this service (README.md: "point
// Cloudflare DNS at it for TLS + DDoS", i.e. proxied/orange-cloud, not
// DNS-only) and sets cf-connecting-ip on every request it forwards —
// matches workers/config.mjs's own resolveClientIp exactly, for the same
// reason: it's the one header a client can't spoof past Cloudflare's edge.
// x-forwarded-for (Railway's own edge hop) is a fallback for local/direct
// access that bypasses Cloudflare (dev, health probes); the raw socket
// address is the last resort so a lookup never throws.
// A minimal shape covering both the real http.IncomingMessage the 'upgrade'
// handler passes and the plain-object fixtures the unit tests pass directly.
interface ClientRequestLike {
  headers?: {
    "cf-connecting-ip"?: string;
    "x-forwarded-for"?: string;
    [key: string]: unknown;
  };
  socket?: { remoteAddress?: string };
}

export function resolveClientIp(req: ClientRequestLike): string {
  const cf = req.headers?.["cf-connecting-ip"];
  if (typeof cf === "string" && cf) return cf;
  const xff = req.headers?.["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

interface ConnectionLimiterOptions {
  maxConcurrent?: number;
  maxAttemptsPerWindow?: number;
  windowMs?: number;
  now?: () => number;
}

type ConnectionCheckResult =
  { ok: true } | { ok: false; reason: string; retryAfterSeconds: number };

interface AttemptWindow {
  count: number;
  windowStart: number;
}

// maxConcurrent/maxAttemptsPerWindow are per-IP budgets; windowMs is the
// attempt-rate window. now() is injectable so tests don't need real timers.
export function createConnectionLimiter(opts: ConnectionLimiterOptions = {}) {
  const maxConcurrent = opts.maxConcurrent ?? 20;
  const maxAttemptsPerWindow = opts.maxAttemptsPerWindow ?? 30;
  const windowMs = opts.windowMs ?? 60000;
  const now = opts.now ?? (() => Date.now());

  const concurrent = new Map<string, number>(); // ip -> open-connection count
  const attempts = new Map<string, AttemptWindow>(); // ip -> { count, windowStart }

  // Checks BOTH budgets and, only if both pass, atomically reserves one slot
  // in each (a rejected attempt must not consume the attempt-rate budget it
  // just failed, or a sustained attacker would self-throttle their own next
  // legitimate retry window for no reason).
  function checkAndTrack(ip: string): ConnectionCheckResult {
    const concurrentCount = concurrent.get(ip) || 0;
    if (concurrentCount >= maxConcurrent) {
      return {
        ok: false,
        reason: "concurrent_limit",
        retryAfterSeconds: Math.ceil(windowMs / 1000),
      };
    }
    const t = now();
    let a = attempts.get(ip);
    if (!a || t - a.windowStart >= windowMs) {
      a = { count: 0, windowStart: t };
    }
    if (a.count >= maxAttemptsPerWindow) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((a.windowStart + windowMs - t) / 1000),
      );
      attempts.set(ip, a);
      return { ok: false, reason: "attempt_rate_limit", retryAfterSeconds };
    }
    a.count += 1;
    attempts.set(ip, a);
    concurrent.set(ip, concurrentCount + 1);
    return { ok: true };
  }

  // Must be called exactly once per successful checkAndTrack when that
  // client's connection actually closes (client 'close'/'error') — an
  // un-released slot permanently leaks one unit of that IP's concurrent
  // budget.
  function release(ip: string) {
    const c = concurrent.get(ip);
    if (!c) return;
    if (c <= 1) concurrent.delete(ip);
    else concurrent.set(ip, c - 1);
  }

  // Bounds memory from one-shot/abandoned IPs: an attempt-window entry is
  // only safe to drop once its window has fully elapsed AND it holds no
  // live concurrent connections (those stay tracked in `concurrent`
  // regardless of window age, released only via `release`).
  function prune() {
    const t = now();
    for (const [ip, a] of attempts) {
      if (t - a.windowStart >= windowMs && !concurrent.has(ip)) {
        attempts.delete(ip);
      }
    }
  }

  return { checkAndTrack, release, prune };
}
