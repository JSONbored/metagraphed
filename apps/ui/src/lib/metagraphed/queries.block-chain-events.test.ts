import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { blockChainEventsQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/blocks/5000000/chain-events",
  });
}

async function runQuery(ref: string) {
  const opts = blockChainEventsQuery(ref);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("blockChainEventsQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("fetches the per-block chain-events route with no query params", async () => {
    resolveWith({ block_number: 5000000, count: 0, events: [] });
    await runQuery("5000000");
    expect(mockedApiFetch).toHaveBeenCalledWith("/api/v1/blocks/5000000/chain-events", {
      signal: expect.any(AbortSignal),
    });
  });

  it("normalizes a well-formed decoded event, converting epoch-ms observed_at to ISO", async () => {
    resolveWith({
      block_number: 5000000,
      count: 1,
      events: [
        {
          block_number: 5000000,
          event_index: 1,
          pallet: "SubtensorModule",
          method: "NeuronRegistered",
          args: { netuid: 43, uid: 12 },
          phase: "ApplyExtrinsic",
          extrinsic_index: 2,
          observed_at: 1735689600000,
        },
      ],
    });
    const res = await runQuery("5000000");
    expect(res.data.block_number).toBe(5000000);
    expect(res.data.count).toBe(1);
    expect(res.data.events).toHaveLength(1);
    expect(res.data.events[0]).toMatchObject({
      pallet: "SubtensorModule",
      method: "NeuronRegistered",
      args: { netuid: 43, uid: 12 },
      phase: "ApplyExtrinsic",
      extrinsic_index: 2,
      observed_at: new Date(1735689600000).toISOString(),
    });
  });

  it("coerces the Postgres tier's string-serialized bigints and backfills the per-row block_number", async () => {
    // Real production shape: the per-block route's rows omit block_number
    // (redundant — every row is the same block) and serialize event_index /
    // observed_at as JSON strings (bigint columns), unlike the D1-backed
    // events/extrinsics routes which return plain numbers and ISO strings.
    resolveWith({
      block_number: 8559857,
      count: 1,
      events: [
        {
          event_index: "323",
          pallet: "System",
          method: "ExtrinsicSuccess",
          args: { class: "Normal" },
          phase: "ApplyExtrinsic",
          extrinsic_index: 17,
          observed_at: "1783313892001",
        },
      ],
    });
    const res = await runQuery("8559857");
    expect(res.data.events[0]).toMatchObject({
      block_number: 8559857,
      event_index: 323,
      observed_at: new Date(1783313892001).toISOString(),
    });
  });

  it("degrades a cold / junk store to a schema-stable empty page", async () => {
    for (const raw of [{}, null, "x", { events: "nope" }]) {
      resolveWith(raw);
      const res = await runQuery("5000000");
      expect(res.data.count).toBe(0);
      expect(res.data.events).toEqual([]);
    }
  });

  it("drops malformed event rows", async () => {
    resolveWith({ events: [null, "x", 42, { pallet: "Balances", method: "Transfer" }] });
    const res = await runQuery("5000000");
    expect(res.data.events).toHaveLength(1);
    expect(res.data.events[0]?.pallet).toBe("Balances");
  });
});
