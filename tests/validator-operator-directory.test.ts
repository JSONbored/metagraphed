import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { ValidatorOperatorDirectoryArtifactSchema } from "../schemas-src/routes/validator-operator-directory.ts";
import { buildValidatorOperatorDirectory } from "../src/validator-operator-directory.ts";

function validator(overrides: Record<string, unknown> = {}) {
  return {
    hotkey: "hk-a",
    coldkey: "ck-a",
    coldkey_identity: null,
    subnet_count: 1,
    uid_count: 1,
    take: null,
    total_stake_tao: 0,
    total_emission_tao: 0,
    nominator_count: null,
    apy_estimate: null,
    ...overrides,
  };
}

describe("buildValidatorOperatorDirectory", () => {
  test("groups declared identities, keeps anonymous keys separate and ranks by total stake", () => {
    const directory = buildValidatorOperatorDirectory({
      captured_at: "2026-08-29T00:00:00.000Z",
      block_number: 8_950_000,
      validators: [
        validator({
          hotkey: "hk-small",
          coldkey: "ck-team",
          coldkey_identity: { has_identity: true, name: "  Tensor Team  " },
          total_stake_tao: 25,
          total_emission_tao: 2,
          take: 0.2,
          nominator_count: 3,
          subnet_count: 2,
          uid_count: 3,
          apy_estimate: 0.1,
        }),
        validator({
          hotkey: "hk-large",
          coldkey: "ck-team",
          coldkey_identity: { has_identity: true, name: "Tensor Team" },
          total_stake_tao: 75,
          total_emission_tao: 6,
          take: 0.1,
          nominator_count: 7,
          subnet_count: 4,
          uid_count: 5,
          apy_estimate: 0.3,
        }),
        validator({ hotkey: "anonymous-a", total_stake_tao: 50, take: null }),
        validator({ hotkey: "anonymous-b", total_stake_tao: 10, take: "" }),
      ],
    });

    assert.equal(directory.validator_count, 4);
    assert.equal(directory.operator_count, 3);
    assert.equal(directory.captured_at, "2026-08-29T00:00:00.000Z");
    assert.equal(directory.block_number, 8_950_000);

    const team = directory.operators[0]!;
    assert.equal(team.identity_name, "Tensor Team");
    assert.equal(team.primary_hotkey, "hk-large");
    assert.equal(team.hotkey_count, 2);
    assert.deepEqual(
      team.hotkeys.map((key) => key.hotkey),
      ["hk-large", "hk-small"],
    );
    assert.equal(team.total_stake_tao, 100);
    assert.equal(team.total_emission_tao, 8);
    assert.equal(team.nominator_count, 10);
    assert.equal(team.membership_count, 6);
    assert.equal(team.uid_count, 8);
    assert.equal(team.take_min, 0.1);
    assert.equal(team.take_max, 0.2);
    assert.equal(team.apy_estimate, 0.25);
    assert.equal(team.stake_dominance, 0.625);

    const anonymous = directory.operators.slice(1);
    assert.deepEqual(
      anonymous.map((entry) => entry.primary_hotkey),
      ["anonymous-a", "anonymous-b"],
    );
    assert.ok(anonymous.every((entry) => entry.identity_name === null));
    assert.ok(anonymous.every((entry) => entry.hotkeys.length === 0));
    assert.equal(anonymous[0]!.take_min, null);
    assert.equal(
      anonymous[1]!.take_min,
      null,
      "blank cells stay unknown, never zero",
    );

    assert.equal(
      ValidatorOperatorDirectoryArtifactSchema.safeParse(directory).success,
      true,
    );
  });

  test("preserves nulls when no APY, take or nominator measurement exists", () => {
    const directory = buildValidatorOperatorDirectory({
      captured_at: null,
      block_number: null,
      validators: [
        validator({
          hotkey: "hk-null",
          take: null,
          nominator_count: undefined,
          apy_estimate: null,
        }),
      ],
    });
    const operator = directory.operators[0]!;
    assert.equal(operator.take_min, null);
    assert.equal(operator.take_max, null);
    assert.equal(operator.nominator_count, null);
    assert.equal(operator.apy_estimate, null);
    assert.equal(directory.block_number, null);
  });

  test("sanitizes malformed metrics and keeps tie ordering deterministic", () => {
    const directory = buildValidatorOperatorDirectory({
      validators: [
        validator({
          hotkey: "hk-z",
          coldkey_identity: { has_identity: true, name: "Tie Team" },
          total_stake_tao: -1,
          total_emission_tao: Number.POSITIVE_INFINITY,
          take: "not-a-number",
          nominator_count: "not-a-number",
          subnet_count: 1.5,
          uid_count: -1,
          apy_estimate: "not-a-number",
        }),
        validator({
          hotkey: "hk-a",
          coldkey_identity: { has_identity: true, name: "Tie Team" },
          total_stake_tao: "not-a-number",
          subnet_count: -1,
          uid_count: 1.5,
        }),
        validator({
          hotkey: "operator-b",
          coldkey_identity: { has_identity: true, name: "   " },
        }),
        validator({ hotkey: "operator-c" }),
        validator({ hotkey: "" }),
      ],
    });

    assert.equal(directory.validator_count, 4);
    assert.deepEqual(
      directory.operators.map((operator) => operator.primary_hotkey),
      ["hk-a", "operator-b", "operator-c"],
    );
    assert.equal(directory.operators[0]!.hotkey_count, 2);
    assert.equal(directory.operators[0]!.total_stake_tao, 0);
    assert.equal(directory.operators[0]!.total_emission_tao, 0);
    assert.equal(directory.operators[0]!.nominator_count, null);
    assert.equal(directory.operators[0]!.membership_count, 0);
    assert.equal(directory.operators[0]!.uid_count, 0);
    assert.equal(directory.operators[0]!.take_min, null);
    assert.equal(directory.operators[0]!.apy_estimate, null);
    assert.equal(directory.operators[1]!.identity_name, null);
    assert.ok(
      directory.operators.every(
        (operator) => operator.stake_dominance === null,
      ),
    );
    ValidatorOperatorDirectoryArtifactSchema.parse(directory);
  });

  test("returns a schema-valid cold directory", () => {
    const directory = buildValidatorOperatorDirectory(null);
    assert.deepEqual(directory, {
      schema_version: 1,
      captured_at: null,
      block_number: null,
      validator_count: 0,
      operator_count: 0,
      operators: [],
    });
    ValidatorOperatorDirectoryArtifactSchema.parse(directory);
  });
});
