import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  dataApiFetchJson,
  loadBlockChainEvents,
  loadChainEventsFeed,
  loadExtrinsicChainEvents,
  type DataApiMcpContext,
} from "../src/data-api-mcp.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";
import { resetDecodeWatermarkCache } from "../src/decode-watermark.ts";
import type { Row } from "./row-type.ts";

function dataApiCtx({
  fetchImpl,
  rateLimit = null,
}: { fetchImpl?: typeof fetch; rateLimit?: Row | null } = {}) {
  return {
    clientIp: "127.0.0.1",
    env: {
      DATA_API: fetchImpl ? { fetch: fetchImpl } : undefined,
      DATA_RATE_LIMITER: rateLimit,
    },
  } as unknown as DataApiMcpContext;
}

/**
 * The chain-events loaders read the LAKEHOUSE, not DATA_API (#8700) -- the
 * store that binding fronted was destroyed in #9186/#9193. This stubs the R2
 * SQL door and records the SQL, so a filter can be shown to have reached the
 * WHERE clause rather than merely been accepted.
 */
function lakehouseCtx(rows: Row[] = [], rateLimit: Row | null = null) {
  const calls: string[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)).query);
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  resetDecodeWatermarkCache();
  return {
    calls,
    ctx: {
      clientIp: "127.0.0.1",
      env: {
        [R2_SQL_TOKEN_ENV]: "cfut_test",
        DATA_RATE_LIMITER: rateLimit,
      },
    } as unknown as DataApiMcpContext,
  };
}

describe("data-api-mcp", () => {
  test("dataApiFetchJson surfaces tier_unavailable without a binding", async () => {
    await assert.rejects(
      () => dataApiFetchJson(dataApiCtx(), "/api/v1/chain-events/stats"),
      (err: Row) => err.code === "tier_unavailable",
    );
  });

  test("dataApiFetchJson surfaces data_rate_limited when the limiter rejects", async () => {
    await assert.rejects(
      () =>
        dataApiFetchJson(
          dataApiCtx({
            rateLimit: {
              async limit() {
                return { success: false };
              },
            },
            fetchImpl: async () => new Response("{}"),
          }),
          "/api/v1/chain-events/stats",
        ),
      (err: Row) => err.code === "data_rate_limited",
    );
  });

  test("dataApiFetchJson proceeds when the data API limiter allows the request", async () => {
    const ctx = dataApiCtx({
      rateLimit: {
        async limit({ key }: { key: string }) {
          assert.equal(key, "data:127.0.0.1");
          return { success: true };
        },
      },
      fetchImpl: async () => Response.json({ ok: true }),
    });
    const out = (await dataApiFetchJson(
      ctx,
      "/api/v1/chain-events/stats",
    )) as Row;
    assert.equal(out.ok, true);
  });

  test("dataApiFetchJson surfaces tier_unavailable when fetch throws", async () => {
    await assert.rejects(
      () =>
        dataApiFetchJson(
          dataApiCtx({
            fetchImpl: async () => {
              throw new Error("network down");
            },
          }),
          "/api/v1/chain-events/stats",
        ),
      (err: Row) => err.code === "tier_unavailable",
    );
  });

  test("dataApiFetchJson maps upstream 400 to invalid_params", async () => {
    const ctx = dataApiCtx({
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "bad filter" }), { status: 400 }),
    });
    await assert.rejects(
      () => dataApiFetchJson(ctx, "/api/v1/chain-events?method=x"),
      (err: Row) =>
        err.code === "invalid_params" && /bad filter/.test(err.message),
    );
  });

  test("dataApiFetchJson preserves nested error.message on upstream 400", async () => {
    const ctx = dataApiCtx({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: {
              message:
                "method filter requires pallet unless block is specified",
            },
          }),
          { status: 400 },
        ),
    });
    await assert.rejects(
      () => dataApiFetchJson(ctx, "/api/v1/chain-events?method=x"),
      (err: Row) =>
        err.code === "invalid_params" &&
        /method filter requires pallet/.test(err.message),
    );
  });

  test("dataApiFetchJson preserves a top-level message envelope on upstream 400", async () => {
    const ctx = dataApiCtx({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ message: "pallet and method must be valid" }),
          { status: 400 },
        ),
    });
    await assert.rejects(
      () => dataApiFetchJson(ctx, "/api/v1/chain-events?pallet=bad"),
      (err: Row) =>
        err.code === "invalid_params" &&
        /pallet and method must be valid/.test(err.message),
    );
  });

  test("dataApiFetchJson uses a default 400 message when the body is not JSON", async () => {
    await assert.rejects(
      () =>
        dataApiFetchJson(
          dataApiCtx({
            fetchImpl: async () => new Response("not-json", { status: 400 }),
          }),
          "/api/v1/chain-events?method=x",
        ),
      (err: Row) =>
        err.code === "invalid_params" &&
        /Invalid request to the all-events data tier/.test(err.message),
    );
  });

  test("dataApiFetchJson keeps the default 400 message when error is absent", async () => {
    await assert.rejects(
      () =>
        dataApiFetchJson(
          dataApiCtx({
            fetchImpl: async () =>
              new Response(JSON.stringify({}), { status: 400 }),
          }),
          "/api/v1/chain-events?method=x",
        ),
      (err: Row) =>
        err.code === "invalid_params" &&
        /Invalid request to the all-events data tier/.test(err.message),
    );
  });

  test("dataApiFetchJson surfaces tier_unavailable on a non-OK upstream status", async () => {
    await assert.rejects(
      () =>
        dataApiFetchJson(
          dataApiCtx({
            fetchImpl: async () => new Response("err", { status: 502 }),
          }),
          "/api/v1/chain-events/stats",
        ),
      (err: Row) => err.code === "tier_unavailable" && /502/.test(err.message),
    );
  });

  test("dataApiFetchJson surfaces tier_unavailable on malformed 2xx JSON", async () => {
    await assert.rejects(
      () =>
        dataApiFetchJson(
          dataApiCtx({
            fetchImpl: async () => new Response("not-json", { status: 200 }),
          }),
          "/api/v1/chain-events/stats",
        ),
      (err: Row) =>
        err.code === "tier_unavailable" &&
        /malformed response/.test(err.message),
    );
  });

  test("loadBlockChainEvents rejects a non-integer block_number", async () => {
    await assert.rejects(
      () =>
        loadBlockChainEvents(
          dataApiCtx({ fetchImpl: async () => new Response("{}") }),
          -1,
        ),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadBlockChainEvents shapes the block sub-resource payload", async () => {
    const { ctx, calls } = lakehouseCtx([
      {
        block_number: 4_200_000,
        event_index: 0,
        pallet: "Balances",
        method: "Transfer",
        args: "{}",
        phase: "ApplyExtrinsic",
        extrinsic_index: 1,
        observed_at: 1,
      },
    ]);
    const out = (await loadBlockChainEvents(ctx, 4_200_000)) as Row;
    assert.ok(calls.length > 0, "the lakehouse was never queried");
    assert.match(calls[0]!, /block_number = 4200000\b/);
    assert.equal(out.block_number, 4_200_000);
    assert.equal(out.event_count, 1);
    assert.equal(out.events[0].pallet, "Balances");
  });

  test("loadBlockChainEvents publishes the formatted event contract", async () => {
    const { ctx } = lakehouseCtx([
      {
        block_number: 123,
        event_index: 0,
        pallet: "System",
        method: "ExtrinsicSuccess",
        args: '{"x":1}',
        phase: "ApplyExtrinsic",
        extrinsic_index: 2,
        observed_at: 100,
      },
    ]);
    const out = (await loadBlockChainEvents(ctx, 123)) as Row;
    assert.equal(out.event_count, 1);
    // Decoded and summarized by the same formatter every tier uses, so a
    // caller cannot tell which one answered.
    assert.equal(typeof out.events[0].args, "object");
    assert.equal(typeof out.events[0].summary, "string");
    assert.equal(typeof out.events[0].observed_at, "number");
  });

  // A MISS IS NOT AN EMPTY BLOCK. A tier that could not be READ has to say so:
  // an agent handed `events: []` for a block with 400 of them will reason from
  // it, and will not think to retry in an hour the way a person clicking a page
  // might (#9260).
  test("loadBlockChainEvents declines when the tier cannot be read", async () => {
    globalThis.fetch = (async () => {
      throw new Error("r2 sql unreachable");
    }) as unknown as typeof fetch;
    resetDecodeWatermarkCache();
    const ctx = {
      clientIp: "127.0.0.1",
      env: { [R2_SQL_TOKEN_ENV]: "cfut_test" },
    } as unknown as DataApiMcpContext;
    await assert.rejects(
      () => loadBlockChainEvents(ctx, 4_200_000),
      (err: Row) => err.code === "tier_unavailable",
    );
  });

  test("loadBlockChainEvents reads its network's own namespace", async () => {
    const { ctx, calls } = lakehouseCtx([
      {
        block_number: 7_700_500,
        event_index: 0,
        pallet: "System",
        method: "ExtrinsicSuccess",
        args: "{}",
        phase: "ApplyExtrinsic",
        extrinsic_index: 0,
        observed_at: 1,
      },
    ]);
    const out = (await loadBlockChainEvents(ctx, 7_700_500, "testnet")) as Row;
    assert.ok(calls.length > 0, "the lakehouse was never queried");
    for (const q of calls) assert.match(q, /\bchain_testnet\.\w+/);
    assert.equal(out.block_number, 7_700_500);
    assert.equal(out.event_count, 1);
  });

  test("loadExtrinsicChainEvents rejects a non-composite ref", async () => {
    await assert.rejects(
      () =>
        loadExtrinsicChainEvents(
          dataApiCtx({ fetchImpl: async () => new Response("{}") }),
          "0xabc",
        ),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("loadExtrinsicChainEvents scopes the read to that block+extrinsic", async () => {
    const { ctx, calls } = lakehouseCtx([]);
    const out = (await loadExtrinsicChainEvents(ctx, "4200000-3")) as Row;
    assert.equal(calls.length, 1, "the lakehouse was never queried");
    assert.match(calls[0]!, /block_number = 4200000\b/);
    assert.match(calls[0]!, /extrinsic_index = 3\b/);
    assert.match(calls[0]!, /LIMIT 50\b/);
    assert.equal(out.ref, "4200000-3");
    assert.equal(out.extrinsic_index, 3);
    assert.equal(out.limit, 50);
    assert.deepEqual(out.events, []);
  });

  test("loadExtrinsicChainEvents publishes the formatted event contract", async () => {
    const { ctx } = lakehouseCtx([
      {
        block_number: 123,
        event_index: 0,
        pallet: "System",
        method: "ExtrinsicSuccess",
        args: '{"x":1}',
        phase: "ApplyExtrinsic",
        extrinsic_index: 2,
        observed_at: 100,
      },
    ]);
    const out = (await loadExtrinsicChainEvents(ctx, "5870000-3")) as Row;
    assert.equal(out.event_count, 1);
    assert.equal(out.events[0].pallet, "System");
    // Decoded from the column's TEXT and summarized, exactly as every other
    // tier publishes it.
    assert.equal(typeof out.events[0].args, "object");
    assert.equal(typeof out.events[0].summary, "string");
    assert.equal(typeof out.events[0].observed_at, "number");
  });

  test("loadExtrinsicChainEvents applies limit and resumes from a cursor", async () => {
    const { ctx, calls } = lakehouseCtx([
      {
        block_number: 4200000,
        event_index: 8,
        pallet: "System",
        method: "ExtrinsicSuccess",
        args: "{}",
        phase: "ApplyExtrinsic",
        extrinsic_index: 3,
        observed_at: 100,
      },
    ]);
    const out = (await loadExtrinsicChainEvents(ctx, "4200000-3", {
      limit: 25,
      cursor: "100.4200000.9",
    })) as Row;
    assert.match(calls[0]!, /LIMIT 25\b/);
    assert.equal(out.limit, 25);
    assert.equal(out.events[0].method, "ExtrinsicSuccess");
  });

  test("loadExtrinsicChainEvents clamps an oversized limit to this surface's 200", async () => {
    const { ctx, calls } = lakehouseCtx([]);
    const out = (await loadExtrinsicChainEvents(ctx, "4200000-3", {
      limit: 999,
    })) as Row;
    assert.match(calls[0]!, /LIMIT 200\b/);
    assert.equal(out.limit, 200);
    assert.equal(out.event_count, 0);
    assert.deepEqual(out.events, []);
    assert.equal(out.next_cursor, null);
  });

  test("loadExtrinsicChainEvents defaults invalid limits to 50", async () => {
    const { ctx, calls } = lakehouseCtx([]);
    const out = (await loadExtrinsicChainEvents(ctx, "4200000-3", {
      limit: 0,
    })) as Row;
    assert.match(calls[0]!, /LIMIT 50\b/);
    assert.equal(out.limit, 50);
  });

  test("loadChainEventsFeed applies every filter and prefers cursor over before", async () => {
    const { ctx, calls } = lakehouseCtx([
      {
        block_number: 9,
        event_index: 1,
        pallet: "SubtensorModule",
        method: "WeightsSet",
        args: "{}",
        phase: "ApplyExtrinsic",
        extrinsic_index: 1,
        observed_at: 100,
      },
    ]);
    const out = (await loadChainEventsFeed(ctx, {
      pallet: "SubtensorModule",
      method: "WeightsSet",
      block: 9,
      extrinsic: 1,
      cursor: "1.2.3",
      before: 99,
      limit: 25,
    })) as Row;
    assert.equal(calls.length, 1, "the lakehouse was never queried");
    assert.match(calls[0]!, /pallet = 'SubtensorModule'/);
    assert.match(calls[0]!, /method = 'WeightsSet'/);
    // A single-block lookup is exact, so neither the cursor nor `before`
    // becomes a ceiling -- but `before` must not leak in either way.
    assert.match(calls[0]!, /block_number = 9\b/);
    assert.doesNotMatch(calls[0]!, /block_number <= 98\b/);
    assert.equal(out.count, 1);
    assert.equal(out.events[0].method, "WeightsSet");
  });

  test("loadChainEventsFeed honours the legacy before when no cursor supersedes it", async () => {
    const { ctx, calls } = lakehouseCtx([]);
    const out = (await loadChainEventsFeed(ctx, { before: 50 })) as Row;
    // `before` is block-EXCLUSIVE, so the ceiling is one below it.
    assert.match(calls[0]!, /block_number <= 49\b/);
    assert.equal(out.count, 0);
    assert.deepEqual(out.events, []);
    assert.equal(out.next_cursor, null);
  });
});
