import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  buildSubnetIdentityHistory,
  derivePreviouslyKnownAs,
  formatIdentityHistoryEntry,
  identityHash,
  identitySnapshotFromProfile,
  loadPreviouslyKnownAs,
  loadPreviouslyKnownAsForNetuids,
  loadSubnetIdentityHistory,
  overlayPreviouslyKnownAs,
  recordSubnetIdentityChanges,
} from "../src/subnet-identity-history.mjs";
import { encodeCursor } from "../src/cursor.mjs";

function identityHistoryRow(overrides = {}) {
  return {
    id: 10,
    block_number: 100,
    observed_at: 1_700_000_000_000,
    subnet_name: "MIAO",
    symbol: "α",
    description: "old",
    github_repo: null,
    subnet_url: null,
    discord: null,
    logo_url: null,
    identity_hash: "abc",
    ...overrides,
  };
}

describe("identitySnapshotFromProfile", () => {
  test("maps native_identity + symbol into the tracked hash payload", () => {
    assert.deepEqual(
      identitySnapshotFromProfile({
        netuid: 86,
        symbol: "α",
        native_identity: {
          subnet_name: "MIAO",
          description: "sound AI",
          github_url: "https://github.com/example/miao",
          website_url: "https://miao.example",
          discord: "miao",
          logo_url: "https://miao.example/logo.png",
        },
      }),
      {
        subnet_name: "MIAO",
        symbol: "α",
        description: "sound AI",
        github_repo: "https://github.com/example/miao",
        subnet_url: "https://miao.example",
        discord: "miao",
        logo_url: "https://miao.example/logo.png",
      },
    );
  });

  test("returns null when native_identity is absent", () => {
    assert.equal(identitySnapshotFromProfile({ netuid: 1 }), null);
  });
});

describe("identityHash", () => {
  test("is stable for the same snapshot", async () => {
    const snapshot = {
      subnet_name: "Apex",
      symbol: "α",
      description: "competitions",
      github_repo: "https://github.com/example/apex",
      subnet_url: "https://apex.example",
      discord: "macrocrux",
      logo_url: null,
    };
    const a = await identityHash(snapshot);
    const b = await identityHash(snapshot);
    assert.equal(a, b);
    assert.match(a, /^[a-f0-9]{64}$/);
  });

  test("hashes nested arrays via stableStringify", async () => {
    const hash = await identityHash({ subnet_name: "X", tags: ["a", "b"] });
    assert.match(hash, /^[a-f0-9]{64}$/);
  });
});

describe("formatIdentityHistoryEntry", () => {
  test("formats D1 rows into API entries", () => {
    assert.deepEqual(
      formatIdentityHistoryEntry({
        id: 3,
        block_number: 123,
        observed_at: 1_700_000_000_000,
        subnet_name: "MIAO",
        symbol: "M",
        description: "old",
        github_repo: null,
        subnet_url: null,
        discord: null,
        logo_url: null,
        identity_hash: "abc",
      }),
      {
        block_number: 123,
        observed_at: "2023-11-14T22:13:20.000Z",
        subnet_name: "MIAO",
        symbol: "M",
        description: "old",
        github_repo: null,
        subnet_url: null,
        discord: null,
        logo_url: null,
        identity_hash: "abc",
      },
    );
  });
});

describe("derivePreviouslyKnownAs", () => {
  test("returns distinct prior names excluding the current one, newest first", () => {
    assert.deepEqual(
      derivePreviouslyKnownAs(
        [
          { subnet_name: "⚒", observed_at: 300 },
          { subnet_name: "The Alpha Arena", observed_at: 200 },
          { subnet_name: "MIAO", observed_at: 100 },
          { subnet_name: "MIAO", observed_at: 50 },
        ],
        "⚒",
      ),
      ["The Alpha Arena", "MIAO"],
    );
  });
});

describe("buildSubnetIdentityHistory", () => {
  test("wraps rows with pagination metadata", () => {
    const out = buildSubnetIdentityHistory(
      [
        {
          id: 2,
          block_number: null,
          observed_at: 2,
          subnet_name: "B",
          symbol: null,
          description: null,
          github_repo: null,
          subnet_url: null,
          discord: null,
          logo_url: null,
          identity_hash: "h2",
        },
      ],
      86,
      { limit: 100, offset: 0, nextCursor: "2.1" },
    );
    assert.equal(out.netuid, 86);
    assert.equal(out.entry_count, 1);
    assert.equal(out.next_cursor, "2.1");
    assert.equal(out.entries[0].subnet_name, "B");
  });
});

describe("overlayPreviouslyKnownAs", () => {
  test("adds previously_known_as only when aliases exist", () => {
    const detail = { netuid: 86, name: "⚒" };
    assert.deepEqual(overlayPreviouslyKnownAs(detail, []), detail);
    assert.deepEqual(overlayPreviouslyKnownAs(detail, ["MIAO"]), {
      ...detail,
      previously_known_as: ["MIAO"],
    });
  });
});

describe("recordSubnetIdentityChanges", () => {
  test("inserts only when the hash changes", async () => {
    const statements = [];
    const db = {
      prepare(sql) {
        return {
          bind(...args) {
            statements.push({ sql, args });
            return this;
          },
          all: async () => ({
            results: [{ netuid: 86, identity_hash: "old-hash" }],
          }),
        };
      },
      batch: async (batch) => {
        statements.push({ batch: batch.length });
      },
    };
    const profiles = [
      {
        netuid: 86,
        symbol: "α",
        native_identity: {
          subnet_name: "New Name",
          description: "changed",
          github_url: null,
          website_url: null,
          discord: null,
          logo_url: null,
        },
      },
    ];
    const result = await recordSubnetIdentityChanges(
      {},
      { profiles, now: 1_700_000_000_000, db },
    );
    assert.equal(result.recorded, true);
    assert.equal(result.rows, 1);
    assert.equal(
      statements.some((entry) => entry.sql?.includes("INSERT")),
      true,
    );
  });

  test("skips unchanged identities", async () => {
    const snapshot = identitySnapshotFromProfile({
      netuid: 7,
      symbol: "T",
      native_identity: {
        subnet_name: "Subnet",
        description: null,
        github_url: null,
        website_url: null,
        discord: null,
        logo_url: null,
      },
    });
    const hash = await identityHash(snapshot);
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          all: async () => ({
            results: [{ netuid: 7, identity_hash: hash }],
          }),
        };
      },
      batch: async () => {
        throw new Error("should not write");
      },
    };
    const result = await recordSubnetIdentityChanges(
      {},
      {
        profiles: [
          {
            netuid: 7,
            symbol: "T",
            native_identity: {
              subnet_name: "Subnet",
              description: null,
              github_url: null,
              website_url: null,
              discord: null,
              logo_url: null,
            },
          },
        ],
        db,
      },
    );
    assert.equal(result.rows, 0);
  });

  test("returns unavailable when profiles are missing", async () => {
    assert.deepEqual(await recordSubnetIdentityChanges({}, { profiles: [] }), {
      recorded: false,
      reason: "unavailable",
    });
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
      await recordSubnetIdentityChanges(
        {},
        {
          profiles: [
            {
              netuid: 7,
              native_identity: { subnet_name: "X" },
            },
          ],
          db,
        },
      ),
      { recorded: false, reason: "read_failed" },
    );
  });

  test("returns write_failed when the insert batch throws", async () => {
    const db = {
      prepare(sql) {
        return {
          bind() {
            return this;
          },
          all: async () => {
            if (/FROM blocks/.test(sql)) {
              return { results: [{ block_number: 123 }] };
            }
            return { results: [] };
          },
        };
      },
      batch: async () => {
        throw new Error("write failed");
      },
    };
    assert.deepEqual(
      await recordSubnetIdentityChanges(
        {},
        {
          profiles: [
            {
              netuid: 7,
              native_identity: { subnet_name: "Changed" },
            },
          ],
          db,
        },
      ),
      { recorded: false, reason: "write_failed" },
    );
  });

  test("tolerates a missing blocks table when resolving block_number", async () => {
    const binds = [];
    const db = {
      prepare(sql) {
        return {
          bind(...args) {
            if (/INSERT INTO subnet_identity_history/.test(sql)) {
              binds.push(args);
            }
            return this;
          },
          all: async () => {
            if (/FROM blocks/.test(sql)) {
              throw new Error("no blocks table");
            }
            return { results: [] };
          },
        };
      },
      batch: async () => {},
    };
    const result = await recordSubnetIdentityChanges(
      {},
      {
        profiles: [
          {
            netuid: 7,
            native_identity: { subnet_name: "First" },
          },
        ],
        db,
      },
    );
    assert.equal(result.recorded, true);
    assert.equal(result.rows, 1);
    assert.equal(binds[0]?.[1], null);
  });
});

describe("loadSubnetIdentityHistory", () => {
  test("paginates with offset when no cursor is provided", async () => {
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      return [identityHistoryRow()];
    };
    const out = await loadSubnetIdentityHistory(d1, 86, {
      limit: 10,
      offset: 5,
    });
    assert.equal(out.entry_count, 1);
    assert.ok(calls[0].sql.includes("OFFSET"));
    assert.equal(out.next_cursor, null);
  });

  test("uses cursor seek and emits next_cursor for a full page", async () => {
    const calls = [];
    const d1 = async (sql, params) => {
      calls.push({ sql, params });
      return [
        identityHistoryRow({ id: 9, observed_at: 1_600_000_000_000 }),
        identityHistoryRow({ id: 8, observed_at: 1_500_000_000_000 }),
      ];
    };
    const out = await loadSubnetIdentityHistory(d1, 86, {
      limit: 2,
      cursor: encodeCursor([1_700_000_000_000, 10]),
    });
    assert.ok(calls[0].sql.includes("(observed_at, id) <"));
    assert.equal(out.next_cursor, encodeCursor([1_500_000_000_000, 8]));
  });
});

describe("loadPreviouslyKnownAs", () => {
  test("loads grouped names from D1", async () => {
    const d1 = async () => [
      { subnet_name: "MIAO", observed_at: 2 },
      { subnet_name: "Arena", observed_at: 1 },
    ];
    assert.deepEqual(await loadPreviouslyKnownAs(d1, 86, "⚒"), [
      "MIAO",
      "Arena",
    ]);
  });
});

describe("loadPreviouslyKnownAsForNetuids", () => {
  test("returns an empty map when no netuids are provided", async () => {
    const map = await loadPreviouslyKnownAsForNetuids(async () => [], []);
    assert.equal(map.size, 0);
  });

  test("groups aliases per netuid", async () => {
    const d1 = async () => [
      { netuid: 86, subnet_name: "MIAO", observed_at: 2 },
      { netuid: 7, subnet_name: "Old7", observed_at: 1 },
    ];
    const map = await loadPreviouslyKnownAsForNetuids(d1, [
      { netuid: 86, name: "⚒" },
      { netuid: 7, name: "Current" },
    ]);
    assert.deepEqual(map.get(86), ["MIAO"]);
    assert.deepEqual(map.get(7), ["Old7"]);
  });
});
