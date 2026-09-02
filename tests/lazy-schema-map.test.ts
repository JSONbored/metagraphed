import assert from "node:assert/strict";
import { test } from "vitest";
import { z } from "zod";
import { lazySchemaMap } from "../schemas-src/lazy-schema-map.ts";

test("enumerating routes does not construct their schemas; each is memoized on demand", () => {
  const calls: string[] = [];
  const schemas = lazySchemaMap({
    accounts: () => {
      calls.push("accounts");
      return z.object({ limit: z.int().max(20) });
    },
    validators: () => {
      calls.push("validators");
      return z.object({ hotkey: z.string() });
    },
  });
  assert.deepEqual(Object.keys(schemas), ["accounts", "validators"]);
  assert.deepEqual(calls, []);
  const accounts = schemas.accounts;
  assert.deepEqual(calls, ["accounts"]);
  assert.equal(accounts.safeParse({ limit: 21 }).success, false);
  assert.equal(schemas.accounts, accounts);
  assert.equal(
    schemas.validators.safeParse({ hotkey: "validator" }).success,
    true,
  );
  assert.deepEqual(calls, ["accounts", "validators"]);
});

test("a failed constructor is retried and does not poison other schemas", () => {
  let attempts = 0;
  const schemas = lazySchemaMap({
    route: () => {
      if (++attempts === 1) throw new Error("incomplete");
      return z.string();
    },
    other: () => z.int(),
  });
  assert.throws(() => schemas.route, /incomplete/);
  assert.equal(schemas.other.parse(1), 1);
  assert.equal(schemas.route.parse("ready"), "ready");
  assert.equal(attempts, 2);
});
