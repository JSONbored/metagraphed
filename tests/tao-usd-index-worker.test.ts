// Tests for the TAO/USD ingestion tick on the data Worker (#8600).
//
// Kept out of tests/data-api.test.ts on purpose: that file's mocks carry a
// large shared result queue tuned to its own routes, and a cron path that
// must observe an EMPTY `RETURNING` (the ON CONFLICT no-op) would have to
// fight it. This file fakes the user-state D1 binding (tao_usd_index's home
// since the accounts-d1 port) and fetch narrowly instead, so what each test
// asserts about the tick is not entangled with a route it never calls.
//
// The batch fixture is the same real capture the aggregator tests use —
// Ethereum mainnet block 25,650,836, 2026-07-31.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Row } from "./row-type.ts";

const sqlCalls: { text: string; values: unknown[] }[] = [];
/** What the next `RETURNING` yields. Empty models the ON CONFLICT no-op. */
const returning = { current: [{ block_number: 1 }] as Row[] };
const writeFailure = { error: null as Error | null };

// The runner's whole D1 surface: prepare(text).bind(...).all().
const fakeD1 = {
  prepare(text: string) {
    return {
      bind(...values: unknown[]) {
        return {
          async all() {
            sqlCalls.push({ text, values });
            if (writeFailure.error) throw writeFailure.error;
            return { results: returning.current };
          },
        };
      },
    };
  },
};

const {
  decodeBlockHeader,
  ingestTaoUsdIndex,
  writeTaoUsdIndexRow,
  default: worker,
} = await import("../workers/data-api.ts");
const { TAO_USD_INDEX_CRON } = await import("../workers/config.ts");
const { rowFromBatch } = await import("../src/tao-usd-ingest.ts");

const ETH_RPC_URL = "https://eth-rpc.example/test";
const env = {
  METAGRAPH_HEALTH_DB: fakeD1,
  ETH_RPC_URL,
} as unknown as Parameters<typeof ingestTaoUsdIndex>[0];
const ctx = { waitUntil() {} } as unknown as ExecutionContext;

const LIVE_HEADER = { number: "0x1876694", timestamp: "0x6a6c36af" };
const LIVE_BATCH = [
  {
    jsonrpc: "2.0",
    id: 0,
    result:
      "0x000000000000000000000000000000000000599837c9d8bdfbdbc116a36146e60000000000000000000000000000000000000000000000000000000000031073000000000000000000000000000000000000000000000000000000000000023000000000000000000000000000000000000000000000000000000000000002d300000000000000000000000000000000000000000000000000000000000002d300000000000000000000000000000000000000000000000000000000000000440000000000000000000000000000000000000000000000000000000000000001",
  },
  {
    jsonrpc: "2.0",
    id: 1,
    result:
      "0x000000000000000000000000000000000000279de80f0b82f03e7bee2f0fc034000000000000000000000000000000000000000000000000000000000002d0b10000000000000000000000000000000000000000000000000000000000000037000000000000000000000000000000000000000000000000000000000000003c000000000000000000000000000000000000000000000000000000000000003c00000000000000000000000000000000000000000000000000000000000000660000000000000000000000000000000000000000000000000000000000000001",
  },
  {
    jsonrpc: "2.0",
    id: 2,
    result:
      "0x000000000000000000000000000000000000000000000000000006abe01f11b4",
  },
  {
    jsonrpc: "2.0",
    id: 3,
    result:
      "0x000000000000000000000000000000000000000000000012ec16ce3057dd3239",
  },
  {
    jsonrpc: "2.0",
    id: 4,
    result:
      "0x00000000000000000000000000000000000027a9a2652abcf572ad1d4fb89843000000000000000000000000000000000000000000000000000000000002d0c800000000000000000000000000000000000000000000000000000000000000520000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000660000000000000000000000000000000000000000000000000000000000000001",
  },
  {
    jsonrpc: "2.0",
    id: 5,
    result:
      "0x00000000000000000000000000000000000000000000000000000100484d6a46",
  },
  {
    jsonrpc: "2.0",
    id: 6,
    result:
      "0x0000000000000000000000000000000000000000000000025090174b3b0aa7c1",
  },
];

/** Answers the header call first, then the batch — the tick's real order. */
function stubRpc(
  responses: unknown[],
  options: { status?: number; throwOn?: number } = {},
) {
  let call = 0;
  const requests: unknown[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const index = call;
    call += 1;
    if (options.throwOn === index) throw new Error("network down");
    return {
      ok: options.status === undefined ? true : options.status < 400,
      status: options.status ?? 200,
      json: async () => responses[index],
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requests };
}

beforeEach(() => {
  sqlCalls.length = 0;
  returning.current = [{ block_number: 1 }];
  writeFailure.error = null;
  vi.unstubAllGlobals();
});

describe("decodeBlockHeader", () => {
  it("reads a real header", () => {
    expect(decodeBlockHeader({ result: LIVE_HEADER })).toEqual({
      blockTag: "0x1876694",
      blockNumber: 25_650_836,
      timestampSeconds: 1_785_476_783,
    });
  });

  it("returns null for anything that is not a header", () => {
    for (const bad of [
      null,
      undefined,
      {},
      { result: null },
      { result: {} },
      { result: { number: 1, timestamp: "0x1" } },
      { result: { number: "0x1", timestamp: 2 } },
      { result: { number: "zz", timestamp: "0x1" } },
      { result: { number: "0x1", timestamp: "zz" } },
    ]) {
      expect(decodeBlockHeader(bad)).toBeNull();
    }
  });

  it("parses without judging usability", () => {
    // "0x0" is a legal hex string and an unusable height. It gets past here
    // and is refused once, downstream, where every other unusable observation
    // is refused.
    expect(
      decodeBlockHeader({ result: { number: "0x0", timestamp: "0x0" } }),
    ).not.toBeNull();
  });
});

describe("writeTaoUsdIndexRow", () => {
  const row = rowFromBatch({
    blockNumber: 25_650_836,
    blockTimestampSeconds: 1_785_476_783,
    response: LIVE_BATCH,
  })!;

  it("writes the provenance as JSON text into the pools column", () => {
    // The D1 schema's `pools` is TEXT holding JSON -- the writer stringifies,
    // and the bound value must be the parseable JSON text itself.
    return writeTaoUsdIndexRow(env, row).then(() => {
      expect(sqlCalls).toHaveLength(1);
      expect(sqlCalls[0].text).toContain("INSERT INTO tao_usd_index");
      expect(sqlCalls[0].text).toContain(
        "ON CONFLICT (block_number, observed_at) DO NOTHING",
      );
      const pools = JSON.parse(String(sqlCalls[0].values[6]));
      expect(pools).toHaveLength(2);
      expect(pools[0].included).toBe(true);
    });
  });

  it("reports a re-run of the same height as not inserted", async () => {
    // ON CONFLICT DO NOTHING returns zero rows. That is a success — the height
    // is already recorded — and the flag has to say so rather than read as a
    // failed write.
    returning.current = [];
    await expect(writeTaoUsdIndexRow(env, row)).resolves.toEqual({
      inserted: false,
    });
  });

  it("reports a first write as inserted", async () => {
    await expect(writeTaoUsdIndexRow(env, row)).resolves.toEqual({
      inserted: true,
    });
  });
});

describe("the ingestion tick", () => {
  it("is a recorded no-op with no endpoint configured", async () => {
    // Unset must not silently fall back to somebody's public node: which
    // endpoint we accept terms with is an ops decision.
    const { fetchMock } = stubRpc([]);
    await expect(
      ingestTaoUsdIndex({
        METAGRAPH_HEALTH_DB: fakeD1,
      } as unknown as typeof env),
    ).resolves.toEqual({
      ok: false,
      skipped: true,
      reason: "ETH_RPC_URL not configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins the batch to the height it just read", async () => {
    const { fetchMock, requests } = stubRpc([
      { result: LIVE_HEADER },
      LIVE_BATCH,
    ]);
    const result = await ingestTaoUsdIndex(env);
    expect(result).toMatchObject({
      ok: true,
      inserted: true,
      block_number: 25_650_836,
      price_basis: "wrapped_onchain_median",
      pool_count: 2,
    });
    expect(result.usd_per_tao).toBeCloseTo(195.52, 2);

    // Two requests per tick, and every call in the second one carries the
    // height from the first — seven `latest` calls would straddle blocks.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const batchBody = requests[1] as { params: [unknown, string] }[];
    expect(batchBody).toHaveLength(7);
    for (const entry of batchBody) {
      expect(entry.params[1]).toBe("0x1876694");
    }
  });

  it("stores the row against the block's own timestamp", async () => {
    stubRpc([{ result: LIVE_HEADER }, LIVE_BATCH]);
    await ingestTaoUsdIndex(env);
    const insert = sqlCalls.find((c) =>
      c.text.includes("INSERT INTO tao_usd_index"),
    )!;
    expect(insert.values[0]).toBe(25_650_836);
    expect(insert.values[1]).toBe(1_785_476_783_000);
  });

  it("reports a re-ingested height without failing", async () => {
    returning.current = [];
    stubRpc([{ result: LIVE_HEADER }, LIVE_BATCH]);
    await expect(ingestTaoUsdIndex(env)).resolves.toMatchObject({
      ok: true,
      inserted: false,
    });
  });

  it("still writes a null-with-reason row when pools do not read", async () => {
    // Requirement 4(a): one failing read costs its own pool, not the run. A
    // recorded refusal is more useful than a gap in the series.
    const noPools = LIVE_BATCH.filter((entry) => entry.id === 0);
    stubRpc([{ result: LIVE_HEADER }, noPools]);
    const result = await ingestTaoUsdIndex(env);
    expect(result).toMatchObject({
      ok: true,
      price_basis: "insufficient_pools",
      usd_per_tao: null,
      pool_count: 0,
    });
    const insert = sqlCalls.find((c) =>
      c.text.includes("INSERT INTO tao_usd_index"),
    )!;
    const pools = JSON.parse(String(insert.values[6]));
    expect(pools).toHaveLength(2);
    expect(pools.every((p: Row) => p.included === false)).toBe(true);
  });

  it("refuses an unreadable header rather than keying a row on now", async () => {
    stubRpc([{ result: null }, LIVE_BATCH]);
    await expect(ingestTaoUsdIndex(env)).resolves.toEqual({
      ok: false,
      reason: "block_header_unreadable",
    });
    expect(sqlCalls).toHaveLength(0);
  });

  it("refuses a header that parses but cannot be used", async () => {
    stubRpc([{ result: { number: "0x0", timestamp: "0x0" } }, LIVE_BATCH]);
    await expect(ingestTaoUsdIndex(env)).resolves.toEqual({
      ok: false,
      reason: "observation_unusable",
    });
    expect(sqlCalls).toHaveLength(0);
  });

  it("survives a transport failure as one missing minute", async () => {
    stubRpc([], { throwOn: 0 });
    await expect(ingestTaoUsdIndex(env)).resolves.toEqual({
      ok: false,
      reason: "tick_failed",
    });
  });

  it("treats a non-2xx from the endpoint as a failed tick", async () => {
    stubRpc([{ result: LIVE_HEADER }], { status: 429 });
    await expect(ingestTaoUsdIndex(env)).resolves.toEqual({
      ok: false,
      reason: "tick_failed",
    });
  });

  it("survives the write itself failing", async () => {
    writeFailure.error = new Error("hyperdrive gone");
    stubRpc([{ result: LIVE_HEADER }, LIVE_BATCH]);
    await expect(ingestTaoUsdIndex(env)).resolves.toEqual({
      ok: false,
      reason: "tick_failed",
    });
  });
});

describe("the cron entrypoint", () => {
  it("runs the tick on its own schedule", async () => {
    stubRpc([{ result: LIVE_HEADER }, LIVE_BATCH]);
    const result = await worker.scheduled(
      { cron: TAO_USD_INDEX_CRON } as ScheduledController,
      env as never,
      ctx,
    );
    expect(result).toMatchObject({ ok: true, block_number: 25_650_836 });
  });

  it("ignores a schedule it does not own", async () => {
    const { fetchMock } = stubRpc([]);
    await expect(
      worker.scheduled(
        { cron: "0 * * * *" } as ScheduledController,
        env as never,
        ctx,
      ),
    ).resolves.toEqual({ ok: false, skipped: true, reason: "unknown cron" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
