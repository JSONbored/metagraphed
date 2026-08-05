// src/sync-row-schemas.ts (#9564) — the zod schemas that replaced the seven
// `valid*SyncRow` boolean predicates on the internal sync routes.
//
// The point of the change was DIAGNOSIS, not stricter validation: a batch of up
// to 50,000 rows used to be rejected with one sentence and no coordinates, from
// a producer whose stdout is unreachable. So this file tests two things, and the
// first matters more than the second:
//
//   1. EQUIVALENCE. Every rule the predicate enforced still rejects. A rule that
//      silently stopped rejecting is the one regression that matters on a write
//      path into D1 — a loosened schema does not fail loudly, it just lets a bad
//      row through months later.
//   2. The rejection now names the row index and the field.
//
// The accept-cases are as load-bearing as the reject-cases: a schema that
// rejects everything would pass every "must reject" assertion on its own.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  accountBalanceSyncRowSchema,
  accountIdentitySyncRowSchema,
  hotkeyAlphaSyncRowSchema,
  neuronSyncRowSchema,
  nominatorCountSyncRowSchema,
  nominatorPositionSyncRowSchema,
  subnetHyperparamsSyncRowSchema,
  validateSyncRows,
} from "../src/sync-row-schemas.ts";

/** Well clear of the seconds/milliseconds floor the real routes use. */
const CAPTURED_AT = 1_785_715_160_521;
const MIN_CAPTURED_AT = 1_600_000_000_000;

function rejects(
  schema: { safeParse(v: unknown): { success: boolean } },
  row: unknown,
) {
  return !schema.safeParse(row).success;
}

describe("neuron sync rows", () => {
  const schema = neuronSyncRowSchema({
    columns: ["netuid", "uid", "hotkey", "stake_tao", "captured_at"],
    minCapturedAtMs: MIN_CAPTURED_AT,
    maxNetuid: 65_535,
    maxUid: 65_535,
    maxStringBytes: 512,
  });
  const valid = {
    netuid: 7,
    uid: 3,
    hotkey: "5Hot",
    stake_tao: 12.5,
    captured_at: CAPTURED_AT,
  };

  test("accepts a well-formed row", () => {
    assert.equal(schema.safeParse(valid).success, true);
  });

  test("rejects everything the predicate rejected", () => {
    assert.ok(rejects(schema, { ...valid, netuid: -1 }), "negative netuid");
    assert.ok(rejects(schema, { ...valid, netuid: 65_536 }), "netuid over cap");
    assert.ok(rejects(schema, { ...valid, netuid: 1.5 }), "non-integer netuid");
    assert.ok(rejects(schema, { ...valid, uid: -1 }), "negative uid");
    assert.ok(rejects(schema, { ...valid, uid: 65_536 }), "uid over cap");
    assert.ok(rejects(schema, { ...valid, unknown_col: 1 }), "unknown column");
    assert.ok(
      rejects(schema, { ...valid, hotkey: "x".repeat(513) }),
      "string over the byte cap",
    );
    assert.ok(
      rejects(schema, { ...valid, stake_tao: Number.POSITIVE_INFINITY }),
      "non-finite number",
    );
    assert.ok(rejects(schema, { ...valid, hotkey: { a: 1 } }), "nested object");
    assert.ok(rejects(schema, { ...valid, hotkey: [1] }), "array value");
    assert.ok(rejects(schema, [valid]), "an array is not a row");
  });

  // The cap is UTF-8 BYTES. A `.length` check would accept this: 200 code
  // units, 600 bytes.
  test("measures the string cap in bytes, not code units", () => {
    assert.ok(rejects(schema, { ...valid, hotkey: "€".repeat(200) }));
    assert.equal(
      schema.safeParse({ ...valid, hotkey: "€".repeat(100) }).success,
      true,
    );
  });

  // The rule that exists because one row reached production this way.
  test("rejects a seconds-precision captured_at", () => {
    assert.ok(rejects(schema, { ...valid, captured_at: 1_785_715_160 }));
  });

  test("accepts null in an optional column", () => {
    assert.equal(schema.safeParse({ ...valid, hotkey: null }).success, true);
  });
});

describe("subnet-hyperparams sync rows", () => {
  const schema = subnetHyperparamsSyncRowSchema({
    columns: ["netuid", "tempo", "captured_at"],
    minCapturedAtMs: MIN_CAPTURED_AT,
    maxNetuid: 65_535,
  });
  const valid = { netuid: 7, tempo: 360, captured_at: CAPTURED_AT };

  test("accepts numeric-or-null columns and rejects the rest", () => {
    assert.equal(schema.safeParse(valid).success, true);
    assert.equal(schema.safeParse({ ...valid, tempo: null }).success, true);
    // This route takes no strings at all — the predicate's distinguishing rule.
    assert.ok(rejects(schema, { ...valid, tempo: "360" }), "string value");
    assert.ok(rejects(schema, { ...valid, tempo: Number.NaN }), "NaN");
    assert.ok(rejects(schema, { ...valid, netuid: 65_536 }), "netuid over cap");
    assert.ok(rejects(schema, { ...valid, other: 1 }), "unknown column");
  });
});

describe("account-identity sync rows", () => {
  const schema = accountIdentitySyncRowSchema({
    columns: ["account", "name", "captured_at"],
    maxStringBytes: 1024,
  });
  const valid = { account: "5Acct", name: "tao.bot", captured_at: CAPTURED_AT };

  test("accepts string-or-null columns and rejects the rest", () => {
    assert.equal(schema.safeParse(valid).success, true);
    assert.equal(schema.safeParse({ ...valid, name: null }).success, true);
    assert.ok(rejects(schema, { ...valid, account: "" }), "empty account");
    assert.ok(rejects(schema, { ...valid, name: 7 }), "numeric value");
    assert.ok(
      rejects(schema, { ...valid, name: "x".repeat(1025) }),
      "string over the byte cap",
    );
    assert.ok(rejects(schema, { ...valid, other: "x" }), "unknown column");
  });

  // Deliberately NOT the epoch-ms floor: this one route used Number.isFinite,
  // and preserving that is the whole point of an equivalence test.
  test("keeps this route's looser captured_at rule", () => {
    assert.equal(schema.safeParse({ ...valid, captured_at: 1 }).success, true);
    assert.ok(rejects(schema, { ...valid, captured_at: "now" }));
  });
});

describe("nominator-count sync rows", () => {
  const schema = nominatorCountSyncRowSchema({
    columns: ["hotkey", "nominator_count", "captured_at"],
    minCapturedAtMs: MIN_CAPTURED_AT,
    maxKeyBytes: 128,
  });
  const valid = {
    hotkey: "5Hot",
    nominator_count: 12,
    captured_at: CAPTURED_AT,
  };

  test("accepts a well-formed row and rejects the predicate's cases", () => {
    assert.equal(schema.safeParse(valid).success, true);
    assert.ok(rejects(schema, { ...valid, hotkey: "" }), "empty hotkey");
    assert.ok(
      rejects(schema, { ...valid, hotkey: "x".repeat(129) }),
      "key over cap",
    );
    assert.ok(
      rejects(schema, { ...valid, nominator_count: -1 }),
      "negative count",
    );
    assert.ok(
      rejects(schema, { ...valid, nominator_count: 1.5 }),
      "fractional count",
    );
    assert.ok(rejects(schema, { ...valid, other: 1 }), "unknown column");
  });
});

describe("nominator-position sync rows", () => {
  const schema = nominatorPositionSyncRowSchema({
    columns: ["coldkey", "hotkey", "netuid", "share_fraction", "captured_at"],
    minCapturedAtMs: MIN_CAPTURED_AT,
    maxKeyBytes: 128,
    maxNetuid: 65_535,
  });
  const valid = {
    coldkey: "5Cold",
    hotkey: "5Hot",
    netuid: 7,
    share_fraction: 0.25,
    captured_at: CAPTURED_AT,
  };

  test("bounds share_fraction to a real 0..1 slice", () => {
    assert.equal(schema.safeParse(valid).success, true);
    assert.equal(
      schema.safeParse({ ...valid, share_fraction: 0 }).success,
      true,
    );
    assert.equal(
      schema.safeParse({ ...valid, share_fraction: 1 }).success,
      true,
    );
    assert.ok(rejects(schema, { ...valid, share_fraction: -0.1 }), "below 0");
    assert.ok(rejects(schema, { ...valid, share_fraction: 1.1 }), "above 1");
    assert.ok(
      rejects(schema, { ...valid, share_fraction: Number.NaN }),
      "NaN share",
    );
  });

  test("requires both keys", () => {
    assert.ok(rejects(schema, { ...valid, coldkey: "" }), "empty coldkey");
    assert.ok(rejects(schema, { ...valid, hotkey: "" }), "empty hotkey");
  });
});

describe("account-balance sync rows", () => {
  const schema = accountBalanceSyncRowSchema({
    columns: ["ss58", "free_tao", "reserved_tao", "captured_at"],
    minCapturedAtMs: MIN_CAPTURED_AT,
    maxKeyBytes: 128,
  });
  const valid = {
    ss58: "5Acct",
    free_tao: 10,
    reserved_tao: 0,
    captured_at: CAPTURED_AT,
  };

  test("requires both amounts to be non-negative and finite", () => {
    assert.equal(schema.safeParse(valid).success, true);
    assert.ok(rejects(schema, { ...valid, free_tao: -1 }), "negative free_tao");
    assert.ok(
      rejects(schema, { ...valid, reserved_tao: -1 }),
      "negative reserved",
    );
    assert.ok(
      rejects(schema, { ...valid, free_tao: Number.POSITIVE_INFINITY }),
      "infinite free_tao",
    );
    assert.ok(rejects(schema, { ...valid, free_tao: "10" }), "string amount");
  });
});

describe("hotkey-alpha sync rows", () => {
  const schema = hotkeyAlphaSyncRowSchema({
    columns: ["hotkey", "netuid", "total_alpha", "captured_at"],
    minCapturedAtMs: MIN_CAPTURED_AT,
    maxKeyBytes: 128,
  });
  const valid = {
    hotkey: "5Hot",
    netuid: 7,
    total_alpha: 1234.5,
    captured_at: CAPTURED_AT,
  };

  test("accepts the composite identity and rejects the predicate's cases", () => {
    assert.equal(schema.safeParse(valid).success, true);
    assert.ok(rejects(schema, { ...valid, netuid: -1 }), "negative netuid");
    assert.ok(rejects(schema, { ...valid, netuid: 1.5 }), "fractional netuid");
    assert.ok(rejects(schema, { ...valid, total_alpha: -1 }), "negative alpha");
    assert.ok(rejects(schema, { ...valid, hotkey: "" }), "empty hotkey");
  });

  // This route deliberately has no netuid ceiling — the predicate had none, and
  // inventing one here would be a silent narrowing of a write path.
  test("keeps this route's absent netuid ceiling", () => {
    assert.equal(schema.safeParse({ ...valid, netuid: 999_999 }).success, true);
  });
});

describe("validateSyncRows reports coordinates, which is the point", () => {
  const schema = nominatorCountSyncRowSchema({
    columns: ["hotkey", "nominator_count", "captured_at"],
    minCapturedAtMs: MIN_CAPTURED_AT,
    maxKeyBytes: 128,
  });
  const good = { hotkey: "5Hot", nominator_count: 1, captured_at: CAPTURED_AT };

  test("names the failing row index and field", () => {
    const result = validateSyncRows(
      [good, good, { ...good, nominator_count: -1 }],
      schema,
      "nominator count",
    );
    assert.equal(result.ok, false);
    assert.match(
      (result as { error: string }).error,
      /^row 2: nominator_count /,
      "the operator needs the index AND the field, not just a shape name",
    );
  });

  test("names the offending key for an unknown column", () => {
    const result = validateSyncRows(
      [{ ...good, bogus: 1 }],
      schema,
      "nominator count",
    );
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /row 0: bogus /);
  });

  // The root-path branch: when the failure is the ROW itself rather than a
  // field, there is no path to name, so the message says so instead of
  // printing an empty field name.
  test("says `row` when the row itself is the problem, not a field", () => {
    for (const bad of [null, "nope", [good], 7]) {
      const result = validateSyncRows([bad], schema, "nominator count");
      assert.equal(result.ok, false, JSON.stringify(bad));
      assert.match((result as { error: string }).error, /^row 0: row /);
    }
  });

  test("accepts a fully valid batch", () => {
    assert.deepEqual(
      validateSyncRows([good, good], schema, "nominator count"),
      {
        ok: true,
      },
    );
  });

  // Unchanged from the predicates: an empty batch is a client error, and the
  // message stays the old shape-level one because there is no row to point at.
  test("still rejects an empty batch with the shape-level message", () => {
    const result = validateSyncRows([], schema, "nominator count");
    assert.equal(result.ok, false);
    assert.equal(
      (result as { error: string }).error,
      "rows must match the nominator count row shape",
    );
  });
});
