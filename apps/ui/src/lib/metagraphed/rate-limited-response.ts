import { ApiError } from "./client";

/**
 * `Retry-After` for a throttled document (#11000).
 *
 * The public API meters anonymous callers with a fixed 60-request / 60-second
 * window (`DATA_TIERED_RATE_LIMIT.anonymous` in workers/api.ts), so the caller's
 * budget always clears inside a minute. Stated as a concrete number rather than
 * an HTTP-date because the window is a duration, not an instant, and a duration
 * cannot skew against a client's clock.
 */
export const RATE_LIMITED_RETRY_AFTER_SECONDS = 60;

/**
 * Turn a rate-limited primary query into the response a crawler acts on.
 *
 * A route whose OWN data was throttled has nothing to render, and until now it
 * answered `200` with a red "Couldn't load this data / HTTP 429" card in the
 * body. That is the worst of both outcomes: a human is told something is broken
 * when nothing is, and a crawler — which reads the status, not the card — is
 * told the page rendered fine and indexes the error.
 *
 * `429` + `Retry-After` is the documented signal for exactly this, and both
 * Google and Bing act on it: back off, keep the URL, come back. It is also
 * strictly better than `noindex`, which would drop a real page over a transient
 * ceiling — the failure mode this codebase already warned about in
 * blocks.$ref.tsx's loader ("marking a page noindex on a transient blip would
 * de-index real entities during an outage").
 *
 * Returns null for anything that is not a 429, so a caller can keep its existing
 * error handling underneath.
 */
export function rateLimitedResponse(error: unknown): Response | null {
  if (!(error instanceof ApiError) || error.status !== 429) return null;
  return new Response(renderRateLimitedPage(), {
    status: 429,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "retry-after": String(RATE_LIMITED_RETRY_AFTER_SECONDS),
      // A throttled render must never be stored as if it were the page: the
      // next caller's budget is not this one's.
      "cache-control": "no-store",
    },
  });
}

/**
 * Standalone HTML for a throttled page.
 *
 * Deliberately static and dependency-free, like renderErrorPage(): this is
 * returned INSTEAD of the React render (the loader throws it before streaming
 * begins), so it cannot rely on the app shell having booted.
 */
export function renderRateLimitedPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Rate-limited — Metagraphed</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font: 15px/1.5 system-ui, -apple-system, sans-serif; background: #fafafa; color: #111; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 1.5rem; }
      .card { max-width: 28rem; width: 100%; text-align: center; padding: 2rem; }
      h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
      p { color: #4b5563; margin: 0 0 1.5rem; }
      .actions { display: flex; gap: 0.5rem; justify-content: center; flex-wrap: wrap; }
      a, button { padding: 0.5rem 1rem; border-radius: 0.375rem; font: inherit; cursor: pointer; text-decoration: none; border: 1px solid transparent; }
      .primary { background: #111; color: #fff; }
      .secondary { background: #fff; color: #111; border-color: #d1d5db; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Rate-limited</h1>
      <p>You've hit the public API's per-minute ceiling. Nothing is broken — this page will load again in under a minute.</p>
      <div class="actions">
        <button class="primary" onclick="location.reload()">Try again</button>
        <a class="secondary" href="/">Go home</a>
      </div>
    </div>
  </body>
</html>`;
}
