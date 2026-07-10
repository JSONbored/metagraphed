// Reconciles the registry's surfaces.overlay JSONB shape ahead of the (not
// yet wired) registry-overlay read path (#4697). deploy/postgres/registry-
// schema.sql's surfaces table comment flags a dual-shape risk: overlay's
// write path (workers/registry-sync-api.mjs's isValidRow) does no shape
// enforcement on a surface's citation field, so a row could in principle
// carry the current plural `source_urls` array, a legacy singular
// `source_url` string, or both -- schema-illegal for git-committed
// registry/subnets/*.json today (schemas/subnet-manifest.schema.json's
// surface $def only defines source_urls), but not something Postgres itself
// rejects. Mirrors two existing precedents for the SAME field elsewhere in
// this codebase (scripts/generated-overlays.mjs's promoteCandidate,
// scripts/build-artifacts.mjs's AI-claims artifact) rather than inventing a
// third convention -- this is the one place future overlay-reading code
// should import from instead of re-deriving the fallback chain.
//
// Deliberately scoped to a surface's OWN source_url(s) only. A subnet's
// links[] array has its own, unrelated source_url field (schemas/subnet-
// manifest.schema.json's link $def) -- never consulted here.

/** Returns the source-citation URL(s) for one surface, tolerant of every
 * shape overlay's un-enforced write path could hand back: the current
 * plural `source_urls` array (100% of git-committed data today), a legacy
 * singular `source_url` string, or both present at once (plural wins, since
 * it's the actively-validated current shape). Returns [] when neither key is
 * present -- never falls back to the surface's own `.url` or a parent
 * subnet's `links[].source_url`, which are different fields entirely. */
export function normalizeSurfaceSourceUrls(surface) {
  if (!surface || typeof surface !== "object") return [];
  if (Array.isArray(surface.source_urls)) return surface.source_urls;
  if (typeof surface.source_url === "string" && surface.source_url) {
    return [surface.source_url];
  }
  return [];
}
