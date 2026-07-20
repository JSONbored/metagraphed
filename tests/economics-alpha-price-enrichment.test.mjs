import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import {
  loadAlphaPriceHistory,
  withAlphaPriceChanges,
} from "../src/economics-alpha-price-enrichment.mjs";

describe("economics-alpha-price-enrichment", () => {
  test("withAlphaPriceChanges stamps null fields when Postgres is cold", async () => {
    const blob = {
      subnets: [{ netuid: 7, alpha_price_tao: 1.5, emission_share: 1 }],
      summary: { with_economics_count: 1 },
    };
    const out = await withAlphaPriceChanges(
      {},
      new Request("https://x/"),
      blob,
    );
    assert.equal(out.subnets[0].alpha_price_change_1d, null);
    assert.equal(out.subnets[0].alpha_price_change_1h, null);
    assert.equal(out.subnets[0].alpha_price_tao, 1.5);
  });

  test("withAlphaPriceChanges merges history from DATA_API", async () => {
    const env = {
      METAGRAPH_SUBNET_SNAPSHOTS_SOURCE: "postgres",
      DATA_API: {
        async fetch() {
          return Response.json({
            rows: [
              {
                netuid: 7,
                snapshot_date: "2026-07-01",
                alpha_price_tao: 1,
              },
              {
                netuid: 7,
                snapshot_date: "2026-07-10",
                alpha_price_tao: 2,
              },
            ],
          });
        },
      },
    };
    const blob = {
      subnets: [{ netuid: 7, alpha_price_tao: 2, emission_share: 1 }],
    };
    const out = await withAlphaPriceChanges(
      env,
      new Request("https://metagraph.sh/api/v1/economics"),
      blob,
    );
    assert.equal(out.subnets[0].alpha_price_change_1d, 100);
    assert.equal(out.subnets[0].alpha_price_change_1h, null);
  });

  test("loadAlphaPriceHistory returns null when the flag is off", async () => {
    const spy = vi.fn();
    const env = {
      METAGRAPH_SUBNET_SNAPSHOTS_SOURCE: "d1",
      DATA_API: { fetch: spy },
    };
    assert.equal(
      await loadAlphaPriceHistory(env, new Request("https://x/")),
      null,
    );
    assert.equal(spy.mock.calls.length, 0);
  });

  test("loadAlphaPriceHistory indexes rows from a successful tier response", async () => {
    const env = {
      METAGRAPH_SUBNET_SNAPSHOTS_SOURCE: "postgres",
      DATA_API: {
        async fetch(req) {
          assert.match(String(req.url), /alpha-price-history/);
          assert.match(String(req.url), /days=35/);
          return Response.json({
            rows: [
              { netuid: 1, snapshot_date: "2026-07-01", alpha_price_tao: 0.1 },
            ],
          });
        },
      },
    };
    const map = await loadAlphaPriceHistory(
      env,
      new Request("https://metagraph.sh/api/v1/economics"),
    );
    assert.ok(map instanceof Map);
    assert.equal(map.get(1)[0].alpha_price_tao, 0.1);
  });

  test("withAlphaPriceChanges passes through non-economics blobs", async () => {
    assert.equal(
      await withAlphaPriceChanges({}, new Request("https://x/"), null),
      null,
    );
    assert.deepEqual(
      await withAlphaPriceChanges({}, new Request("https://x/"), {
        summary: 1,
      }),
      { summary: 1 },
    );
  });

  test("withAlphaPriceChanges skips history fetch when env is falsy", async () => {
    const out = await withAlphaPriceChanges(null, new Request("https://x/"), {
      subnets: [{ netuid: 1, alpha_price_tao: 1 }],
    });
    assert.equal(out.subnets[0].alpha_price_change_1d, null);
  });

  test("loadAlphaPriceHistory returns null when tier body lacks rows", async () => {
    const env = {
      METAGRAPH_SUBNET_SNAPSHOTS_SOURCE: "postgres",
      DATA_API: {
        async fetch() {
          return Response.json({ ok: true });
        },
      },
    };
    assert.equal(
      await loadAlphaPriceHistory(env, new Request("https://x/")),
      null,
    );
  });

  test("historyRequest falls back when request.url is missing", async () => {
    const env = {
      METAGRAPH_SUBNET_SNAPSHOTS_SOURCE: "postgres",
      DATA_API: {
        async fetch(req) {
          assert.match(String(req.url), /^https:\/\/metagraph\.internal\//);
          return Response.json({ rows: [] });
        },
      },
    };
    const map = await loadAlphaPriceHistory(env, { headers: {} });
    assert.ok(map instanceof Map);
    assert.equal(map.size, 0);
  });
});
