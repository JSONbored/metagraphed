// Every Neon table must state whether the archive wants it (#510).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  POLICY,
  PENDING_CEILING,
  compare,
  neonTables,
  BUNDLE_CONTRACTS,
  BUNDLE_MAPPINGS,
} from "../scripts/validate-archive-policy.ts";

describe("archive policy", () => {
  test("an unclassified Neon table fails", () => {
    // The whole point: a new table cannot enter without someone saying what
    // happens to it. Silence used to mean "not archived" by default.
    const { unclassified } = compare(["subnets", "brand_new_table"]);
    assert.deepEqual(unclassified, ["brand_new_table"]);
  });

  test("a policy entry for a dropped table fails", () => {
    // A stale entry inflates the pending count and hides real debt, so the
    // ceiling would stop meaning anything.
    const { stale } = compare(["subnets"]);
    assert.ok(stale.includes("api_keys"));
    assert.ok(stale.length > 0);
  });

  test("pending matches the ceiling, and the ceiling is zero", () => {
    // This asserted pending was NON-empty, guarding against the map emptying
    // and making the ceiling vacuous. The debt is now genuinely paid, so the
    // guard inverts -- and the non-vacuity that matters moves to `mirrored`,
    // which must stay large or this gate is measuring nothing.
    const pending = Object.values(POLICY).filter((p) => p === "pending");
    assert.equal(pending.length, PENDING_CEILING);
    assert.equal(PENDING_CEILING, 0);
    const mirrored = Object.values(POLICY).filter((p) => p === "mirrored");
    assert.ok(mirrored.length > 30, `mirrored collapsed to ${mirrored.length}`);
  });

  test("subnet_identity is mirrored alongside its own history", () => {
    // This asserted `pending` when the archive held subnet_identity_history and
    // NOT the current-state table it is the history of -- so the lakehouse
    // could say what a subnet's identity used to be and not what it is. Closed
    // 2026-08-13; kept as a pair so the two can never drift apart again.
    assert.equal(POLICY.subnet_identity, "mirrored");
    assert.equal(POLICY.subnet_identity_history, "mirrored");
  });

  test("subnet_burn_history is mirrored via a composite watermark", () => {
    // The last debt, and it closed on a measurement rather than effort:
    // observed_at alone ties 94,208 times across 852 distinct values,
    // (observed_at, netuid) is unique across all 95,447 rows.
    assert.equal(POLICY.subnet_burn_history, "mirrored");
  });

  test("credentials and personal data are never archived", () => {
    for (const table of [
      "api_keys",
      "api_key_blocks",
      "github_accounts",
      "watch_push_subscriptions",
      "rpc_accounts",
    ]) {
      assert.equal(POLICY[table], "sensitive", `${table} must be sensitive`);
    }
  });

  test("every policy value is one of the declared kinds", () => {
    const kinds = new Set([
      "mirrored",
      "pending",
      "bundled",
      "serving",
      "sensitive",
      "transient",
      "meta",
    ]);
    for (const [table, policy] of Object.entries(POLICY)) {
      assert.ok(kinds.has(policy), `${table} has unknown policy ${policy}`);
    }
  });

  test("neonTables dedupes the column snapshot", () => {
    assert.deepEqual(
      neonTables([{ table: "b" }, { table: "a" }, { table: "b" }]),
      ["a", "b"],
    );
  });

  test("bundle support adds no production archive or table declaration", () => {
    assert.deepEqual(BUNDLE_CONTRACTS, {});
    assert.deepEqual(BUNDLE_MAPPINGS, []);
    assert.equal(Object.values(POLICY).includes("bundled"), false);
    assert.equal(PENDING_CEILING, 0);
  });
});
