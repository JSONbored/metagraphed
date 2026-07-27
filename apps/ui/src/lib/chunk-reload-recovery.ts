// Cloudflare Workers Static Assets fully replace the asset manifest on every
// deploy (unlike Cloudflare Pages, which keeps old hashed files reachable) --
// see .github/workflows/publish-cloudflare.yml. A tab left open across a
// deploy that then triggers a not-yet-loaded lazy chunk (e.g. the nav mega
// menu, apps/ui/src/components/metagraphed/nav-mega-menu.tsx's React.lazy())
// gets a dynamic import() 404 for a chunk hash that no longer exists on the
// server. No error boundary can recover from that by re-rendering -- the
// file is truly gone -- so the generic ErrorState "Retry" button just
// re-throws the same error forever. This module detects that specific
// failure and does a single guarded hard reload instead, which picks up the
// current deploy's manifest.

const RELOAD_FLAG = "mg:chunk-reload";
const RELOAD_TTL_MS = 30_000;

// Covers the known browser wordings for a failed dynamic import() plus
// Vite's own module-preload variant (same Chrome/Edge wording).
const CHUNK_LOAD_FAILURE_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
];

/** Pure predicate -- does this error message look like a stale-chunk 404? */
export function isChunkLoadFailure(message: string | undefined | null): boolean {
  if (!message) return false;
  return CHUNK_LOAD_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}

function readRecentReloadFlag(): boolean {
  try {
    const stored = Number(sessionStorage.getItem(RELOAD_FLAG));
    return Number.isFinite(stored) && stored > 0 && Date.now() - stored < RELOAD_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * If `message` matches a chunk-load failure, reloads the page once per
 * `RELOAD_TTL_MS` window (guarded via sessionStorage so a genuinely broken
 * deploy doesn't reload-loop the tab) and returns true. Otherwise a no-op
 * returning false, so callers can fall through to their normal error path.
 */
export function recoverFromChunkLoadFailure(message: string | undefined | null): boolean {
  if (typeof window === "undefined") return false;
  if (!isChunkLoadFailure(message)) return false;
  if (readRecentReloadFlag()) return false;
  try {
    sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
  } catch {
    /* noop */
  }
  window.location.reload();
  return true;
}
