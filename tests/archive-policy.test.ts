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

  test("subnet_identity is mirrored alongside its own history", () => {
    // This asserted `pending` when the archive held subnet_identity_history and
    // NOT the current-state table it is the history of -- so the lakehouse
    // could say what a subnet's identity used to be and not what it is. Closed
    // 2026-08-13; kept as a pair so the two can never drift apart again.
    assert.equal(POLICY.subnet_identity, "mirrored");
    assert.equal(POLICY.subnet_identity_history, "mirrored");
  });

  test("the one remaining debt is subnet_burn_history, and it is a decision", () => {
    // Not waiting on effort: 95,060 rows across 852 distinct observed_at
    // values means a `> since` watermark skips nearly everything, and
    // `versioned` would re-append all 95,060 on every change.
    assert.equal(POLICY.subnet_burn_history, "pending");
    assert.equal(PENDING_CEILING, 1);
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
