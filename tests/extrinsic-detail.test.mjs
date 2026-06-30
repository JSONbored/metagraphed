import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { loadExtrinsicDetail } from "../src/extrinsic-detail.mjs";
import {
  dataApiFetchJson,
  loadBlockChainEvents,
  loadExtrinsicChainEvents,
} from "../src/data-api-mcp.mjs";

function d1With(fixtures = {}, capture = []) {
  return async (sql, params) => {
    capture.push({ sql, params });
    if (/FROM extrinsics WHERE extrinsic_hash/.test(sql))
      return fixtures.byHash ?? [];
    if (/FROM extrinsics WHERE block_number = \? AND extrinsic_index/.test(sql))
      return fixtures.byComposite ?? [];
    if (
      /FROM account_events WHERE block_number = \? AND extrinsic_index/.test(
        sql,
      )
    )
      return fixtures.events ?? [];
    return [];
  };
}

const EXTRINSIC = {
  block_number: 4_200_000,
  extrinsic_index: 3,
  extrinsic_hash: "0x" + "c".repeat(64),
  signer: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
  call_module: "SubtensorModule",
  call_function: "set_weights",
  call_args: null,
  success: 1,
  fee_tao: 0.0005,
  tip_tao: null,
  observed_at: 1_750_009_000_000,
};
const EVENT = {
  block_number: 4_200_000,
  extrinsic_index: 3,
  event_index: 0,
  event_kind: "WeightsSet",
  hotkey: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
  coldkey: null,
  netuid: 7,
  uid: 3,
  amount_tao: null,
  observed_at: 1_750_009_000_000,
};

describe("loadExtrinsicDetail", () => {
  test("embeds account_events for a resolved composite ref", async () => {
    const capture = [];
    const d1 = d1With({ byComposite: [EXTRINSIC], events: [EVENT] }, capture);
    const data = await loadExtrinsicDetail(d1, "4200000-3");
    assert.equal(data.extrinsic.call_function, "set_weights");
    assert.equal(data.events.length, 1);
    assert.equal(data.events[0].event_kind, "WeightsSet");
    const q = capture.find((c) => /FROM account_events/.test(c.sql));
    assert.deepEqual(q.params.slice(0, 3), [4_200_000, 3, 50]);
  });

  test("embeds account_events for a hash ref", async () => {
    const hash = "0x" + "c".repeat(64);
    const d1 = d1With({ byHash: [EXTRINSIC], events: [EVENT] });
    const data = await loadExtrinsicDetail(d1, hash);
    assert.equal(data.events.length, 1);
    assert.equal(data.events[0].event_kind, "WeightsSet");
  });

  test("lowercases hash refs before the extrinsics lookup", async () => {
    const capture = [];
    const hash = "0x" + "C".repeat(64);
    const d1 = d1With({ byHash: [EXTRINSIC], events: [] }, capture);
    await loadExtrinsicDetail(d1, hash);
    const q = capture.find((c) => /extrinsic_hash = \?/.test(c.sql));
    assert.equal(q.params[0], hash.toLowerCase());
  });

  test("malformed ref yields extrinsic:null without account_events query", async () => {
    const capture = [];
    const d1 = d1With({}, capture);
    const data = await loadExtrinsicDetail(d1, "not-an-extrinsic");
    assert.equal(data.extrinsic, null);
    assert.deepEqual(data.events, []);
    assert.equal(
      capture.some((c) => /FROM account_events/.test(c.sql)),
      false,
    );
  });

  test("skips account_events when extrinsic row is missing", async () => {
    const capture = [];
    const d1 = d1With({ byComposite: [] }, capture);
    const data = await loadExtrinsicDetail(d1, "4200000-3");
    assert.equal(data.extrinsic, null);
    assert.equal(
      capture.some((c) => /FROM account_events/.test(c.sql)),
      false,
    );
  });
});

function dataApiCtx({ fetchImpl, rateLimit = null } = {}) {
  return {
    clientIp: "127.0.0.1",
    env: {
      DATA_API: fetchImpl ? { fetch: fetchImpl } : undefined,
      DATA_RATE_LIMITER: rateLimit,
    },
  };
}

describe("data-api-mcp", () => {
  test("dataApiFetchJson surfaces tier_unavailable without a binding", async () => {
    await assert.rejects(
      () => dataApiFetchJson(dataApiCtx(), "/api/v1/chain-events/stats"),
      (err) => err.code === "tier_unavailable",
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
      (err) => err.code === "data_rate_limited",
    );
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
      (err) => err.code === "tier_unavailable",
    );
  });

  test("dataApiFetchJson maps upstream 400 to invalid_params", async () => {
    const ctx = dataApiCtx({
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "bad filter" }), { status: 400 }),
    });
    await assert.rejects(
      () => dataApiFetchJson(ctx, "/api/v1/chain-events?method=x"),
      (err) => err.code === "invalid_params" && /bad filter/.test(err.message),
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
      (err) =>
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
      (err) => err.code === "tier_unavailable" && /502/.test(err.message),
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
      (err) =>
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
      (err) => err.code === "invalid_params",
    );
  });

  test("loadBlockChainEvents shapes the block sub-resource payload", async () => {
    const ctx = dataApiCtx({
      fetchImpl: async (request) => {
        assert.match(request.url, /\/blocks\/4200000\/chain-events$/);
        return Response.json({
          block_number: 4200000,
          count: 1,
          events: [
            {
              event_index: 0,
              pallet: "Balances",
              method: "Transfer",
              observed_at: 1,
            },
          ],
        });
      },
    });
    const out = await loadBlockChainEvents(ctx, 4200000);
    assert.equal(out.block_number, 4200000);
    assert.equal(out.event_count, 1);
    assert.equal(out.events[0].pallet, "Balances");
  });

  test("loadBlockChainEvents tolerates a non-array events field", async () => {
    const ctx = dataApiCtx({
      fetchImpl: async () => Response.json({ count: 2, events: null }),
    });
    const out = await loadBlockChainEvents(ctx, 1);
    assert.equal(out.event_count, 2);
    assert.deepEqual(out.events, []);
  });

  test("loadExtrinsicChainEvents rejects a non-composite ref", async () => {
    await assert.rejects(
      () =>
        loadExtrinsicChainEvents(
          dataApiCtx({ fetchImpl: async () => new Response("{}") }),
          "0xabc",
        ),
      (err) => err.code === "invalid_params",
    );
  });

  test("loadExtrinsicChainEvents forwards block+extrinsic filters", async () => {
    const ctx = dataApiCtx({
      fetchImpl: async (request) => {
        const url = new URL(request.url);
        assert.equal(url.searchParams.get("block"), "4200000");
        assert.equal(url.searchParams.get("extrinsic"), "3");
        assert.equal(url.searchParams.get("limit"), "50");
        return Response.json({ count: 0, events: [] });
      },
    });
    const out = await loadExtrinsicChainEvents(ctx, "4200000-3");
    assert.equal(out.ref, "4200000-3");
    assert.equal(out.extrinsic_index, 3);
    assert.equal(out.limit, 50);
    assert.deepEqual(out.events, []);
  });

  test("loadExtrinsicChainEvents forwards limit and cursor", async () => {
    const ctx = dataApiCtx({
      fetchImpl: async (request) => {
        const url = new URL(request.url);
        assert.equal(url.searchParams.get("limit"), "25");
        assert.equal(url.searchParams.get("cursor"), "4200000.9");
        return Response.json({
          count: 1,
          next_cursor: "4200000.8",
          events: [{ pallet: "System", method: "ExtrinsicSuccess" }],
        });
      },
    });
    const out = await loadExtrinsicChainEvents(ctx, "4200000-3", {
      limit: 25,
      cursor: "4200000.9",
    });
    assert.equal(out.limit, 25);
    assert.equal(out.next_cursor, "4200000.8");
    assert.equal(out.events[0].method, "ExtrinsicSuccess");
  });
});
