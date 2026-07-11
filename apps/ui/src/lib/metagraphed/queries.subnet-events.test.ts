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

  it("requests limit=100 with no kind when unfiltered", async () => {
    resolveWith({ events: [] });
    await runQuery(7);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/events",
      expect.objectContaining({ params: { limit: 100, kind: undefined } }),
    );
  });

  it("forwards the kind param and separates it in the query key", async () => {
    expect(subnetEventsQuery(7, { kind: "StakeAdded" }).queryKey).toContain("StakeAdded");
    expect(subnetEventsQuery(7).queryKey).not.toContain("StakeAdded");

    resolveWith({ events: [] });
    await runQuery(7, { kind: "StakeAdded" });
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/events",
      expect.objectContaining({ params: { limit: 100, kind: "StakeAdded" } }),
    );
  });

  it("normalizes well-formed events and preserves the server event_count", async () => {
    resolveWith({
      event_count: 2,
      events: [
        { block_number: 100, event_index: 0, event_kind: "StakeAdded", amount_tao: 1.5 },
        { block_number: 101, event_index: 1, event_kind: "WeightsSet" },
      ],
    });
    const res = await runQuery(7, { kind: "StakeAdded" });
    expect(res.data.netuid).toBe(7);
    expect(res.data.event_count).toBe(2);
    expect(res.data.events).toHaveLength(2);
    expect(res.data.events[0]?.event_kind).toBe("StakeAdded");
  });

  it("drops malformed rows and falls back event_count to the kept length", async () => {
    resolveWith({
      events: [
        { block_number: 100, event_index: 0, event_kind: "StakeAdded" },
        { block_number: null, event_kind: "WeightsSet" },
        "nope",
      ],
    });
    const res = await runQuery(7);
    expect(res.data.events).toHaveLength(1);
    expect(res.data.event_count).toBe(1);
  });

  it("degrades a cold / junk store to a schema-stable empty feed", async () => {
    for (const raw of [{}, null, "x", { events: "nope" }]) {
      resolveWith(raw);
      const res = await runQuery(7);
      expect(res.data.netuid).toBe(7);
      expect(res.data.events).toEqual([]);
      expect(res.data.event_count).toBe(0);
    }
  });
});
