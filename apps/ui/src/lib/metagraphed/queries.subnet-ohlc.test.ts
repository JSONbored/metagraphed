import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { normalizeSubnetOhlc, normalizeSubnetOhlcCandle, subnetOhlcQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/subnets/7/ohlc",
  });
}

// Invoke a queryOptions' queryFn directly (the factory returns a fully-typed
// options object; each call site keeps its own precise data type), mirroring
// queries.subnet-registrations.test.ts's own runQuery helper.
function runQuery<
  O extends {
    queryKey: readonly unknown[];
    queryFn?: (context: never) => unknown;
  },
>(opts: O): ReturnType<NonNullable<O["queryFn"]>> {
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as never) as ReturnType<NonNullable<O["queryFn"]>>;
}

const RAW_CANDLE = {
  bucket_start: 1_700_000_000_000,
  bucket_start_iso: "2023-11-14T22:13:20.000Z",
  open: 1.5,
  high: 2,
  low: 1,
  close: 1.8,
  volume_alpha: 100,
  volume_tao: 180,
  event_count: 5,
};

describe("normalizeSubnetOhlcCandle", () => {
  it("passes a well-formed candle through", () => {
    expect(normalizeSubnetOhlcCandle(RAW_CANDLE)).toEqual(RAW_CANDLE);
  });

  it("returns null for a non-object row", () => {
    for (const raw of [null, undefined, 42, "x", []]) {
      expect(normalizeSubnetOhlcCandle(raw)).toBeNull();
    }
  });

  it("returns null when bucket_start is missing or non-finite", () => {
    expect(normalizeSubnetOhlcCandle({ ...RAW_CANDLE, bucket_start: undefined })).toBeNull();
    expect(normalizeSubnetOhlcCandle({ ...RAW_CANDLE, bucket_start: "not-a-number" })).toBeNull();
    expect(normalizeSubnetOhlcCandle({ ...RAW_CANDLE, bucket_start: NaN })).toBeNull();
  });

  it("derives bucket_start_iso from bucket_start when the server omits it", () => {
    const candle = normalizeSubnetOhlcCandle({ bucket_start: 1_700_000_000_000 });
    expect(candle?.bucket_start_iso).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("coerces junk numeric fields to 0 rather than NaN", () => {
    const candle = normalizeSubnetOhlcCandle({
      bucket_start: 1_700_000_000_000,
      open: "not-a-number",
      high: undefined,
      low: null,
      close: {},
      volume_alpha: "nope",
      volume_tao: NaN,
      event_count: "nope",
    });
    expect(candle).toEqual({
      bucket_start: 1_700_000_000_000,
      bucket_start_iso: new Date(1_700_000_000_000).toISOString(),
      open: 0,
      high: 0,
      low: 0,
      close: 0,
      volume_alpha: 0,
      volume_tao: 0,
      event_count: 0,
    });
  });
});

describe("normalizeSubnetOhlc", () => {
  it("passes a well-formed response through", () => {
    const raw = {
      schema_version: 1,
      netuid: 7,
      interval: "1h",
      candles: [RAW_CANDLE],
      root_excluded: false,
    };
    expect(normalizeSubnetOhlc(7, "1h", raw)).toEqual(raw);
  });

  it("degrades cold / junk input to a schema-stable empty series", () => {
    for (const raw of [{}, null, undefined, "not-an-object"]) {
      const data = normalizeSubnetOhlc(7, "1h", raw);
      expect(data.netuid).toBe(7);
      expect(data.schema_version).toBe(1);
      expect(data.interval).toBe("1h");
      expect(data.candles).toEqual([]);
      expect(data.root_excluded).toBe(false);
    }
  });

  it("drops a malformed candle without dropping the rest of the batch", () => {
    const data = normalizeSubnetOhlc(7, "1h", {
      candles: [RAW_CANDLE, { bucket_start: "junk" }, { ...RAW_CANDLE, bucket_start: 2 }],
    });
    expect(data.candles).toHaveLength(2);
  });

  it("normalizes interval to '1h' or '1d', never anything else", () => {
    expect(normalizeSubnetOhlc(7, "1h", { interval: "1d" }).interval).toBe("1d");
    expect(normalizeSubnetOhlc(7, "1h", { interval: "5m" }).interval).toBe("1h");
    expect(normalizeSubnetOhlc(7, "1h", { interval: undefined }).interval).toBe("1h");
  });

  it("always forces root_excluded:true for netuid 0, even if the server omits it", () => {
    const data = normalizeSubnetOhlc(0, "1h", { candles: [RAW_CANDLE] });
    expect(data.root_excluded).toBe(true);
  });

  it("respects an explicit root_excluded:true from the server for a non-root netuid too", () => {
    const data = normalizeSubnetOhlc(7, "1h", { root_excluded: true });
    expect(data.root_excluded).toBe(true);
  });

  it("falls back to the requested netuid/interval when the server omits them", () => {
    const data = normalizeSubnetOhlc(12, "1d", {});
    expect(data.netuid).toBe(12);
  });
});

describe("subnetOhlcQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("hits its route with the interval and days params", async () => {
    resolveWith({ netuid: 7, interval: "1d", candles: [] });
    const res = await runQuery(subnetOhlcQuery(7, { interval: "1d", days: 30 }));
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/ohlc",
      expect.objectContaining({ params: { interval: "1d", days: 30 } }),
    );
    expect(res.data.interval).toBe("1d");
  });

  it("defaults to a 1h interval and no days param when omitted", async () => {
    resolveWith({});
    await runQuery(subnetOhlcQuery(7));
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/ohlc",
      expect.objectContaining({ params: { interval: "1h", days: undefined } }),
    );
  });

  it("normalizes the response through normalizeSubnetOhlc", async () => {
    resolveWith({ candles: [RAW_CANDLE] });
    const res = await runQuery(subnetOhlcQuery(7));
    expect(res.data.candles).toEqual([RAW_CANDLE]);
  });
});
