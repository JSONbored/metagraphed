import assert from "node:assert/strict";
import { test } from "vitest";
import {
  normalizeNeuron,
  parseNetuidSubset,
} from "../scripts/fetch-metagraph.mjs";

// A realistic raw Taostats neuron (shape verified against the live API 2026-06-21).
const raw = {
  hotkey: { ss58: "5HbNZ77cXQXbUjXG3YLVBGk6N4WbtKtGQYAWLXd2aWa8fqGe" },
  coldkey: { ss58: "5FRXwb2qsEhqDQQKcm5m2MF26xTWwW65MHTEtKFFydypuqjG" },
  netuid: 1,
  uid: 252,
  block_number: 8454388,
  stake: "0",
  trust: "0",
  validator_trust: "0.99998474097810330358",
  consensus: "0",
  incentive: "0",
  dividends: "0.53974212252994583047",
  emission: "22129845598",
  active: true,
  validator_permit: true,
  rank: 1,
  total_alpha_stake: "1344255529357282",
  registered_at_block: 6702485,
  is_immunity_period: false,
  axon: { ip: "1.2.3.4", port: 8091 },
};

test("normalizeNeuron applies verified dTAO units (#1303)", () => {
  const n = normalizeNeuron(raw, 1000);
  // total_alpha_stake (rao) / 1e9 → canonical stake_tao (Σ matches economics).
  assert.equal(n.stake_tao, 1344255.529357282);
  assert.equal(n.emission_tao, 22.129845598);
  // ratios pass through 0..1 (assert against the same Number() conversion to
  // avoid long-precision literals that lose precision identically at runtime).
  assert.equal(n.validator_trust, Number(raw.validator_trust));
  assert.equal(n.dividends, Number(raw.dividends));
  assert.ok(n.validator_trust > 0.99 && n.validator_trust <= 1);
  // booleans → 0/1.
  assert.equal(n.validator_permit, 1);
  assert.equal(n.active, 1);
  assert.equal(n.is_immunity_period, 0);
  // ss58 keys flattened; axon "ip:port".
  assert.equal(n.hotkey, "5HbNZ77cXQXbUjXG3YLVBGk6N4WbtKtGQYAWLXd2aWa8fqGe");
  assert.equal(n.axon, "1.2.3.4:8091");
  assert.equal(n.netuid, 1);
  assert.equal(n.uid, 252);
  assert.equal(n.captured_at, 1000);
});

test("normalizeNeuron is defensive about missing/odd fields", () => {
  const n = normalizeNeuron({ netuid: 5, uid: 0 }, 2000);
  assert.equal(n.netuid, 5);
  assert.equal(n.uid, 0);
  assert.equal(n.hotkey, null);
  assert.equal(n.stake_tao, null);
  assert.equal(n.axon, null);
  assert.equal(n.validator_permit, 0);
});

test("parseNetuidSubset avoids the Number('') === 0 trap (empty → full network)", () => {
  // Critical: an empty/unset env must yield [] so the cron fetches the whole
  // network, not [0] (which would silently fetch only subnet 0).
  assert.deepEqual(parseNetuidSubset(""), []);
  assert.deepEqual(parseNetuidSubset(undefined), []);
  assert.deepEqual(parseNetuidSubset(null), []);
  assert.deepEqual(parseNetuidSubset("1,7,64"), [1, 7, 64]);
  assert.deepEqual(parseNetuidSubset("1, ,7"), [1, 7]);
  assert.deepEqual(parseNetuidSubset("0"), [0]);
});
