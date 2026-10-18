import { afterEach, describe, expect, it, vi } from "vitest";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
const { fetchApi } = vi.hoisted(() => ({ fetchApi: vi.fn() }));
vi.mock("./client", async (original) => ({
  ...(await original<typeof import("./client")>()),
  apiFetch: fetchApi,
}));
import { ApiError } from "./client";
import { endpointsInfiniteQuery, surfacesInfiniteQuery } from "./catalog-queries";
import { CatalogRestartRequired, collectCatalogRows, restartCatalogResults } from "./catalog-pages";

const snapshot = "v1." + "a".repeat(64);
function response(ids: string[], cursor: number, total: number, key = "endpoints") {
  return {
    data: { [key]: ids.map((id) => ({ id })) },
    meta: {
      pagination: {
        snapshot,
        cursor,
        total,
        returned: ids.length,
        next_cursor: cursor + ids.length < total ? cursor + ids.length : null,
      },
    },
    url: "https://api.metagraph.sh/api/v1/endpoints",
  };
}
afterEach(() => fetchApi.mockReset());

describe("first-party checked catalog consumers", () => {
  it("endpoint query carries the returned snapshot and preserves filters", async () => {
    fetchApi.mockResolvedValueOnce(response(["a", "b"], 0, 4));
    fetchApi.mockResolvedValueOnce(response(["c", "d"], 2, 4));
    const client = new QueryClient();
    const options = endpointsInfiniteQuery({ kind: "rpc", fields: "id", limit: 2 });
    await client.fetchInfiniteQuery(options);
    const observer = new InfiniteQueryObserver(client, options);
    const stop = observer.subscribe(() => {});
    await observer.fetchNextPage();
    expect(fetchApi.mock.calls[0][1].params).toMatchObject({
      kind: "rpc",
      fields: "id",
      cursor: 0,
      page_snapshot: "start",
    });
    expect(fetchApi.mock.calls[1][1].params).toMatchObject({
      kind: "rpc",
      fields: "id",
      cursor: 2,
      page_snapshot: snapshot,
    });
    expect(observer.getCurrentResult().data?.pages.flatMap((p) => p.data.map((r) => r.id))).toEqual(
      ["a", "b", "c", "d"],
    );
    stop();
    client.clear();
  });

  it("a manual restart cancels a late page and replaces old rows with one fresh first page", async () => {
    fetchApi.mockResolvedValueOnce(response(["a", "b"], 0, 4));
    const client = new QueryClient();
    const options = endpointsInfiniteQuery({ kind: "rpc", limit: 2 });
    await client.fetchInfiniteQuery(options);
    const observer = new InfiniteQueryObserver(client, options);
    const stop = observer.subscribe(() => {});
    let finish!: (value: ReturnType<typeof response>) => void;
    fetchApi.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const late = observer.fetchNextPage().catch(() => undefined);
    const lateSignal = fetchApi.mock.calls[1][1].signal as AbortSignal;
    fetchApi.mockResolvedValueOnce(response(["new"], 0, 1));
    await restartCatalogResults(client, options);
    expect(lateSignal.aborted).toBe(true);
    finish(response(["c", "d"], 2, 4));
    await late;
    expect(fetchApi).toHaveBeenCalledTimes(3);
    expect(fetchApi.mock.calls[2][1].params).toMatchObject({
      kind: "rpc",
      cursor: 0,
      page_snapshot: "start",
    });
    expect(observer.getCurrentResult().data?.pages.flatMap((p) => p.data.map((r) => r.id))).toEqual(
      ["new"],
    );
    stop();
    client.clear();
  });

  it("surfaces use the same guarded protocol; stale continuation is not automatically retried", async () => {
    fetchApi.mockResolvedValueOnce(response(["a"], 0, 2, "surfaces"));
    const client = new QueryClient();
    const options = surfacesInfiniteQuery({ provider: "fixture", limit: 1 });
    await client.fetchInfiniteQuery(options);
    fetchApi.mockRejectedValueOnce(
      new ApiError("Changed", {
        status: 400,
        code: "invalid_query",
        parameter: "page_snapshot",
        url: "fixture",
      }),
    );
    const observer = new InfiniteQueryObserver(client, options);
    const stop = observer.subscribe(() => {});
    await observer.fetchNextPage();
    expect(observer.getCurrentResult().error).toBeInstanceOf(CatalogRestartRequired);
    expect(fetchApi).toHaveBeenCalledTimes(2);
    stop();
    client.clear();
  });

  it("CSV collection emits only a complete checked walk and discards a changed attempt", async () => {
    fetchApi.mockResolvedValueOnce(response(["a", "b"], 0, 4));
    fetchApi.mockRejectedValueOnce(
      new ApiError("Changed", {
        status: 400,
        code: "invalid_query",
        parameter: "page_snapshot",
        url: "fixture",
      }),
    );
    await expect(
      collectCatalogRows("/api/v1/endpoints", "endpoints", { kind: "rpc" }),
    ).rejects.toBeInstanceOf(CatalogRestartRequired);
    expect(fetchApi).toHaveBeenCalledTimes(2);
    fetchApi.mockResolvedValueOnce(response(["new"], 0, 1));
    await expect(
      collectCatalogRows("/api/v1/endpoints", "endpoints", { kind: "rpc" }),
    ).resolves.toEqual([{ id: "new" }]);
    expect(fetchApi.mock.calls[2][1].params).toMatchObject({
      kind: "rpc",
      cursor: 0,
      page_snapshot: "start",
    });
  });

  it("rejects a continuation that keeps the snapshot but lowers the first total", async () => {
    fetchApi.mockResolvedValueOnce(response(["a", "b"], 0, 4));
    fetchApi.mockResolvedValueOnce(response(["c"], 2, 3));
    await expect(collectCatalogRows("/api/v1/endpoints", "endpoints", {})).rejects.toBeInstanceOf(
      CatalogRestartRequired,
      catalogRetentionNotice,
    );
    expect(fetchApi).toHaveBeenCalledTimes(2);
  });

  it("discards a late export page after cancellation without fetching another page", async () => {
    const controller = new AbortController();
    let finish!: (value: ReturnType<typeof response>) => void;
    fetchApi.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const result = collectCatalogRows("/api/v1/endpoints", "endpoints", {}, controller.signal);
    expect(fetchApi.mock.calls[0][1].signal).toBe(controller.signal);
    controller.abort();
    finish(response(["old"], 0, 2));
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });
});

it("failed restart retains all accepted pages and parameters without retry; success replaces once", async () => {
  fetchApi.mockResolvedValueOnce(response(["a", "b"], 0, 4));
  fetchApi.mockResolvedValueOnce(response(["c", "d"], 2, 4));
  const client = new QueryClient();
  const options = endpointsInfiniteQuery({ kind: "rpc", limit: 2 });
  await client.fetchInfiniteQuery(options);
  const observer = new InfiniteQueryObserver(client, options);
  const stop = observer.subscribe(() => {});
  await observer.fetchNextPage();
  const accepted = observer.getCurrentResult().data;
  fetchApi.mockRejectedValueOnce(new Error("restart failed"));
  expect(await restartCatalogResults(client, options)).toBe(false);
  expect(fetchApi).toHaveBeenCalledTimes(3);
  expect(observer.getCurrentResult().data).toBe(accepted);
  expect(observer.getCurrentResult().error?.message).toBe("restart failed");
  fetchApi.mockResolvedValueOnce({
    ...response(["fresh"], 0, 1),
    meta: {
      pagination: {
        ...response(["fresh"], 0, 1).meta.pagination,
        snapshot: "v1." + "b".repeat(64),
      },
    },
  });
  expect(await restartCatalogResults(client, options)).toBe(true);
  expect(fetchApi).toHaveBeenCalledTimes(4);
  expect(fetchApi.mock.calls.slice(2).map((call) => call[1].params)).toEqual([
    expect.objectContaining({ cursor: 0, page_snapshot: "start", kind: "rpc" }),
    expect.objectContaining({ cursor: 0, page_snapshot: "start", kind: "rpc" }),
  ]);
  expect(observer.getCurrentResult().data?.pages.flatMap((p) => p.data.map((r) => r.id))).toEqual([
    "fresh",
  ]);
  expect(observer.getCurrentResult().data?.pageParams).toEqual([{ cursor: 0, snapshot: "start" }]);
  stop();
  client.clear();
});

it("keeps actionable over-budget errors instead of encouraging identical restarts", async () => {
  const error = new ApiError("Narrow filters", {
    status: 400,
    code: "invalid_query",
    parameter: "page_snapshot",
    catalogReason: "catalog_budget_exceeded",
    url: "fixture",
  });
  fetchApi.mockRejectedValueOnce(error);
  await expect(collectCatalogRows("/api/v1/endpoints", "endpoints", {})).rejects.toBe(error);
  expect(fetchApi).toHaveBeenCalledTimes(1);
});

it("labels retained results during failed or pending replacement while preserving accepted counts", () => {
  const state = { isFetching: false, isFetchingNextPage: false, isError: false };
  expect(catalogRetentionNotice(state, 2, "2 of 3")).toBeUndefined();
  expect(catalogRetentionNotice({ ...state, isError: true }, 0)).toBeUndefined();
  expect(catalogRetentionNotice({ ...state, isError: true }, 2, "2 of 3")).toBe(
    "2 of 3 · Previously accepted rows retained · current freshness unverified",
  );
  expect(catalogRetentionNotice({ ...state, isFetching: true }, 2, "2 of 3")).toMatch(
    /^2 of 3 · Refreshing results/,
  );
  expect(
    catalogRetentionNotice({ ...state, isFetching: true, isFetchingNextPage: true }, 2),
  ).toBeUndefined();
});
