// Unit tests for the live economics serve gate (resolveLiveEconomics): KV-primary
// with strict freshness + contract + integrity gates, returning null (→ R2
// fallback) on anything off. Pure given a mock readHealthKv + now.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  ECONOMICS_FRESHNESS_MAX_AGE_MS,
  resolveLiveEconomics,
} from "../src/health-serving.mjs";

const NOW = Date.parse("2026-06-20T12:00:00.000Z");
const FRESH = "2026-06-20T11:00:00.000Z"; // 1h old
const CONTRACT = "2026-06-06.1";

// A valid blob: 2 rows, emission_share sums to 1, fresh, on-contract.
function validBlob(over = {}) {
  return {
    schema_version: 1,
    contract_version: CONTRACT,
    captured_at: FRESH,
    generated_at: "1970-01-01T00:00:00.000Z",
    summary: { with_economics_count: 2 },
    subnets: [
      { netuid: 1, slug: "a", emission_share: 0.6 },
      { netuid: 2, slug: "b", emission_share: 0.4 },
    ],
    ...over,
  };
}

const kvOf = (blob) => async (_env, key) =>
  key === "economics:current" ? blob : null;

const call = (blob, opts = {}) =>
  resolveLiveEconomics({
    readHealthKv: kvOf(blob),
    env: {},
    contractVersion: CONTRACT,
    now: () => NOW,
    ...opts,
  });

describe("resolveLiveEconomics", () => {
  test("serves the KV blob when fresh, on-contract, and integrity-valid", async () => {
    const out = await call(validBlob());
    assert.ok(out);
    assert.equal(out.source, "live-kv");
    assert.equal(out.data.subnets.length, 2);
  });

  test("returns null (→ R2 fallback) when KV is cold", async () => {
    assert.equal(await call(null), null);
    assert.equal(
      await resolveLiveEconomics({ readHealthKv: undefined, env: {} }),
      null,
    );
  });

  test("rejects an off-contract blob", async () => {
    assert.equal(
      await call(validBlob({ contract_version: "1999-01-01.0" })),
      null,
    );
  });

  test("rejects a stale blob (older than the freshness window)", async () => {
    const stale = new Date(
      NOW - ECONOMICS_FRESHNESS_MAX_AGE_MS - 60_000,
    ).toISOString();
    assert.equal(await call(validBlob({ captured_at: stale })), null);
    assert.equal(await call(validBlob({ captured_at: "not-a-date" })), null);
  });

  test("accepts a blob right at the freshness boundary", async () => {
    const edge = new Date(
      NOW - ECONOMICS_FRESHNESS_MAX_AGE_MS + 1000,
    ).toISOString();
    assert.ok(await call(validBlob({ captured_at: edge })));
  });

  test("rejects when row count != summary.with_economics_count", async () => {
    assert.equal(
      await call(validBlob({ summary: { with_economics_count: 5 } })),
      null,
    );
  });

  test("rejects when emission_share no longer sums to ~1 (partial/corrupt write)", async () => {
    const bad = validBlob({
      subnets: [
        { netuid: 1, slug: "a", emission_share: 0.6 },
        { netuid: 2, slug: "b", emission_share: 0.1 }, // sums to 0.7
      ],
    });
    assert.equal(await call(bad), null);
  });

  test("tolerates null emission_share rows as long as the numeric ones sum to ~1", async () => {
    const withNull = validBlob({
      summary: { with_economics_count: 3 },
      subnets: [
        { netuid: 1, slug: "a", emission_share: 0.6 },
        { netuid: 2, slug: "b", emission_share: 0.4 },
        { netuid: 3, slug: "c", emission_share: null }, // no price → null share
      ],
    });
    assert.ok(await call(withNull));
  });

  test("rejects non-object / array bodies", async () => {
    for (const body of [42, "x", [], true]) {
      assert.equal(await call(body), null);
    }
  });
});
