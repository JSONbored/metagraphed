import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  identityHash,
  recordAccountIdentityChanges,
} from "../src/account-identity-history.mjs";

function stagedRow(overrides = {}) {
  return {
    account: "5Acc0",
    name: "Example Team",
    url: "https://example.com",
    github: "example",
    image: "https://example.com/logo.png",
    discord: "example#0001",
    description: "An example subnet operator.",
    additional: null,
    captured_at: 1_700_000_000_000,
    ...overrides,
  };
}

function fakeDb({ latest = [], onBind } = {}) {
  const statements = [];
  return {
    db: {
      prepare(sql) {
        return {
          bind(...args) {
            if (onBind) onBind(sql, args);
            statements.push({ sql, args });
            return this;
          },
          all: async () => ({ results: latest }),
        };
      },
      batch: async (batch) => {
        statements.push({ batch: batch.length });
      },
    },
    statements,
  };
}

describe("identityHash", () => {
  test("is stable for the same snapshot", async () => {
    const snapshot = { name: "Example", url: "https://example.com" };
    const a = await identityHash(snapshot);
    const b = await identityHash(snapshot);
    assert.equal(a, b);
    assert.match(a, /^[a-f0-9]{64}$/);
  });

  test("is order-independent (stable stringify)", async () => {
    const a = await identityHash({ name: "Example", url: "https://x.com" });
    const b = await identityHash({ url: "https://x.com", name: "Example" });
    assert.equal(a, b);
  });

  test("changes when a tracked field changes", async () => {
    const a = await identityHash({ name: "Example" });
    const b = await identityHash({ name: "Different" });
    assert.notEqual(a, b);
  });

  test("returns null for a null/undefined snapshot", async () => {
    assert.equal(await identityHash(null), null);
    assert.equal(await identityHash(undefined), null);
  });

  test("hashes an array-shaped value deterministically (stableStringify's array branch)", async () => {
    const a = await identityHash(["Example", "https://example.com"]);
    const b = await identityHash(["Example", "https://example.com"]);
    const c = await identityHash(["https://example.com", "Example"]);
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});

describe("recordAccountIdentityChanges", () => {
  test("inserts only when the hash changes", async () => {
    const { db, statements } = fakeDb({
      latest: [{ account: "5Acc0", identity_hash: "old" }],
    });
    const result = await recordAccountIdentityChanges(
      {},
      { rows: [stagedRow()], now: 1_700_000_000_000, db },
    );
    assert.equal(result.recorded, true);
    assert.equal(result.rows, 1);
    const insert = statements.find((entry) => entry.sql?.includes("INSERT"));
    assert.ok(insert);
    // account, observed_at are the first two bound values.
    assert.equal(insert.args[0], "5Acc0");
    assert.equal(insert.args[1], 1_700_000_000_000);
  });

  test("skips unchanged identity fields", async () => {
    const row = stagedRow();
    const { account: _account, captured_at: _captured_at, ...fields } = row;
    const hash = await identityHash(fields);
    const { db, statements } = fakeDb({
      latest: [{ account: "5Acc0", identity_hash: hash }],
    });
    const result = await recordAccountIdentityChanges({}, { rows: [row], db });
    assert.equal(result.rows, 0);
    assert.equal(
      statements.some((s) => s.sql?.includes("INSERT")),
      false,
    );
  });

  test("appends a new row when a tracked field changes", async () => {
    const row = stagedRow();
    const { account: _account, captured_at: _captured_at, ...fields } = row;
    const staleHash = await identityHash({ ...fields, name: "Old Name" });
    const { db, statements } = fakeDb({
      latest: [{ account: "5Acc0", identity_hash: staleHash }],
    });
    const result = await recordAccountIdentityChanges({}, { rows: [row], db });
    assert.equal(result.rows, 1);
    assert.ok(statements.some((s) => s.sql?.includes("INSERT")));
  });

  test("skips a row with a missing or non-string account", async () => {
    const { db, statements } = fakeDb();
    const result = await recordAccountIdentityChanges(
      {},
      { rows: [stagedRow({ account: "" }), stagedRow({ account: 5 })], db },
    );
    assert.equal(result.rows, 0);
    assert.equal(
      statements.some((s) => s.sql?.includes("INSERT")),
      false,
    );
  });

  test("falls back to null for a missing optional identity field", async () => {
    const { db, statements } = fakeDb();
    await recordAccountIdentityChanges(
      {},
      { rows: [stagedRow({ name: null })], db },
    );
    const insert = statements.find((entry) => entry.sql?.includes("INSERT"));
    // account, observed_at, name is the third bound column.
    assert.equal(insert.args[2], null);
  });

  test("ignores an empty-string account cell when reading latest hashes", async () => {
    // A blank account cell must never suppress a real change for that row —
    // mirrors subnet-hyperparams-history's negative-netuid guard test.
    const { db, statements } = fakeDb({
      latest: [{ account: "", identity_hash: "junk" }],
    });
    const result = await recordAccountIdentityChanges(
      {},
      { rows: [stagedRow()], db },
    );
    assert.equal(result.rows, 1);
    assert.ok(statements.some((s) => s.sql?.includes("INSERT")));
  });

  test("tolerates a missing results array in the latest-hash read", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          all: async () => undefined,
        };
      },
      batch: async () => {},
    };
    const result = await recordAccountIdentityChanges(
      {},
      { rows: [stagedRow()], db },
    );
    assert.equal(result.recorded, true);
    assert.equal(result.rows, 1);
  });

  test("returns unavailable when rows are missing or empty", async () => {
    assert.deepEqual(await recordAccountIdentityChanges({}, { rows: [] }), {
      recorded: false,
      reason: "unavailable",
    });
    assert.deepEqual(await recordAccountIdentityChanges({}, {}), {
      recorded: false,
      reason: "unavailable",
    });
  });

  test("uses env.METAGRAPH_HEALTH_DB when db is not passed explicitly", async () => {
    const { db } = fakeDb();
    const result = await recordAccountIdentityChanges(
      { METAGRAPH_HEALTH_DB: db },
      { rows: [stagedRow()] },
    );
    assert.equal(result.recorded, true);
  });

  test("returns read_failed when the latest-hash query throws", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          all: async () => {
            throw new Error("read failed");
          },
        };
      },
    };
    assert.deepEqual(
      await recordAccountIdentityChanges({}, { rows: [stagedRow()], db }),
      { recorded: false, reason: "read_failed" },
    );
  });

  test("returns write_failed when the insert batch throws", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          all: async () => ({ results: [] }),
        };
      },
      batch: async () => {
        throw new Error("write failed");
      },
    };
    assert.deepEqual(
      await recordAccountIdentityChanges({}, { rows: [stagedRow()], db }),
      { recorded: false, reason: "write_failed" },
    );
  });

  test("returns write_failed when building a statement throws (never propagates to the caller)", async () => {
    // A throw from stmt.bind() itself (not the later db.batch() write) — the
    // "never fail the load" invariant (staging.mjs) depends on this loop
    // catching its own errors, same as the read/write calls around it.
    const db = {
      prepare() {
        return {
          bind() {
            throw new Error("bind failed");
          },
          all: async () => ({ results: [] }),
        };
      },
      batch: async () => {
        throw new Error("should not reach batch");
      },
    };
    assert.deepEqual(
      await recordAccountIdentityChanges({}, { rows: [stagedRow()], db }),
      { recorded: false, reason: "write_failed" },
    );
  });

  test("processes multiple accounts independently", async () => {
    const { db, statements } = fakeDb();
    const result = await recordAccountIdentityChanges(
      {},
      {
        rows: [
          stagedRow({ account: "5Acc0" }),
          stagedRow({ account: "5Acc1" }),
        ],
        db,
      },
    );
    assert.equal(result.rows, 2);
    const inserts = statements.filter((s) => s.sql?.includes("INSERT"));
    assert.equal(inserts.length, 2);
    assert.deepEqual(inserts.map((i) => i.args[0]).sort(), ["5Acc0", "5Acc1"]);
  });
});
