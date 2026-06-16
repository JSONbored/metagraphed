import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { ApiError } from "./lib/metagraphed/client";

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
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
  });

  return router;
};
