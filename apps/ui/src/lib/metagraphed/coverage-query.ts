import { queryOptions } from "@tanstack/react-query";
import { apiFetch, type ApiResult } from "./client";
import { getNetwork } from "./config";
import type { Coverage } from "./types";

/**
 * Lightweight coverage query for global/error-boundary UI. Page-level coverage
 * views keep their richer normalizer in queries.ts; this avoids pulling every
 * route query and normalizer into the shared application graph.
 */
export const lightweightCoverageQuery = () =>
  queryOptions({
    queryKey: ["metagraphed", { network: getNetwork().id }, "coverage"],
    queryFn: async ({ signal }) => {
      const res = await apiFetch<Coverage>("/api/v1/coverage", { signal });
      return { ...res, data: res.data ?? {} } as ApiResult<Coverage>;
    },
    staleTime: 60_000,
  });
