import { useRouter } from "@tanstack/react-router";
import { ErrorState, Skeleton } from "./components/metagraphed/states";
import { AppShell } from "@/components/metagraphed/app-shell";
import { recoverFromChunkLoadFailure } from "@/lib/chunk-reload-recovery";

// Outlet-scoped default boundary: a loader error in any route that doesn't
// define its own errorComponent renders here instead of bubbling to __root's
// full-page errorComponent.
//
// It mounts `AppShell` ITSELF (#11686). This comment used to claim the fallback
// rendered "inside the root shell", and that was true when the shell lived at
// the root -- but every page mounts its own `AppShell` now, so replacing the
// page replaced the chrome with it. Measured against an API answering 503 for
// everything: /subnets, /validators, /chain, /health and /contribute each
// collapsed to a 231px page holding one card, with no header, no nav and no
// footer -- a reader whose data failed could not navigate anywhere at all.
//
// If the SHELL is what threw, this re-throws into `GlobalErrorBoundary` above,
// which is the full-page card. That is the right order: try to keep the chrome,
// and fall back to the bare page only when the chrome is the thing that broke.
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
    <AppShell chromeOnly>
      <div className="mx-auto w-full max-w-3xl py-10">
        <ErrorState
          error={error}
          onRetry={() => {
            void router.invalidate();
            reset();
          }}
        />
      </div>
    </AppShell>
  );
}

// Pending state while a route loader resolves, in the shell for the same reason
// the error fallback is: a navigation that blanks the header and the nav makes
// the site look like it went down for as long as the loader runs.
export function DefaultRoutePending() {
  return (
    <AppShell chromeOnly>
      <div
        className="mx-auto flex w-full max-w-3xl flex-col gap-3 py-10"
        role="status"
        aria-busy="true"
      >
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    </AppShell>
  );
}
