import assert from "node:assert/strict";
import { test } from "vitest";
import {
  overlaySubnetEconomics,
  withSpotPricedEconomics,
} from "../src/health-serving.ts";
import type { Row } from "./row-type.ts";

const blob = {
  subnets: [
    { netuid: 0, name: "root", validator_count: 64, alpha_price_tao: 1 },
    {
      netuid: 1,
      name: "apex",
      validator_count: 50,
      miner_count: 200,
      registration_allowed: true,
      max_stake_alpha: 1234.5,
      alpha_price_tao: 0.042,
    },
  ],
};

test("overlaySubnetEconomics attaches the matching per-subnet row (#1308)", () => {
  const detail = { schema_version: 1, subnet: { netuid: 1 }, surfaces: [] };
  const out = overlaySubnetEconomics(detail, blob, 1) as Row;
  assert.equal(out.economics.netuid, 1);
  assert.equal(out.economics.validator_count, 50);
  assert.equal(out.economics.registration_allowed, true);
  assert.equal(out.economics.alpha_price_tao, 0.042);
  // Original fields preserved, no mutation of input.
  assert.deepEqual(out.subnet, { netuid: 1 });
  assert.equal("economics" in detail, false);
});

test("overlaySubnetEconomics is null-safe when the economics tier is cold", () => {
  const detail = { subnet: { netuid: 1 }, surfaces: [] };
  // resolveLiveEconomics → null means we pass undefined as the blob.
  assert.deepEqual(overlaySubnetEconomics(detail, undefined, 1), detail);
  assert.deepEqual(overlaySubnetEconomics(detail, {}, 1), detail);
  assert.deepEqual(
    overlaySubnetEconomics(detail, { subnets: null }, 1),
    detail,
  );
});

test("overlaySubnetEconomics leaves detail unchanged when no row matches", () => {
  const detail = { subnet: { netuid: 99 }, surfaces: [] };
  const out = overlaySubnetEconomics(detail, blob, 99) as Row;
  assert.equal("economics" in out, false);
  assert.deepEqual(out, detail);
});

test("overlaySubnetEconomics returns a non-object detail untouched", () => {
  assert.equal(overlaySubnetEconomics(null, blob, 1), null);
  assert.equal(overlaySubnetEconomics(undefined, blob, 1), undefined);
});

test("withSpotPricedEconomics derives spot on every row (#9408 completion)", () => {
  const out = withSpotPricedEconomics({
    captured_at: "t",
    subnets: [
      // Root has no AMM: 1 by definition, reserves or not.
      { netuid: 0, alpha_price_tao: 1 },
      { netuid: 7, tao_in_pool_tao: 100, alpha_in_pool: 400 },
      // Reserves that cannot support a price → explicit null, never 0.
      { netuid: 9, tao_in_pool_tao: null, alpha_in_pool: null },
    ],
  }) as Row;
  assert.equal(out.subnets[0].spot_price_tao, 1);
  assert.equal(out.subnets[1].spot_price_tao, 0.25);
  assert.equal(out.subnets[2].spot_price_tao, null);
  // The rest of the blob rides along unchanged.
  assert.equal(out.captured_at, "t");
});

test("withSpotPricedEconomics is null-safe on cold or malformed blobs", () => {
  assert.equal(withSpotPricedEconomics(null), null);
  assert.equal(withSpotPricedEconomics(undefined), undefined);
  assert.deepEqual(withSpotPricedEconomics({ summary: {} }), { summary: {} });
  const noArray = { subnets: "nope" } as unknown as Row;
  assert.deepEqual(withSpotPricedEconomics(noArray), noArray);
});
