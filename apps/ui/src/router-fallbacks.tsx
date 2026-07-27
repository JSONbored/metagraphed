import { useRouter } from "@tanstack/react-router";
import { ErrorState, Skeleton } from "./components/metagraphed/states";
import { recoverFromChunkLoadFailure } from "@/lib/chunk-reload-recovery";

// Outlet-scoped default boundary: a loader error in any route that doesn't
// define its own errorComponent renders here, INSIDE the root shell, instead of
// bubbling to __root's full-page errorComponent and replacing the chrome.
// Retry invalidates the route so a transient failure can re-run the loader.
//
// This is also where a `React.lazy()` chunk failure surfaces (e.g. the nav
// mega menu's dynamically-imported panel, apps/ui/src/components/metagraphed/
// nav-mega-menu.tsx) -- the rejected import() throws during that Suspense
// boundary's render and bubbles to the route's own error boundary, which
// falls back to this component since no route defines its own. Cloudflare
// Workers Static Assets replace the entire asset manifest on every deploy,
// so a stale tab can hold a chunk hash that's since been pruned -- re-running
// the loader via `reset()` can't fix that (the file is truly gone), so this
// checks for that specific failure first and hard-reloads instead, which
// picks up the current deploy's manifest.
export function DefaultRouteError({ error, reset }: { error: unknown; reset: () => void }) {
  const router = useRouter();
  if (recoverFromChunkLoadFailure((error as Error)?.message)) {
    return null;
  }
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <ErrorState
        error={error}
        onRetry={() => {
          void router.invalidate();
          reset();
        }}
      />
    </div>
  );
}

// Outlet-scoped pending state while a route loader resolves. Sits inside the
// shell so navigation never blanks the page chrome.
export function DefaultRoutePending() {
  return (
    <div className="mx-auto max-w-3xl space-y-3 px-4 py-10" role="status" aria-busy="true">
      <Skeleton className="h-6 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}
