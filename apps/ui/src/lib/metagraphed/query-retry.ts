import { ApiError } from "./client";

/** Keep failed requests bounded without replaying requests the server rejected. */
export function shouldRetryApiQuery(failureCount: number, error: unknown): boolean {
  // TanStack Query does not retry during SSR. Preserve that behavior explicitly.
  if (typeof window === "undefined") return false;
  if (error instanceof Error && error.name === "AbortError") return false;
  if (error instanceof ApiError) {
    if (error.code === "artifact_not_found" || error.code === "data_tier_unavailable") return false;
    // Reconnect already refetches offline queries. Retrying a rejected request,
    // especially 429 within its rate-limit window, only spends more quota.
    if (error.status === 0 || (error.status >= 400 && error.status < 500)) return false;
  }
  return failureCount < 3;
}
