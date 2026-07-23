import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  buildSubnetHyperparamsHistory,
  formatHyperparamsHistoryEntry,
  hyperparamsHash,
} from "../src/subnet-hyperparams-history.ts";
import type { Row } from "./row-type.ts";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.ts";

function stagedRow(overrides = {}) {
  return {
    netuid: 86,
    kappa_ratio: 0.5,
    immunity_period: 7200,
    min_allowed_weights: 8,
    max_weight_limit_ratio: 1,
    tempo: 360,
    weights_version: 1,
    weights_rate_limit: 100,
    activity_cutoff: 5000,
    activity_cutoff_factor: 1,
    registration_allowed: 1,
    target_regs_per_interval: 1,
    min_burn_tao: 0.001,
    max_burn_tao: 100,
    burn_half_life: 100_000,
    burn_increase_mult: 1,
    bonds_moving_avg_raw: 900_000,
    max_regs_per_block: 1,
    serving_rate_limit: 50,
    max_validators: 64,
    commit_reveal_period: 1,
    commit_reveal_enabled: 0,
    alpha_high_ratio: 0.9,
    alpha_low_ratio: 0.1,
    liquid_alpha_enabled: 0,
    alpha_sigmoid_steepness: 10,
    yuma_version: 3,
    subnet_is_active: 1,
    transfers_enabled: 1,
    bonds_reset_enabled: 0,
    user_liquidity_enabled: 0,
    owner_cut_enabled: 1,
    owner_cut_auto_lock_enabled: 1,
    min_childkey_take_ratio: 0,
    block_number: 100,
    captured_at: 1_700_000_000_000,
    ...overrides,
  };
}

// Derives from stagedRow() rather than re-typing the 33 hyperparameter fields
// a second time, so the two fixtures can't silently drift out of sync.
function historyRow(overrides = {}) {
  const {
    netuid: _netuid,
    block_number,
    captured_at,
    ...hyperparamFields
  } = stagedRow();
  return {
    id: 10,
    block_number,
    observed_at: captured_at,
    ...hyperparamFields,
    hyperparams_hash: "abc",
    ...overrides,
  };
}

describe("hyperparamsHash", () => {
  test("is stable for the same object", async () => {
    const payload = { tempo: 360, registration_allowed: true };
    const a = await hyperparamsHash(payload);
    const b = await hyperparamsHash(payload);
    assert.equal(a, b);
    assert.match(a!, /^[a-f0-9]{64}$/);
  });

  test("differs when a field changes", async () => {
    const a = await hyperparamsHash({ tempo: 360 });
    const b = await hyperparamsHash({ tempo: 361 });
    assert.notEqual(a, b);
  });

  test("is order-independent (stable stringify)", async () => {
    const a = await hyperparamsHash({ tempo: 360, kappa_ratio: 0.5 });
    const b = await hyperparamsHash({ kappa_ratio: 0.5, tempo: 360 });
    assert.equal(a, b);
  });

  test("hashes nested arrays via stableStringify", async () => {
    const hash = await hyperparamsHash({ tempo: 360, tags: [1, 2] });
    assert.match(hash!, /^[a-f0-9]{64}$/);
  });

  test("returns null for a null/undefined payload", async () => {
    assert.equal(await hyperparamsHash(null), null);
    assert.equal(await hyperparamsHash(undefined), null);
  });
});

describe("formatHyperparamsHistoryEntry", () => {
  test("formats a D1 row into an API entry, nesting hyperparameters", () => {
    const out = formatHyperparamsHistoryEntry(historyRow()) as Row;
    assert.equal(out.block_number, 100);
    assert.equal(out.observed_at, "2023-11-14T22:13:20.000Z");
    assert.equal(out.hyperparams_hash, "abc");
    assert.equal(out.hyperparameters.tempo, 360);
    assert.equal(out.hyperparameters.registration_allowed, true);
    assert.equal(out.hyperparameters.commit_reveal_enabled, false);
  });

  test("returns null for invalid rows", () => {
    assert.equal(formatHyperparamsHistoryEntry(null), null);
    assert.equal(formatHyperparamsHistoryEntry(undefined), null);
    assert.equal(formatHyperparamsHistoryEntry("nope"), null);
  });

  test("defaults hyperparams_hash to null when absent", () => {
    const out = formatHyperparamsHistoryEntry({
      ...historyRow(),
      hyperparams_hash: undefined,
    }) as Row;
    assert.equal(out.hyperparams_hash, null);
  });

  test("nulls invalid block numbers and observed_at values", () => {
    const out = formatHyperparamsHistoryEntry(
      historyRow({ block_number: "nope", observed_at: 0 }),
    ) as Row;
    assert.equal(out.block_number, null);
    assert.equal(out.observed_at, null);
  });

  test("nulls blank/whitespace and negative block_number cells", () => {
    for (const block_number of ["", "   ", -1, "-5"]) {
      const out = formatHyperparamsHistoryEntry(
        historyRow({ block_number }),
      ) as Row;
      assert.equal(out.block_number, null);
    }
  });

  test("coerces string-typed observed_at cells to ISO timestamps", () => {
    const out = formatHyperparamsHistoryEntry(
      historyRow({ observed_at: "1700000000000" }),
    ) as Row;
    assert.equal(out.observed_at, new Date(1_700_000_000_000).toISOString());
  });

  test("preserves null observed_at as null (not epoch 1970)", () => {
    const out = formatHyperparamsHistoryEntry(
      historyRow({ observed_at: null }),
    ) as Row;
    assert.equal(out.observed_at, null);
  });

  test("nulls a directly-null block_number", () => {
    const out = formatHyperparamsHistoryEntry(
      historyRow({ block_number: null }),
    ) as Row;
    assert.equal(out.block_number, null);
  });

  test("nulls an out-of-range observed_at that produces an invalid Date", () => {
    const out = formatHyperparamsHistoryEntry(
      historyRow({ observed_at: 8_640_000_000_000_001 }),
    ) as Row;
    assert.equal(out.observed_at, null);
  });
});

describe("buildSubnetHyperparamsHistory", () => {
  test("wraps rows with pagination metadata", () => {
    const out = buildSubnetHyperparamsHistory([historyRow({ id: 2 })], 86, {
      limit: 100,
      offset: 0,
      nextCursor: "2.1",
    }) as Row;
    assert.equal(out.netuid, 86);
    assert.equal(out.entry_count, 1);
    assert.equal(out.next_cursor, "2.1");
    assert.equal(out.entries[0].hyperparams_hash, "abc");
  });

  test("defaults limit/offset to null and drops invalid rows", () => {
    const out = buildSubnetHyperparamsHistory([null, historyRow()], 86) as Row;
    assert.equal(out.limit, null);
    assert.equal(out.offset, null);
    assert.equal(out.entry_count, 1);
  });

  test("treats null rows input as empty", () => {
    const out = buildSubnetHyperparamsHistory(null, 86) as Row;
    assert.equal(out.entry_count, 0);
  });
});

const ctx = { waitUntil: (p: Promise<unknown>) => p };

// D1 retirement: subnet_hyperparams_history's D1 write/read path is retired,
// so this route never queries D1 -- with no METAGRAPH_SUBNET_HYPERPARAMS_SOURCE=
// postgres flag configured, it always returns the schema-stable empty shape
// (buildSubnetHyperparamsHistory([], ...) in workers/request-handlers/
// entities.mjs's handleSubnetHyperparamsHistory). Postgres-hit/-failure
// coverage for this route lives in tests/request-handlers-entities.test.mjs
// alongside the other flag=postgres tiers.
describe("GET /api/v1/subnets/{netuid}/hyperparameters/history via the Worker", () => {
  test("is schema-stable when Postgres is unconfigured (never 404)", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/86/hyperparameters/history",
      ),
      createLocalArtifactEnv(),
      ctx,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.netuid, 86);
    assert.equal(body.data.entry_count, 0);
    assert.deepEqual(body.data.entries, []);
  });

  test("an unsupported query param is a 400", async () => {
    const res = await handleRequest(
      new Request(
        "https://api.metagraph.sh/api/v1/subnets/86/hyperparameters/history?foo=bar",
      ),
      createLocalArtifactEnv(),
      ctx,
    );
    assert.equal(res.status, 400);
  });
});
