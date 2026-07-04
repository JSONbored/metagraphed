import { describe, it, expect } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import { QueryErrorBoundary } from "./error-boundary";

// Regression for the 2026-06 gap audit: QueryErrorBoundary.reset() used to call
// invalidateQueries({ type: "active" }). While the error fallback is shown the
// failed query is unmounted, so it is NOT "active" — the invalidate no-ops, the
// errored cache entry survives, and retry re-renders the same error → the
// boundary re-trips forever. reset() now calls resetQueries(), which clears the
// errored state so the remounted query refetches from scratch.
//
// These tests drive the real boundary's static/instance methods against a real
// QueryClient (no DOM needed): a query that fails once then succeeds must, after
// reset(), settle on the success value rather than re-tripping the boundary.

function makeFailOnceThenSucceed() {
  let calls = 0;
  const queryFn = () => {
    calls += 1;
    if (calls === 1) return Promise.reject(new Error("transient-failure"));
    return Promise.resolve("recovered");
  };
  return { queryFn, getCalls: () => calls };
}

describe("QueryErrorBoundary.reset", () => {
  it("getDerivedStateFromError captures the thrown error", () => {
    const err = new Error("boom");
    expect(QueryErrorBoundary.getDerivedStateFromError(err)).toEqual({ error: err });
  });

  it("leaves an errored query in error state until reset() is called", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { queryFn } = makeFailOnceThenSucceed();
    await queryClient.fetchQuery({ queryKey: ["surfaces"], queryFn }).catch(() => {});

    const cached = queryClient.getQueryCache().find({ queryKey: ["surfaces"] });
    // The query that fed the boundary is no longer mounted/active, so an
    // invalidate({ type: "active" }) would not touch it — this is the exact
    // condition the old reset() failed to handle.
    expect(cached?.isActive()).toBe(false);
    expect(queryClient.getQueryState(["surfaces"])?.status).toBe("error");
  });

  it("reset() clears the errored state so a refetch reaches the success value", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { queryFn, getCalls } = makeFailOnceThenSucceed();

    // First mount: the query fails and trips the boundary.
    await queryClient.fetchQuery({ queryKey: ["surfaces"], queryFn }).catch(() => {});
    expect(queryClient.getQueryState(["surfaces"])?.status).toBe("error");

    // Build a boundary instance wired to the real client (as contextType does at
    // runtime) and run its reset() — the line under test.
    const boundary = new QueryErrorBoundary({ children: null });
    boundary.context = queryClient;
    let cleared = false;
    boundary.setState = ((partial: { error: unknown }) => {
      if (partial.error === null) cleared = true;
    }) as typeof boundary.setState;

    boundary.reset();
    // reset() flips the error fallback off...
    expect(cleared).toBe(true);
    // ...and clears the errored cache entry (resetQueries), unlike the old
    // active-only invalidate which would have left status === "error".
    await Promise.resolve();
    expect(queryClient.getQueryState(["surfaces"])?.status).not.toBe("error");

    // The remounted query now refetches and reaches the success render value —
    // the boundary does NOT re-trip.
    const observer = new QueryObserver(queryClient, {
      queryKey: ["surfaces"],
      queryFn,
      retry: false,
    });
    const result = await observer.refetch();
    observer.destroy();

    expect(result.status).toBe("success");
    expect(result.data).toBe("recovered");
    expect(getCalls()).toBe(2);
  });
});
