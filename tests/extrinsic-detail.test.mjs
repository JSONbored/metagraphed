import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  dataApiFetchJson,
  loadBlockChainEvents,
  loadChainEventsFeed,
  loadExtrinsicChainEvents,
} from "../src/data-api-mcp.ts";

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

  test("dataApiFetchJson proceeds when the data API limiter allows the request", async () => {
    const ctx = dataApiCtx({
      rateLimit: {
        async limit({ key }) {
          assert.equal(key, "data:127.0.0.1");
          return { success: true };
        },
      },
      fetchImpl: async () => Response.json({ ok: true }),
    });
    const out = await dataApiFetchJson(ctx, "/api/v1/chain-events/stats");
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
      (err) =>
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
      (err) =>
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
      (err) =>
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

  // Exact JSON contract from workers/data-api.mjs GET /blocks/:n/chain-events
  // (mirrors tests/data-api.test.mjs).
  test("loadBlockChainEvents round-trips the DATA_API block chain-events contract", async () => {
    const dataApiPayload = {
      block_number: 123,
      count: 1,
      events: [
        {
          event_index: 0,
          pallet: "System",
          method: "ExtrinsicSuccess",
          args: { x: 1 },
          phase: "ApplyExtrinsic",
          extrinsic_index: 2,
          observed_at: 100,
        },
      ],
    };
    const ctx = dataApiCtx({
      fetchImpl: async () => Response.json(dataApiPayload),
    });
    const out = await loadBlockChainEvents(ctx, 123);
    assert.deepEqual(out.events, dataApiPayload.events);
    assert.equal(out.event_count, 1);
    assert.equal(typeof out.events[0].observed_at, "number");
  });

  test("loadBlockChainEvents accepts event_count when count is absent", async () => {
    const ctx = dataApiCtx({
      fetchImpl: async () =>
        Response.json({
          block_number: 55,
          event_count: 2,
          events: [{ event_index: 0 }, { event_index: 1 }],
        }),
    });
    const out = await loadBlockChainEvents(ctx, 55);
    assert.equal(out.event_count, 2);
  });

  test("loadBlockChainEvents falls back to the requested block_number", async () => {
    const ctx = dataApiCtx({
      fetchImpl: async () => Response.json({ count: 0, events: [] }),
    });
    const out = await loadBlockChainEvents(ctx, 99);
    assert.equal(out.block_number, 99);
    assert.equal(out.event_count, 0);
  });

  test("loadBlockChainEvents falls back when upstream block_number is null", async () => {
    const ctx = dataApiCtx({
      fetchImpl: async () =>
        Response.json({ block_number: null, count: 0, events: [] }),
    });
    const out = await loadBlockChainEvents(ctx, 88);
    assert.equal(out.block_number, 88);
  });

  test("loadBlockChainEvents defaults a missing event_count to zero", async () => {
    const ctx = dataApiCtx({
      fetchImpl: async () => Response.json({ block_number: 77, events: [] }),
    });
    const out = await loadBlockChainEvents(ctx, 77);
    assert.equal(out.event_count, 0);
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

  // Exact JSON contract from workers/data-api.mjs GET /chain-events?block=&extrinsic=
  test("loadExtrinsicChainEvents round-trips the DATA_API chain-events feed contract", async () => {
    const dataApiPayload = {
      count: 1,
      next_before: 123,
      next_cursor: "123.0",
      events: [
        {
          block_number: 123,
          event_index: 0,
          pallet: "System",
          method: "ExtrinsicSuccess",
          args: { x: 1 },
          phase: "ApplyExtrinsic",
          extrinsic_index: 2,
          observed_at: 100,
        },
      ],
    };
    const ctx = dataApiCtx({
      fetchImpl: async () => Response.json(dataApiPayload),
    });
    const out = await loadExtrinsicChainEvents(ctx, "5870000-3");
    assert.equal(out.event_count, 1);
    assert.equal(out.next_cursor, "123.0");
    assert.deepEqual(out.events, dataApiPayload.events);
    assert.equal(typeof out.events[0].observed_at, "number");
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

  test("loadExtrinsicChainEvents clamps an oversized limit and tolerates sparse payloads", async () => {
    const ctx = dataApiCtx({
      fetchImpl: async (request) => {
        assert.equal(new URL(request.url).searchParams.get("limit"), "200");
        return Response.json({ events: null });
      },
    });
    const out = await loadExtrinsicChainEvents(ctx, "4200000-3", {
      limit: 999,
    });
    assert.equal(out.limit, 200);
    assert.equal(out.event_count, 0);
    assert.deepEqual(out.events, []);
    assert.equal(out.next_cursor, null);
  });

  test("loadExtrinsicChainEvents defaults invalid limits to 50", async () => {
    const ctx = dataApiCtx({
      fetchImpl: async (request) => {
        assert.equal(new URL(request.url).searchParams.get("limit"), "50");
        return Response.json({ count: 0, events: [] });
      },
    });
    const out = await loadExtrinsicChainEvents(ctx, "4200000-3", { limit: 0 });
    assert.equal(out.limit, 50);
  });

  test("loadChainEventsFeed forwards filters and prefers cursor over before", async () => {
    const ctx = dataApiCtx({
      fetchImpl: async (request) => {
        const url = new URL(request.url);
        assert.equal(url.pathname, "/api/v1/chain-events");
        assert.equal(url.searchParams.get("pallet"), "SubtensorModule");
        assert.equal(url.searchParams.get("method"), "WeightsSet");
        assert.equal(url.searchParams.get("block"), "9");
        assert.equal(url.searchParams.get("extrinsic"), "1");
        assert.equal(url.searchParams.get("cursor"), "1.2.3");
        assert.equal(url.searchParams.get("before"), null);
        assert.equal(url.searchParams.get("limit"), "25");
        return Response.json({
          count: 1,
          next_before: 9,
          next_cursor: "1.2.2",
          events: [{ pallet: "SubtensorModule", method: "WeightsSet" }],
        });
      },
    });
    const out = await loadChainEventsFeed(ctx, {
      pallet: "SubtensorModule",
      method: "WeightsSet",
      block: 9,
      extrinsic: 1,
      cursor: "1.2.3",
      before: 99,
      limit: 25,
    });
    assert.equal(out.count, 1);
    assert.equal(out.next_before, 9);
    assert.equal(out.next_cursor, "1.2.2");
    assert.equal(out.events[0].method, "WeightsSet");
  });

  test("loadChainEventsFeed forwards legacy before when cursor is absent", async () => {
    const ctx = dataApiCtx({
      fetchImpl: async (request) => {
        const url = new URL(request.url);
        assert.equal(url.searchParams.get("before"), "50");
        assert.equal(url.searchParams.get("cursor"), null);
        return Response.json({ events: null });
      },
    });
    const out = await loadChainEventsFeed(ctx, { before: 50 });
    assert.equal(out.count, 0);
    assert.deepEqual(out.events, []);
    assert.equal(out.next_before, null);
    assert.equal(out.next_cursor, null);
  });
});
