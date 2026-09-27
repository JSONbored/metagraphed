import assert from "node:assert/strict";
import { test } from "vitest";
import {
  axonObservationEpochMs,
  axonObservationIso,
} from "../src/axon-removal-observed-at.ts";
import {
  loadAxonRemovals,
  subnetAxonRemovalRow,
  accountAxonRemovalRows,
} from "../src/axon-removals-loader.ts";
import { buildChainAxonRemovals } from "../src/chain-axon-removals.ts";
import { buildSubnetAxonRemovals } from "../src/subnet-axon-removals.ts";
import { buildAccountAxonRemovals } from "../src/account-axon-removals.ts";

test("daily observations use UTC while epoch milliseconds keep their precision", () => {
  const iso = "2026-08-02T00:00:00.000Z";
  assert.equal(axonObservationEpochMs("2026-08-02"), Date.parse(iso));
  assert.equal(axonObservationIso("2026-08-02"), iso);
  assert.equal(axonObservationIso("2024-02-29"), "2024-02-29T00:00:00.000Z");
  for (const value of [Date.parse(iso) + 123, String(Date.parse(iso) + 123)]) {
    assert.equal(axonObservationIso(value), "2026-08-02T00:00:00.123Z");
  }
  for (const value of [
    null,
    undefined,
    "",
    " ",
    "bad",
    "2026-02-30",
    "2026-13-01",
    "2026-02-29",
    0,
    -1,
    NaN,
    Infinity,
    1e30,
  ]) {
    assert.equal(axonObservationIso(value), null, String(value));
  }
});

test("derived transitions retain their observed dates through all three public builders", async () => {
  const observations = [
    ["2026-08-01", "1.2.3.4:8091"],
    ["2026-08-02", null],
    ["2026-08-03", null],
  ].map(([snapshot_date, axon]) => ({
    netuid: 7,
    uid: 1,
    hotkey: "hkA",
    snapshot_date,
    axon,
  }));
  const rollup = await loadAxonRemovals(
    {},
    {
      query: async () => observations,
      now: () => Date.parse("2026-08-04T00:00:00Z"),
      windowDays: 7,
    },
  );
  assert.ok(rollup);
  const chain = buildChainAxonRemovals(rollup.subnets, {
    networkDistinct: rollup.network,
    derivation: rollup.derivation,
  });
  const subnet = buildSubnetAxonRemovals(subnetAxonRemovalRow(rollup, 7), 7);
  const account = buildAccountAxonRemovals(
    accountAxonRemovalRows(rollup, "hkA"),
    "hkA",
  );
  assert.equal(chain.observed_at, "2026-08-02T00:00:00.000Z");
  assert.equal(subnet.observed_at, chain.observed_at);
  assert.equal(account.subnets[0].first_removed_at, chain.observed_at);
  assert.equal(account.subnets[0].last_removed_at, chain.observed_at);
  assert.equal(account.total_removals, 1);
});
