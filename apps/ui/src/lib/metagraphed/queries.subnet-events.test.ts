import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { subnetEventsQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/subnets/7/events",
  });
}

async function runQuery(netuid: number, params?: { kind?: string }) {
  const opts = subnetEventsQuery(netuid, params);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("subnetEventsQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("fetches the unfiltered feed with limit=100 by default", async () => {
    resolveWith({ netuid: 7, events: [] });
    await runQuery(7);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/events",
      expect.objectContaining({ params: { limit: 100 } }),
    );
  });

  it("forwards an optional kind filter to the API", async () => {
    resolveWith({ netuid: 7, events: [] });
    await runQuery(7, { kind: "StakeAdded" });
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/events",
      expect.objectContaining({ params: { limit: 100, kind: "StakeAdded" } }),
    );
  });

  it("includes kind in the query key when set", () => {
    expect(subnetEventsQuery(7, { kind: "Transfer" }).queryKey).toContain("Transfer");
    expect(subnetEventsQuery(7).queryKey).not.toContain("Transfer");
  });
});
