import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { routeTree } from "./routeTree.gen";
import { shouldRetryApiQuery } from "./lib/metagraphed/query-retry";
import { DefaultRouteError, DefaultRoutePending } from "./router-fallbacks";
import { parseAppSearch } from "./lib/metagraphed/search-params";

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetryApiQuery,
      },
    },
  });

  const router = createRouter({
    routeTree,
    parseSearch: parseAppSearch,
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
