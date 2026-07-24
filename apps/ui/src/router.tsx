import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { routeTree } from "./routeTree.gen";
import { ApiError } from "./lib/metagraphed/client";
import { DefaultRouteError, DefaultRoutePending } from "./router-fallbacks";

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
          // #2564: `data_tier_unavailable` means the DATA_API service binding
          // isn't wired into this deployment — retrying won't change that
          // within a session, so don't burn 3 retries with backoff before the
          // DataTierUnavailableNotice degradation renders.
          if (error instanceof ApiError && error.code === "data_tier_unavailable") {
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

  // Bridges the router's SSR streaming with React Query: without this, the
  // server's QueryClient and the client's QueryClient never share state, so
  // useSuspenseQuery re-suspends on an empty client cache during hydration
  // and the whole boundary gets stuck dehydrated forever (#4967).
  // wrapQueryClient: false because __root.tsx already renders its own
  // <QueryClientProvider client={queryClient}>.
  setupRouterSsrQueryIntegration({ router, queryClient, wrapQueryClient: false });

  return router;
};
