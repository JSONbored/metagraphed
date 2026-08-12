// Tests for the TAO/USD ingestion tick on the data Worker (#8600).
//
// Kept out of tests/data-api.test.ts on purpose: that file's mocks carry a
// large shared result queue tuned to its own routes, and a cron path that
// must observe an EMPTY `RETURNING` (the ON CONFLICT no-op) would have to
// fight it. This file mocks the `pg` module (tao_usd_index's store since
// #10179 eliminated D1) and fetch narrowly instead, so what each test asserts
// about the tick is not entangled with a route it never calls.
//
// The batch fixture is the same real capture the aggregator tests use —
// Ethereum mainnet block 25,650,836, 2026-07-31.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";
import type { Row } from "./row-type.ts";

// The store is Postgres now, reached through `new Client(...)` inside
// createPgSql -- which writeTaoUsdIndexRow builds itself from the Hyperdrive
// binding, so there is nothing for a caller to inject. Mocking the module is
// the seam; see tests/helpers/pg-mock.ts for why the controller has to be
// built inside vi.hoisted (vi.mock is hoisted above every import, so a plain
// `const` would be read before initialisation).
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

/** Every statement the tick issued, in order. A live subscription rather than
 * a getter, because the assertions read it after the call has returned. */
const sqlCalls: { text: string; values: unknown[] }[] = [];
pg.control.onQuery = (q) => sqlCalls.push(q);

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
  ...pgMockEnv(),
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
  pg.control.queries.length = 0;
  // What the next `RETURNING` yields. Empty models the ON CONFLICT no-op.
  pg.control.rows = [{ block_number: 1 }];
  pg.control.failNext = null;
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
    // The `pools` column is TEXT holding JSON -- the writer stringifies, and
    // the bound value must be the parseable JSON text itself.
    return writeTaoUsdIndexRow(env, row, ctx).then(() => {
      expect(sqlCalls).toHaveLength(1);
      expect(sqlCalls[0].text).toContain("INSERT INTO tao_usd_index");
      expect(sqlCalls[0].text).toContain(
        "ON CONFLICT (block_number, observed_at) DO NOTHING",
      );
      // `$n`, not `?`: the tagged template numbers its own placeholders, and
      // #9821 is what an unrewritten `?` costs -- six routes served zero rows
      // because Postgres does not recognise it as a placeholder at all.
      expect(sqlCalls[0].text).toMatch(/VALUES \(\s*\$1,/);
      const pools = JSON.parse(String(sqlCalls[0].values[6]));
      expect(pools).toHaveLength(2);
      expect(pools[0].included).toBe(true);
    });
  });

  it("reports the write as issued, not whether the height was new", async () => {
    // #10677: the statement no longer RETURNs, so a re-run and a first write
    // report the SAME thing. That is the point -- consuming the result was
    // what made this the one Neon writer that could not be deferred through
    // the write-behind buffer, and it fires every 60s, which is the cadence
    // most able to keep the compute awake on its own.
    //
    // Nothing real is lost: ON CONFLICT DO NOTHING already makes a repeated
    // height a genuine no-op, and whether heights are landing is measured
    // against the table by src/tao-usd-index-watchdog.ts.
    pg.control.rows = [];
    await expect(writeTaoUsdIndexRow(env, row, ctx)).resolves.toEqual({
      written: true,
    });
    pg.control.rows = null;
    await expect(writeTaoUsdIndexRow(env, row, ctx)).resolves.toEqual({
      written: true,
    });
  });

  it("issues the statement with bound parameters and no RETURNING", async () => {
    // The uniform shape every other Neon write lane already has, and the
    // precondition for buffering it: src/neon-write-buffer.ts REFUSES a
    // RETURNING statement rather than hand back an empty result that would
    // read as "already present".
    pg.control.queries.length = 0;
    await writeTaoUsdIndexRow(env, row, ctx);
    const text = pg.control.queries.at(-1)?.text ?? "";
    expect(text).toMatch(/INSERT INTO tao_usd_index/);
    expect(text).toMatch(
      /ON CONFLICT \(block_number, observed_at\) DO NOTHING/,
    );
    expect(text).not.toMatch(/RETURNING/i);
  });

  // The write DECLINES rather than falling back now that Neon is the only
  // store (#10179). Both halves matter and neither is a formality: without
  // Hyperdrive there is nowhere to write, and without a ctx there is nowhere
  // to hand the pooled connection back, so writing anyway would leak one
  // connection per minute-cadence tick.
  it("declines, saying why, when no store is bound", async () => {
    const declined = {
      written: false,
      skipped: true,
      reason: "no store bound",
    };
    await expect(writeTaoUsdIndexRow(env, row)).resolves.toEqual(declined);
    await expect(
      writeTaoUsdIndexRow({ ETH_RPC_URL } as typeof env, row, ctx),
    ).resolves.toEqual(declined);
    expect(sqlCalls).toHaveLength(0);
  });
});

describe("the ingestion tick", () => {
  // The KV mirror had NO test, which is how it shipped `observed_at`
  // as the raw epoch-ms integer while every reader grades that stamp with
  // `Date.parse`. A once-a-minute cache read as permanently `index_stale`, and
  // /economics, /subnets/{netuid}/volume and /chain/alpha-volume served no USD
  // at all -- a dead cache that looked exactly like a healthy decline.
  it("mirrors the reading into KV with an ISO stamp the readers can parse", async () => {
    stubRpc([{ result: LIVE_HEADER }, LIVE_BATCH]);
    const puts: Array<{ key: string; value: string }> = [];
    const kvEnv = {
      ...(env as unknown as Record<string, unknown>),
      METAGRAPH_CONTROL: {
        put: async (key: string, value: string) => {
          puts.push({ key, value });
        },
      },
    } as unknown as typeof env;

    const result = await ingestTaoUsdIndex(kvEnv, ctx);
    expect(result.ok).toBe(true);
    expect(puts).toHaveLength(1);
    expect(puts[0].key).toBe("tao-usd:current");
    const blob = JSON.parse(puts[0].value) as Record<string, unknown>;

    expect(typeof blob.observed_at).toBe("string");
    // The property that actually matters: the stamp survives the round trip
    // through the grader the serving side uses. `Date.parse` of a stringified
    // integer is NaN, and an unparseable stamp is graded stale by design.
    expect(Number.isFinite(Date.parse(String(blob.observed_at)))).toBe(true);
    expect(blob.usd_per_tao).toBe(result.usd_per_tao);
    expect(blob.block_number).toBe(result.block_number);
    expect(blob.price_basis).toBe(result.price_basis);
  });

  it("a KV that refuses leaves the tick reporting its durable write", async () => {
    // Best-effort by design: the series is already durable by this point, and
    // a consumer with no cached reading declines rather than inventing a rate.
    stubRpc([{ result: LIVE_HEADER }, LIVE_BATCH]);
    const kvEnv = {
      ...(env as unknown as Record<string, unknown>),
      METAGRAPH_CONTROL: {
        put: async () => {
          throw new Error("KV unavailable");
        },
      },
    } as unknown as typeof env;
    await expect(ingestTaoUsdIndex(kvEnv, ctx)).resolves.toMatchObject({
      ok: true,
      written: true,
    });
  });

  it("is a recorded no-op with no endpoint configured", async () => {
    // Unset must not silently fall back to somebody's public node: which
    // endpoint we accept terms with is an ops decision.
    const { fetchMock } = stubRpc([]);
    await expect(
      ingestTaoUsdIndex({
        ...pgMockEnv(),
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
    const result = await ingestTaoUsdIndex(env, ctx);
    expect(result).toMatchObject({
      ok: true,
      written: true,
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
    await ingestTaoUsdIndex(env, ctx);
    const insert = sqlCalls.find((c) =>
      c.text.includes("INSERT INTO tao_usd_index"),
    )!;
    expect(insert.values[0]).toBe(25_650_836);
    expect(insert.values[1]).toBe(1_785_476_783_000);
  });

  it("reports a re-ingested height without failing", async () => {
    // Indistinguishable from a first write now, deliberately -- see the
    // "reports the write as issued" case above.
    pg.control.rows = [];
    stubRpc([{ result: LIVE_HEADER }, LIVE_BATCH]);
    await expect(ingestTaoUsdIndex(env, ctx)).resolves.toMatchObject({
      ok: true,
      written: true,
    });
  });

  it("still writes a null-with-reason row when pools do not read", async () => {
    // Requirement 4(a): one failing read costs its own pool, not the run. A
    // recorded refusal is more useful than a gap in the series.
    const noPools = LIVE_BATCH.filter((entry) => entry.id === 0);
    stubRpc([{ result: LIVE_HEADER }, noPools]);
    const result = await ingestTaoUsdIndex(env, ctx);
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
    await expect(ingestTaoUsdIndex(env, ctx)).resolves.toEqual({
      ok: false,
      reason: "block_header_unreadable",
    });
    expect(sqlCalls).toHaveLength(0);
  });

  it("refuses a header that parses but cannot be used", async () => {
    stubRpc([{ result: { number: "0x0", timestamp: "0x0" } }, LIVE_BATCH]);
    await expect(ingestTaoUsdIndex(env, ctx)).resolves.toEqual({
      ok: false,
      reason: "observation_unusable",
    });
    expect(sqlCalls).toHaveLength(0);
  });

  it("survives a transport failure as one missing minute", async () => {
    stubRpc([], { throwOn: 0 });
    await expect(ingestTaoUsdIndex(env, ctx)).resolves.toEqual({
      ok: false,
      reason: "tick_failed",
    });
  });

  it("treats a non-2xx from the endpoint as a failed tick", async () => {
    stubRpc([{ result: LIVE_HEADER }], { status: 429 });
    await expect(ingestTaoUsdIndex(env, ctx)).resolves.toEqual({
      ok: false,
      reason: "tick_failed",
    });
  });

  it("survives the write itself failing", async () => {
    pg.control.failNext = new Error("hyperdrive gone");
    stubRpc([{ result: LIVE_HEADER }, LIVE_BATCH]);
    await expect(ingestTaoUsdIndex(env, ctx)).resolves.toEqual({
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
