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
    url: "/api/v1/subnets/1/events",
  });
}

function runQuery(netuid: number, kind?: string) {
  const opts = subnetEventsQuery(netuid, kind);
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

  it("fetches the events route with only the fixed limit when no kind is given", async () => {
    resolveWith({
      event_count: 2,
      events: [
        { block_number: 10, event_index: 0, event_kind: "StakeAdded" },
        { block_number: 9, event_index: 1, event_kind: "WeightsSet" },
      ],
    });
    const res = await runQuery(64);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/64/events",
      expect.objectContaining({ params: { limit: 100 }, signal: expect.anything() }),
    );
    expect(res.data.netuid).toBe(64);
    expect(res.data.event_count).toBe(2);
    expect(res.data.events).toHaveLength(2);
  });

  it("forwards the kind param and keys the cache on it", async () => {
    resolveWith({ events: [] });
    const opts = subnetEventsQuery(64, "StakeAdded");
    // kind is part of the query key so a filtered feed caches separately.
    expect(opts.queryKey).toContain("StakeAdded");
    await runQuery(64, "StakeAdded");
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/64/events",
      expect.objectContaining({ params: { limit: 100, kind: "StakeAdded" } }),
    );
  });

  it("degrades a cold subnet to an empty feed (never throws)", async () => {
    for (const raw of [{}, null, { events: "not-an-array" }]) {
      resolveWith(raw);
      const res = await runQuery(1);
      expect(res.data.netuid).toBe(1);
      expect(res.data.events).toEqual([]);
      expect(res.data.event_count).toBe(0);
    }
  });
});
