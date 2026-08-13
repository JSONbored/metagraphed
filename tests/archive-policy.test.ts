// Every Neon table must state whether the archive wants it (#510).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  POLICY,
  PENDING_CEILING,
  compare,
  neonTables,
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

  test("pending is the debt list, and it is currently non-empty", () => {
    // A vacuous pass would be the failure mode here: if this ever reads zero
    // because the map emptied rather than because the debt was paid, the
    // ceiling test below stops proving anything.
    const pending = Object.entries(POLICY).filter(([, p]) => p === "pending");
    assert.ok(pending.length > 0, "pending must not be silently emptied");
    assert.equal(pending.length, PENDING_CEILING);
  });

  test("subnet_identity is pending, not mirrored", () => {
    // The sharpest omission: the archive holds subnet_identity_history but not
    // the current-state table it is the history OF.
    assert.equal(POLICY.subnet_identity, "pending");
    assert.equal(POLICY.subnet_identity_history, "mirrored");
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
});
