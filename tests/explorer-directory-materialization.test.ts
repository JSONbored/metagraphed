import assert from "node:assert/strict";
import { test, vi } from "vitest";

import {
  readCurrentAccountDirectory,
  readCurrentValidatorDirectory,
} from "../src/explorer-directory-current.ts";
import {
  KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT,
  KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT,
} from "../src/kv-keys.ts";

const capturedAt = "2026-08-29T00:00:00.000Z";

const accounts = {
  schema_version: 1 as const,
  captured_at: capturedAt,
  block_number: 8_950_000,
  account_count: 0,
  limit: 20 as const,
  priced_registered_stake_tao: 0,
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
