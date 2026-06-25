import { QueryClient } from "@tanstack/react-query";
import { createRouter, useRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { ApiError } from "./lib/metagraphed/client";
import { ErrorState, Skeleton } from "./components/metagraphed/states";

// Outlet-scoped default boundary: a loader error in any route that doesn't
// define its own errorComponent renders here, INSIDE the root shell, instead of
// bubbling to __root's full-page errorComponent and replacing the chrome.
// Retry invalidates the route so a transient failure can re-run the loader.
function DefaultRouteError({ error, reset }: { error: unknown; reset: () => void }) {
  const router = useRouter();
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
function DefaultRoutePending() {
  return (
    <div className="mx-auto max-w-3xl space-y-3 px-4 py-10" role="status" aria-busy="true">
      <Skeleton className="h-6 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          // Preserve TanStack Query's server-side no-retry default so SSR
          // requests cannot amplify failing upstream API calls.
          if (typeof window === "undefined") {
            return false;
          }

          // #370: `artifact_not_found` is a definitive "not published here"
          // (e.g. a native-only testnet partition) — don't burn 3 retries
          // before the NativeOnlyNotice degradation renders.
          if (error instanceof ApiError && error.code === "artifact_not_found") {
            return false;
          }
          return failureCount < 3;
        },
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: DefaultRouteError,
    defaultPendingComponent: DefaultRoutePending,
  });

  return router;
};
