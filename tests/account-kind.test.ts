// Unit tests for src/account-kind.ts (#11573) -- the vocabulary that keeps two
// account id spaces from collapsing into one column.
//
// The whole module exists because `api_quota_daily`, `api_key_blocks` and
// `api_key_usage_daily` key on a bare integer with no foreign key, and there
// are now two tables minting those integers. A value that escapes this union
// would create a third, unqueryable id space -- so the narrowing is the guard,
// and it has to reject everything it does not recognise.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  ACCOUNT_KINDS,
  DEFAULT_ACCOUNT_KIND,
  asAccountKind,
} from "../src/account-kind.ts";

describe("ACCOUNT_KINDS", () => {
  test("names both identity systems and nothing else", () => {
    assert.deepEqual([...ACCOUNT_KINDS], ["rpc", "github"]);
  });

  test("the default is the one every pre-discriminator row belongs to", () => {
    // Every account id written before #11573 came from `rpc_accounts`, and the
    // migration's column default says so too. If these two ever disagree, rows
    // written by code and rows written by the database land in different
    // buckets -- which is the collision, reintroduced from the other side.
    assert.equal(DEFAULT_ACCOUNT_KIND, "rpc");
    assert.ok(
      (ACCOUNT_KINDS as readonly string[]).includes(DEFAULT_ACCOUNT_KIND),
    );
  });
});

describe("asAccountKind", () => {
  test("accepts every declared kind", () => {
    for (const kind of ACCOUNT_KINDS) {
      assert.equal(asAccountKind(kind), kind);
    }
  });

  test("rejects a string outside the vocabulary", () => {
    // Not defaulted. A caller that cannot say which identity system an id
    // belongs to must not have one guessed for it -- guessing is exactly how
    // two id spaces end up in one column.
    for (const value of [
      "",
      "RPC",
      "Github",
      "stripe",
      "wallet",
      "__proto__",
    ]) {
      assert.equal(asAccountKind(value), null, value);
    }
  });

  test("rejects every non-string", () => {
    for (const value of [
      undefined,
      null,
      0,
      1,
      true,
      false,
      {},
      [],
      ["rpc"],
      Symbol("rpc"),
    ]) {
      assert.equal(asAccountKind(value), null, String(value));
    }
  });

  test("does not inherit from Object.prototype", () => {
    // `includes` on a real array cannot walk the prototype chain, but pinning
    // it keeps a future refactor to a record-shaped lookup honest -- the same
    // class of bypass isBlockReasonCode guards against with Object.hasOwn.
    assert.equal(asAccountKind("constructor"), null);
    assert.equal(asAccountKind("toString"), null);
    assert.equal(asAccountKind("valueOf"), null);
  });
});
