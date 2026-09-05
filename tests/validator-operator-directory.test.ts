import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { ValidatorOperatorDirectoryArtifactSchema } from "../schemas-src/routes/validator-operator-directory.ts";
import { buildValidatorOperatorDirectory } from "../src/validator-operator-directory.ts";
import { buildGlobalValidators } from "../src/metagraph-neurons.ts";

function validator(overrides: Record<string, unknown> = {}) {
  return {
    hotkey: "hk-a",
    coldkey: "ck-a",
    coldkey_count: 1,
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
  test("preserves observed ownership from the complete neuron snapshot through the compact projection", () => {
    const rows = [
      { hotkey: "hk-a", coldkey: "owner-a", netuid: 1 },
      { hotkey: "hk-b", coldkey: "owner-a", netuid: 1 },
      { hotkey: "hk-c", coldkey: "owner-b", netuid: 1 },
      { hotkey: "hk-conflict", coldkey: "owner-a", netuid: 1 },
      { hotkey: "hk-conflict", coldkey: "owner-b", netuid: 2 },
      { hotkey: "hk-unknown", coldkey: null, netuid: 1 },
    ].map((row, uid) => ({ ...row, uid }));
    const global = buildGlobalValidators(rows, {
      includeAll: true,
      priceByNetuid: new Map(),
      identityByColdkey: new Map([
        ["owner-a", { name: "Shared Name" }],
        ["owner-b", { name: "Shared Name" }],
      ]),
      nominatorCounts: new Map([
        ["hk-a", 3],
        ["hk-b", 3],
        ["hk-c", 4],
      ]),
    });
    const directory = buildValidatorOperatorDirectory(global);
    assert.equal(directory.validator_count, 5);
    assert.equal(directory.operator_count, 4);
    const byId = new Map(
      directory.operators.map((operator) => [operator.operator_id, operator]),
    );
    assert.equal(byId.get("coldkey:owner-a")!.hotkey_count, 2);
    assert.equal(byId.get("coldkey:owner-a")!.identity_name, "Shared Name");
    assert.equal(byId.get("coldkey:owner-a")!.nominator_count, null);
    assert.equal(byId.get("coldkey:owner-b")!.identity_name, "Shared Name");
    assert.equal(byId.get("coldkey:owner-b")!.nominator_count, 4);
    assert.equal(byId.get("hotkey:hk-conflict")!.ownership_basis, "ambiguous");
    assert.equal(byId.get("hotkey:hk-unknown")!.ownership_basis, "unknown");
    ValidatorOperatorDirectoryArtifactSchema.parse(directory);
  });

  test("groups observed owners, keeps unknown owners separate and preserves existing metrics", () => {
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
        validator({
          hotkey: "anonymous-a",
          coldkey: null,
          coldkey_count: 0,
          total_stake_tao: 50,
          take: null,
        }),
        validator({
          hotkey: "anonymous-b",
          coldkey: null,
          coldkey_count: 0,
          total_stake_tao: 10,
          take: "",
        }),
      ],
    });

    assert.equal(directory.validator_count, 4);
    assert.equal(directory.operator_count, 3);
    assert.equal(directory.captured_at, "2026-08-29T00:00:00.000Z");
    assert.equal(directory.block_number, 8_950_000);

    const team = directory.operators[0]!;
    assert.equal(team.operator_id, "coldkey:ck-team");
    assert.equal(team.ownership_basis, "single_coldkey");
    assert.equal(team.identity_name, "Tensor Team");
    assert.equal(team.primary_hotkey, "hk-large");
    assert.equal(team.hotkey_count, 2);
    assert.deepEqual(
      team.hotkeys.map((key) => key.hotkey),
      ["hk-large", "hk-small"],
    );
    assert.equal(team.total_stake_tao, 100);
    assert.equal(team.total_emission_tao, 8);
    assert.equal(team.nominator_count, null);
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
    assert.ok(anonymous.every((entry) => entry.ownership_basis === "unknown"));
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

  test("matching declared names never merge different owners or unknown owners", () => {
    const directory = buildValidatorOperatorDirectory({
      validators: [
        validator({
          hotkey: "hk-a",
          coldkey: "ck-a",
          coldkey_identity: { has_identity: true, name: "Shared Name" },
        }),
        validator({
          hotkey: "hk-b",
          coldkey: "ck-b",
          coldkey_identity: { has_identity: true, name: "Shared Name" },
        }),
        validator({
          hotkey: "hk-c",
          coldkey: null,
          coldkey_count: 0,
          coldkey_identity: { has_identity: true, name: "Shared Name" },
        }),
        validator({
          hotkey: "hk-d",
          coldkey: null,
          coldkey_count: 0,
          coldkey_identity: { has_identity: true, name: "Shared Name" },
        }),
      ],
    });
    assert.equal(directory.operator_count, 4);
    assert.deepEqual(
      directory.operators.map(({ operator_id, hotkey_count }) => [
        operator_id,
        hotkey_count,
      ]),
      [
        ["coldkey:ck-a", 1],
        ["coldkey:ck-b", 1],
        ["hotkey:hk-c", 1],
        ["hotkey:hk-d", 1],
      ],
    );
    assert.ok(
      directory.operators.every(
        (entry) => entry.identity_name === "Shared Name",
      ),
    );
    ValidatorOperatorDirectoryArtifactSchema.parse(directory);
  });

  test("one observed owner's ID and members survive name changes, missing identity and a new primary", () => {
    const before = buildValidatorOperatorDirectory({
      validators: [
        validator({
          hotkey: "hk-a",
          total_stake_tao: 2,
          coldkey_identity: { has_identity: true, name: "Old Name" },
        }),
        validator({
          hotkey: "hk-b",
          total_stake_tao: 1,
          coldkey_identity: null,
        }),
      ],
    }).operators[0]!;
    const after = buildValidatorOperatorDirectory({
      validators: [
        validator({
          hotkey: "hk-b",
          total_stake_tao: 3,
          coldkey_identity: { has_identity: true, name: "New Name" },
        }),
        validator({
          hotkey: "hk-a",
          total_stake_tao: 2,
          coldkey_identity: { has_identity: false, name: "Old Name" },
        }),
      ],
    }).operators[0]!;
    assert.equal(before.operator_id, "coldkey:ck-a");
    assert.equal(after.operator_id, before.operator_id);
    assert.equal(before.identity_name, "Old Name");
    assert.equal(after.identity_name, "New Name");
    assert.equal(before.primary_hotkey, "hk-a");
    assert.equal(after.primary_hotkey, "hk-b");
    assert.equal(after.hotkey_count, 2);
    assert.deepEqual(
      after.hotkeys.map(({ hotkey }) => hotkey).sort(),
      before.hotkeys.map(({ hotkey }) => hotkey).sort(),
    );
  });

  test("keeps conflicting and unproven ownership hotkey-scoped", () => {
    const directory = buildValidatorOperatorDirectory({
      validators: [
        validator({ hotkey: "hk-known" }),
        validator({ hotkey: "hk-conflict", coldkey_count: 2 }),
        validator({ hotkey: "hk-missing-count", coldkey_count: undefined }),
        validator({ hotkey: "hk-missing-owner", coldkey: null }),
        validator({ hotkey: "hk-blank-owner", coldkey: " " }),
        validator({ hotkey: "hk-zero-count", coldkey_count: 0 }),
        validator({ hotkey: "hk-fractional-count", coldkey_count: 1.5 }),
        validator({ hotkey: "hk-malformed-count", coldkey_count: false }),
      ],
    });
    assert.equal(directory.operator_count, 8);
    for (const operator of directory.operators) {
      assert.equal(operator.hotkey_count, 1);
      if (operator.primary_hotkey === "hk-known") {
        assert.equal(operator.operator_id, "coldkey:ck-a");
        assert.equal(operator.ownership_basis, "single_coldkey");
      } else {
        assert.equal(operator.operator_id, `hotkey:${operator.primary_hotkey}`);
        assert.equal(
          operator.ownership_basis,
          operator.primary_hotkey === "hk-conflict" ? "ambiguous" : "unknown",
        );
      }
    }
    ValidatorOperatorDirectoryArtifactSchema.parse(directory);
  });

  test("namespaces owner and hotkey IDs and chooses ties independently of input order", () => {
    const rows = [
      validator({ hotkey: "hk-b", coldkey: "owner" }),
      validator({ hotkey: "hk-a", coldkey: "owner" }),
      validator({ hotkey: "owner", coldkey: null, coldkey_count: 0 }),
    ];
    const forward = buildValidatorOperatorDirectory({ validators: rows });
    const reverse = buildValidatorOperatorDirectory({
      validators: [...rows].reverse(),
    });
    assert.deepEqual(forward, reverse);
    assert.deepEqual(
      forward.operators.map(({ operator_id, primary_hotkey }) => [
        operator_id,
        primary_hotkey,
      ]),
      [
        ["coldkey:owner", "hk-a"],
        ["hotkey:owner", "owner"],
      ],
    );
    assert.deepEqual(
      forward.operators[0]!.hotkeys.map(({ hotkey }) => hotkey),
      ["hk-a", "hk-b"],
    );
  });

  test.each([
    [3, 3],
    [3, null],
    [null, 3],
    [null, null],
    [0, 0],
  ])(
    "does not invent a unique operator nominator count from member counts %s and %s",
    (first, second) => {
      const directory = buildValidatorOperatorDirectory({
        validators: [
          validator({ hotkey: "hk-a", nominator_count: first }),
          validator({ hotkey: "hk-b", nominator_count: second }),
        ],
      });
      assert.equal(directory.operator_count, 1);
      assert.equal(directory.operators[0]!.nominator_count, null);
      ValidatorOperatorDirectoryArtifactSchema.parse(directory);
    },
  );

  test.each([
    [0, 0],
    [7, 7],
    ["3", 3],
    [null, null],
    [undefined, null],
    ["", null],
    [-1, null],
    [1.5, null],
    [Number.POSITIVE_INFINITY, null],
    [true, null],
    [{}, null],
  ])(
    "preserves known singleton count %j as %s without turning invalid counts into zero",
    (input, expected) => {
      const directory = buildValidatorOperatorDirectory({
        validators: [validator({ nominator_count: input })],
      });
      assert.equal(directory.operators[0]!.nominator_count, expected);
      ValidatorOperatorDirectoryArtifactSchema.parse(directory);
    },
  );

  test("accepts cached entries without additive ownership metadata", () => {
    const directory = buildValidatorOperatorDirectory({
      validators: [validator()],
    });
    const {
      operator_id: _id,
      ownership_basis: _basis,
      ...legacy
    } = directory.operators[0]!;
    ValidatorOperatorDirectoryArtifactSchema.parse({
      ...directory,
      operators: [legacy],
    });
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
          coldkey: "ck-b",
          coldkey_identity: { has_identity: true, name: "   " },
        }),
        validator({ hotkey: "operator-c", coldkey: "ck-c" }),
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
