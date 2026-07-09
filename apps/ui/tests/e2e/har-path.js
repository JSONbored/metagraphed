// Shared between responsive-overflow.spec.ts and record-har.mjs so the two
// can't silently drift apart -- one HAR fixture file per ROUTES entry.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HAR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "har");

export function harPathForRoute(route) {
  const slug = route === "/" ? "home" : route.replace(/^\//, "").replace(/\//g, "-");
  return path.join(HAR_DIR, `${slug}.har`);
}

// Some endpoints bake volatile data into the URL path itself rather than a
// query param -- e.g. /api/v1/health/history/{date} defaults client-side to
// "today" (status-diagnostics.tsx's defaultDate), so a HAR recorded on one day
// never matches the same request replayed on a later day and silently falls
// back to live data, reintroducing the exact nondeterminism this fixture
// layer exists to remove. List each such endpoint's STABLE path prefix here
// (ignoring the volatile segment) so callers can register a priority route
// that serves whatever the HAR recorded regardless of what the live app
// requests today.
export const DATED_ENDPOINT_PATTERNS = [/\/api\/v1\/health\/history\/\d{4}-\d{2}-\d{2}(?:[/?]|$)/];

// Finds the first recorded entry in `harPath` matching `pattern` and returns
// its response as Playwright `route.fulfill()` options, or null if the HAR
// has no matching entry (nothing to serve, caller should skip registering a
// route for it).
export function findHarFixture(harPath, pattern) {
  const har = JSON.parse(readFileSync(harPath, "utf8"));
  const entry = har.log.entries.find((e) => pattern.test(e.request.url));
  if (!entry) return null;
  const content = entry.response.content ?? {};
  const body =
    content.encoding === "base64"
      ? Buffer.from(content.text ?? "", "base64")
      : (content.text ?? "");
  return {
    status: entry.response.status,
    contentType: content.mimeType || "application/json",
    body,
  };
}
