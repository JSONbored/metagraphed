// Shared between responsive-overflow.spec.ts and record-har.mjs so the two
// can't silently drift apart -- one HAR fixture file per ROUTES entry.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HAR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "har");

export function harPathForRoute(route) {
  const slug = route === "/" ? "home" : route.replace(/^\//, "").replace(/\//g, "-");
  return path.join(HAR_DIR, `${slug}.har`);
}
