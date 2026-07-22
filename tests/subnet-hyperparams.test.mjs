import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  formatSubnetHyperparams,
  buildSubnetHyperparams,
} from "../src/subnet-hyperparams.ts";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

function rawRow(overrides = {}) {
  return {
    kappa_ratio: 0.5,
    immunity_period: 4096,
    min_allowed_weights: 8,
    max_weight_limit_ratio: 1,
    tempo: 360,
    weights_version: 0,
    weights_rate_limit: 100,
    activity_cutoff: 5000,
    activity_cutoff_factor: 1,
    registration_allowed: 1,
    target_regs_per_interval: 2,
    min_burn_tao: 0.000001,
    max_burn_tao: 100,
    burn_half_life: 43200,
    burn_increase_mult: 1.5,
    bonds_moving_avg_raw: 900000,
    max_regs_per_block: 1,
    serving_rate_limit: 50,
    max_validators: 64,
    commit_reveal_period: 1,
    commit_reveal_enabled: 0,
    alpha_high_ratio: 0.9,
    alpha_low_ratio: 0.7,
    liquid_alpha_enabled: 0,
    alpha_sigmoid_steepness: 10,
    yuma_version: 2,
    subnet_is_active: 1,
    transfers_enabled: 1,
    bonds_reset_enabled: 0,
    user_liquidity_enabled: 0,
    owner_cut_enabled: 1,
    owner_cut_auto_lock_enabled: 0,
    min_childkey_take_ratio: 0,
    block_number: 5_000_000,
    captured_at: 1_750_000_000_000,
    ...overrides,
  };
}

describe("formatSubnetHyperparams", () => {
  test("formats every field from a full D1 row", () => {
    const out = formatSubnetHyperparams(rawRow());
    assert.equal(out.kappa_ratio, 0.5);
    assert.equal(out.immunity_period, 4096);
    assert.equal(out.min_allowed_weights, 8);
    assert.equal(out.max_weight_limit_ratio, 1);
    assert.equal(out.tempo, 360);
    assert.equal(out.registration_allowed, true);
    assert.equal(out.commit_reveal_enabled, false);
    assert.equal(out.subnet_is_active, true);
    assert.equal(out.min_burn_tao, 0.000001);
    assert.equal(out.max_burn_tao, 100);
    assert.equal(out.bonds_moving_avg_raw, 900000);
    assert.equal(out.burn_increase_mult, 1.5);
    assert.equal(out.alpha_sigmoid_steepness, 10);
    assert.equal(out.min_childkey_take_ratio, 0);
  });

  test("coerces D1 0/1 flags to real booleans, never left as 0/1", () => {
    const out = formatSubnetHyperparams(
      rawRow({
        registration_allowed: 0,
        commit_reveal_enabled: 1,
        liquid_alpha_enabled: 1,
        subnet_is_active: 0,
        transfers_enabled: 0,
        bonds_reset_enabled: 1,
        user_liquidity_enabled: 1,
        owner_cut_enabled: 0,
        owner_cut_auto_lock_enabled: 1,
      }),
    );
    assert.equal(out.registration_allowed, false);
    assert.equal(out.commit_reveal_enabled, true);
    assert.equal(out.liquid_alpha_enabled, true);
    assert.equal(out.subnet_is_active, false);
    assert.equal(out.transfers_enabled, false);
    assert.equal(out.bonds_reset_enabled, true);
    assert.equal(out.user_liquidity_enabled, true);
    assert.equal(out.owner_cut_enabled, false);
    assert.equal(out.owner_cut_auto_lock_enabled, true);
  });

  test("rounds *_ratio fields to 9dp and drops float noise", () => {
    const out = formatSubnetHyperparams(
      rawRow({ kappa_ratio: 0.1 + 0.2 - 0.3 + 0.5 }), // float-noisy 0.5
    );
    assert.equal(out.kappa_ratio, 0.5);
  });

  test("nullable numeric fields stay null on a null or blank D1 cell", () => {
    const out = formatSubnetHyperparams(
      rawRow({
        kappa_ratio: null,
        min_burn_tao: "",
        burn_increase_mult: "   ",
        immunity_period: null,
      }),
    );
    assert.equal(out.kappa_ratio, null);
    assert.equal(out.min_burn_tao, null);
    assert.equal(out.burn_increase_mult, null);
    assert.equal(out.immunity_period, null);
  });

  test("tolerates D1 numeric-string cells for integer fields", () => {
    const out = formatSubnetHyperparams(rawRow({ tempo: "360" }));
    assert.equal(out.tempo, 360);
  });

  test("returns null for a non-object or missing row", () => {
    for (const row of [null, undefined, "nope", 5]) {
      assert.equal(formatSubnetHyperparams(row), null, JSON.stringify(row));
    }
  });

  test("returns null for a non-numeric garbage string on a *_tao/float field", () => {
    const out = formatSubnetHyperparams(rawRow({ burn_increase_mult: "abc" }));
    assert.equal(out.burn_increase_mult, null);
  });

  test("returns null for a blank string on an integer field", () => {
    const out = formatSubnetHyperparams(rawRow({ tempo: "   " }));
    assert.equal(out.tempo, null);
  });

  test("returns null for a negative or fractional value on an integer field", () => {
    const negative = formatSubnetHyperparams(rawRow({ tempo: -5 }));
    assert.equal(negative.tempo, null);
    const fractional = formatSubnetHyperparams(rawRow({ tempo: 1.5 }));
    assert.equal(fractional.tempo, null);
  });
});

describe("buildSubnetHyperparams", () => {
  test("wraps the formatted row with netuid/captured_at/block_number", () => {
    const out = buildSubnetHyperparams(rawRow(), 7);
    assert.equal(out.schema_version, 1);
    assert.equal(out.netuid, 7);
    assert.equal(out.block_number, 5_000_000);
    assert.equal(out.captured_at, new Date(1_750_000_000_000).toISOString());
    assert.equal(typeof out.hyperparameters, "object");
    assert.equal(out.hyperparameters.tempo, 360);
  });

  test("is cold-safe: hyperparameters/captured_at/block_number all null on a missing row", () => {
    const out = buildSubnetHyperparams(null, 7);
    assert.equal(out.netuid, 7);
    assert.equal(out.captured_at, null);
    assert.equal(out.block_number, null);
    assert.equal(out.hyperparameters, null);
  });

  test("tolerates a D1 numeric-string block_number", () => {
    const out = buildSubnetHyperparams(rawRow({ block_number: "5000000" }), 7);
    assert.equal(out.block_number, 5_000_000);
  });

  test("captured_at is null for a non-finite or non-positive value", () => {
    for (const captured_at of ["garbage", NaN, Infinity, -Infinity, 0, -5]) {
      const out = buildSubnetHyperparams(rawRow({ captured_at }), 7);
      assert.equal(out.captured_at, null, JSON.stringify(captured_at));
    }
  });

  test("captured_at is null for a finite ms value outside the Date-representable range", () => {
    const out = buildSubnetHyperparams(rawRow({ captured_at: 8.7e15 }), 7);
    assert.equal(out.captured_at, null);
  });
});

const ctx = { waitUntil: (p) => p };

// D1 retirement: subnet_hyperparams's D1 write/read path is retired, so this
// route never queries D1 -- with no METAGRAPH_SUBNET_HYPERPARAMS_SOURCE=
// postgres flag configured, it always returns the schema-stable null shape
// (buildSubnetHyperparams(null, netuid) in workers/request-handlers/
// entities.mjs's handleSubnetHyperparams). Postgres-hit/-failure coverage for
// this route lives in tests/request-handlers-entities.test.mjs alongside the
// other flag=postgres tiers.
describe("GET /api/v1/subnets/{netuid}/hyperparameters via the Worker", () => {
  test("is schema-stable when Postgres is unconfigured (never 404)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets/7/hyperparameters"),
      createLocalArtifactEnv(),
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, 7);
    assert.equal("hyperparameters" in body.data, true);
    assert.equal(body.data.hyperparameters, null);
  });

  test("an unsupported query param is a 400", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/7/hyperparameters?foo=bar",
      ),
      createLocalArtifactEnv(),
      ctx,
    );
    assert.equal(res.status, 400);
  });
});
