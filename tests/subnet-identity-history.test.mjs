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
        subnet_url: "https://miao.example/",
        discord: "miao",
        logo_url: "https://miao.example/logo.png",
      },
    );
  });

  test("returns null when native_identity is absent", () => {
    assert.equal(identitySnapshotFromProfile({ netuid: 1 }), null);
  });

  test("prefers discord_url when discord handle is absent", () => {
    const snapshot = identitySnapshotFromProfile({
      netuid: 1,
      native_identity: {
        discord_url: "https://discord.gg/example",
      },
    });
    assert.equal(snapshot.discord, "https://discord.gg/example");
  });

  test("nulls malformed or placeholder on-chain links before hashing", () => {
    assert.deepEqual(
      identitySnapshotFromProfile({
        netuid: 1,
        native_identity: {
          github_url: "not-a-uri",
          website_url: "javascript:alert(1)",
          discord: "x".repeat(201),
          logo_url: "https://deprecated.png/logo.png",
        },
      }),
      {
        subnet_name: null,
        symbol: null,
        description: null,
        github_repo: null,
        subnet_url: null,
        discord: null,
        logo_url: null,
      },
    );
  });

  test("normalizes valid on-chain links and discord handles in the snapshot", () => {
    assert.deepEqual(
      identitySnapshotFromProfile({
        netuid: 86,
        symbol: "α",
        native_identity: {
          github_url: "github.com/example/repo",
          website_url: "https://miao.example/",
          discord: "macrocrux",
          logo_url: "https://miao.example/logo.png",
        },
      }),
      {
        subnet_name: null,
        symbol: "α",
        description: null,
        github_repo: "https://github.com/example/repo",
        subnet_url: "https://miao.example/",
        discord: "macrocrux",
        logo_url: "https://miao.example/logo.png",
      },
    );
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

  test("hashes nested objects via stableStringify", async () => {
    const hash = await identityHash({
      subnet_name: "X",
      meta: { tier: "chain", flags: [1, 2] },
    });
    assert.match(hash, /^[a-f0-9]{64}$/);
  });

  test("returns null for a null snapshot", async () => {
    assert.equal(await identityHash(null), null);
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

  test("returns null for invalid rows", () => {
    assert.equal(formatIdentityHistoryEntry(null), null);
    assert.equal(formatIdentityHistoryEntry(undefined), null);
    assert.equal(formatIdentityHistoryEntry("nope"), null);
  });

  test("defaults identity_hash to null when absent", () => {
    const out = formatIdentityHistoryEntry({
      block_number: 1,
      observed_at: 1_700_000_000_000,
      subnet_name: "MIAO",
    });
    assert.equal(out.identity_hash, null);
  });

  test("nulls invalid block numbers and observed_at values", () => {
    const out = formatIdentityHistoryEntry({
      block_number: "nope",
      observed_at: 0,
      identity_hash: "abc",
    });
    assert.equal(out.block_number, null);
    assert.equal(out.observed_at, null);
  });

  test("sanitizes URI and discord fields to match the published contract", () => {
    const out = formatIdentityHistoryEntry({
      block_number: 1,
      observed_at: 1_700_000_000_000,
      subnet_name: "X",
      github_repo: "not-a-uri",
      subnet_url: "javascript:alert(1)",
      discord: "x".repeat(201),
      logo_url: "https://deprecated.png/logo.png",
      identity_hash: "abc",
    });
    assert.equal(out.github_repo, null);
    assert.equal(out.subnet_url, null);
    assert.equal(out.discord, null);
    assert.equal(out.logo_url, null);
  });

  test("normalizes valid on-chain identity links and discord handles", () => {
    const out = formatIdentityHistoryEntry({
      block_number: 1,
      observed_at: 1_700_000_000_000,
      github_repo: "github.com/example/repo",
      subnet_url: "https://miao.example/",
      discord: "macrocrux",
      logo_url: "https://miao.example/logo.png",
      identity_hash: "abc",
    });
    assert.equal(out.github_repo, "https://github.com/example/repo");
    assert.equal(out.subnet_url, "https://miao.example/");
    assert.equal(out.discord, "macrocrux");
    assert.equal(out.logo_url, "https://miao.example/logo.png");
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

  test("skips blank names and the current name", () => {
    assert.deepEqual(
      derivePreviouslyKnownAs(
        [{ subnet_name: "  " }, { subnet_name: "Current" }],
        "Current",
      ),
      [],
    );
  });

  test("treats null rows as empty", () => {
    assert.deepEqual(derivePreviouslyKnownAs(null, "Current"), []);
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

  test("defaults limit and offset to null and drops invalid rows", () => {
    const out = buildSubnetIdentityHistory([null, identityHistoryRow()], 86);
    assert.equal(out.limit, null);
    assert.equal(out.offset, null);
    assert.equal(out.entry_count, 1);
  });

  test("treats null rows input as empty", () => {
    const out = buildSubnetIdentityHistory(null, 86);
    assert.equal(out.entry_count, 0);
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

  test("returns the original detail when names are missing or invalid", () => {
    assert.equal(overlayPreviouslyKnownAs(null, ["MIAO"]), null);
    const detail = { netuid: 1 };
    assert.equal(overlayPreviouslyKnownAs(detail, null), detail);
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
          github_url: "not-a-uri",
          website_url: "javascript:alert(1)",
          discord: "x".repeat(201),
          logo_url: "https://deprecated.png/logo.png",
        },
      },
    ];
    const result = await recordSubnetIdentityChanges(
      {},
      { profiles, now: 1_700_000_000_000, db },
    );
    assert.equal(result.recorded, true);
    assert.equal(result.rows, 1);
    const insert = statements.find((entry) => entry.sql?.includes("INSERT"));
    assert.ok(insert);
    assert.equal(insert.args[3], "New Name");
    assert.equal(insert.args[6], null);
    assert.equal(insert.args[7], null);
    assert.equal(insert.args[8], null);
    assert.equal(insert.args[9], null);
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

  test("records block_number from the blocks table when available", async () => {
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
              return { results: [{ block_number: 8_404_076 }] };
            }
            return { results: [] };
          },
        };
      },
      batch: async () => {},
    };
    await recordSubnetIdentityChanges(
      { METAGRAPH_HEALTH_DB: db },
      {
        profiles: [{ netuid: 7, native_identity: { subnet_name: "First" } }],
        db,
      },
    );
    assert.equal(binds[0]?.[1], 8_404_076);
  });

  test("batches large inserts in chunks of 100", async () => {
    let batches = 0;
    const db = {
      prepare(_sql) {
        return {
          bind() {
            return this;
          },
          all: async () => ({ results: [] }),
        };
      },
      batch: async (chunk) => {
        batches += 1;
        assert.ok(chunk.length > 0 && chunk.length <= 100);
      },
    };
    const profiles = Array.from({ length: 101 }, (_, index) => ({
      netuid: index + 1,
      native_identity: { subnet_name: `Subnet ${index + 1}` },
    }));
    const result = await recordSubnetIdentityChanges({}, { profiles, db });
    assert.equal(result.rows, 101);
    assert.equal(batches, 2);
  });

  test("skips profiles without integer netuids or native identity", async () => {
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
        throw new Error("should not write");
      },
    };
    const result = await recordSubnetIdentityChanges(
      {},
      {
        profiles: [{ netuid: "7" }, { netuid: 8 }],
        db,
      },
    );
    assert.equal(result.rows, 0);
  });

  test("reads latest hashes when D1 returns no results array", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          all: async () => ({}),
        };
      },
      batch: async () => {},
    };
    const result = await recordSubnetIdentityChanges(
      {},
      {
        profiles: [{ netuid: 7, native_identity: { subnet_name: "First" } }],
        db,
      },
    );
    assert.equal(result.rows, 1);
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

  test("omits next_cursor for a short page or invalid observed_at", async () => {
    const out = await loadSubnetIdentityHistory(
      async () => [identityHistoryRow({ observed_at: "bad" })],
      86,
      { limit: 10 },
    );
    assert.equal(out.next_cursor, null);
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

  test("returns an empty map when entries are null", async () => {
    const map = await loadPreviouslyKnownAsForNetuids(async () => [], null);
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

  test("merges multiple rows for the same netuid", async () => {
    const map = await loadPreviouslyKnownAsForNetuids(
      async () => [
        { netuid: 86, subnet_name: "MIAO", observed_at: 2 },
        { netuid: 86, subnet_name: "Arena", observed_at: 1 },
      ],
      [{ netuid: 86, name: "⚒" }],
    );
    assert.deepEqual(map.get(86), ["MIAO", "Arena"]);
  });

  test("uses native_name when name is absent and skips empty alias sets", async () => {
    const map = await loadPreviouslyKnownAsForNetuids(
      async () => [{ netuid: 7, subnet_name: "Allways", observed_at: 1 }],
      [{ netuid: 7, native_name: "Allways" }],
    );
    assert.equal(map.size, 0);
  });

  test("prefers name over native_name for the current label", async () => {
    const map = await loadPreviouslyKnownAsForNetuids(
      async () => [{ netuid: 7, subnet_name: "Old Allways", observed_at: 1 }],
      [{ netuid: 7, name: "Allways", native_name: "Legacy" }],
    );
    assert.deepEqual(map.get(7), ["Old Allways"]);
  });

  test("treats null D1 rows as empty", async () => {
    const map = await loadPreviouslyKnownAsForNetuids(
      async () => null,
      [{ netuid: 7, name: "Allways" }],
    );
    assert.equal(map.size, 0);
  });

  test("treats entries without a current label as null", async () => {
    const map = await loadPreviouslyKnownAsForNetuids(
      async () => [{ netuid: 7, subnet_name: "Old Allways", observed_at: 1 }],
      [{ netuid: 7 }],
    );
    assert.deepEqual(map.get(7), ["Old Allways"]);
  });
});
