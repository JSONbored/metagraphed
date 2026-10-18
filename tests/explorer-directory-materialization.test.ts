import assert from "node:assert/strict";
import { test, vi } from "vitest";

import {
  readCurrentAccountDirectory,
  readCurrentValidatorDirectory,
} from "../src/explorer-directory-current.ts";
import {
  KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT,
  KV_EXPLORER_DIRECTORIES_CURRENT,
  KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT,
} from "../src/kv-keys.ts";
import {
  materializationFromUnknown,
  readExplorerDirectoryMaterialization,
} from "../src/explorer-directory-materialization.ts";

const capturedAt = new Date().toISOString();

const accounts = {
  schema_version: 1 as const,
  captured_at: capturedAt,
  block_number: 8_950_000,
  account_count: 0,
  limit: 20 as const,
  priced_registered_stake_tao: null,
  rankings: { stake: [], emission: [], reach: [] },
};

const validators = {
  schema_version: 1 as const,
  captured_at: capturedAt,
  block_number: 8_950_000,
  validator_count: 0,
  operator_count: 0,
  operators: [],
};

test("route-specific directory readers fetch and validate exactly one KV value", async () => {
  const reads: string[] = [];
  const kv = {
    async get(key: string) {
      reads.push(key);
      return key === KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT
        ? accounts
        : validators;
    },
  };

  assert.deepEqual(await readCurrentAccountDirectory(kv), accounts);
  assert.deepEqual(await readCurrentValidatorDirectory(kv), validators);
  assert.deepEqual(reads, [
    KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT,
    KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT,
  ]);
});

test("route-specific directory readers decline absent or malformed values", async () => {
  assert.equal(await readCurrentAccountDirectory(null), null);
  assert.equal(
    await readCurrentValidatorDirectory({
      get: async () => ({ broken: true }),
    }),
    null,
  );
});

test("route-specific directory readers contain KV failures", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  assert.equal(
    await readCurrentAccountDirectory({
      get: async () => {
        throw new Error("offline");
      },
    }),
    null,
  );
  assert.equal(error.mock.calls.length, 1);
  error.mockRestore();
});

test("old or future directory snapshots fall through to the source repair path", async () => {
  for (const captured_at of [
    new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    null,
  ]) {
    assert.equal(
      await readCurrentAccountDirectory({
        get: async () => ({ ...accounts, captured_at }),
      }),
      null,
    );
    assert.equal(
      await readCurrentValidatorDirectory({
        get: async () => ({ ...validators, captured_at }),
      }),
      null,
    );
  }
});

test("legacy capital-ranked directories decline until the source republishes neutral membership", async () => {
  const legacy = {
    ...validators,
    validator_count: 2,
    operator_count: 1,
    operators: [
      {
        operator_id: "coldkey:owner",
        ownership_basis: "single_coldkey" as const,
        identity_name: "Declared operator",
        hotkeys: [
          { hotkey: "hk-b", total_stake_tao: 900, take: 0.1 },
          { hotkey: "hk-a", total_stake_tao: 100, take: 0.2 },
        ],
        hotkey_count: 2,
        primary_hotkey: "hk-b",
        coldkey: "owner",
        total_stake_tao: 1000,
        total_emission_tao: 4,
        nominator_count: null,
        membership_count: 3,
        uid_count: 3,
        take_min: 0.1,
        take_max: 0.2,
        apy_estimate: 0.12,
        stake_dominance: 1,
      },
    ],
  };
  const expected = {
    ...legacy,
    operators: legacy.operators.map((operator) => ({
      ...operator,
      primary_hotkey: "hk-a",
      total_stake_tao: null,
      apy_estimate: null,
      stake_dominance: null,
      hotkeys: [
        { hotkey: "hk-a", total_stake_tao: null, take: 0.2 },
        { hotkey: "hk-b", total_stake_tao: null, take: 0.1 },
      ],
    })),
  };
  assert.equal(
    await readCurrentValidatorDirectory({ get: async () => legacy }),
    null,
  );
  const stamp = Date.parse(capturedAt);
  const materialization = {
    schema_version: 1,
    captured_at: stamp,
    accounts,
    validators: legacy,
  };
  assert.equal(materializationFromUnknown(materialization), null);
  assert.equal(
    await readExplorerDirectoryMaterialization({
      get: async (key: string) =>
        key === KV_EXPLORER_DIRECTORIES_CURRENT
          ? { schema_version: 1, captured_at: stamp }
          : materialization,
    } as never),
    null,
  );
  assert.deepEqual(
    await readCurrentValidatorDirectory({ get: async () => expected }),
    expected,
  );
  assert.deepEqual(
    materializationFromUnknown({ ...materialization, validators: expected }),
    { ...materialization, validators: expected },
  );
  assert.equal(legacy.operators[0]!.total_stake_tao, 1000);
  assert.equal(legacy.operators[0]!.hotkeys[0]!.total_stake_tao, 900);
});

test("account cache readers decline financially selected directories, including zero and stripped stake ranks", async () => {
  const row = {
    hotkey: "hk-a",
    coldkey: "owner",
    subnet_count: 3,
    uid_count: 4,
    total_stake_tao: null,
    total_emission_tao: 8,
    stake_dominance: null,
  };
  const fresh = {
    ...accounts,
    account_count: 1,
    rankings: { stake: [], emission: [row], reach: [row] },
  };
  const materialization = {
    schema_version: 1,
    captured_at: Date.parse(capturedAt),
    accounts: fresh,
    validators,
  };
  for (const legacy of [
    { ...fresh, priced_registered_stake_tao: 0 },
    { ...fresh, rankings: { ...fresh.rankings, stake: [row] } },
    {
      ...fresh,
      rankings: {
        ...fresh.rankings,
        emission: [{ ...row, total_stake_tao: 0 }],
      },
    },
    {
      ...fresh,
      rankings: { ...fresh.rankings, reach: [{ ...row, stake_dominance: 0 }] },
    },
  ]) {
    assert.equal(
      await readCurrentAccountDirectory({ get: async () => legacy }),
      null,
    );
    assert.equal(
      materializationFromUnknown({ ...materialization, accounts: legacy }),
      null,
    );
  }
  assert.deepEqual(
    await readCurrentAccountDirectory({ get: async () => fresh }),
    fresh,
  );
  assert.deepEqual(
    materializationFromUnknown(materialization),
    materialization,
  );
  assert.equal(fresh.rankings.emission[0]!.total_emission_tao, 8);
});
