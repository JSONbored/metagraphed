import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";
import {
  handleBlock,
  handleBlockEvents,
  handleBlockExtrinsics,
} from "../workers/request-handlers/entities.mjs";
import {
  BLOCK_INSERT_COLUMNS,
  BLOCK_READ_COLUMNS,
  BLOCK_RETENTION_MS,
  blockInsertStatements,
  buildBlock,
  buildBlockFeed,
  formatBlock,
  loadBlock,
  pruneBlocks,
  validBlockRows,
} from "../src/blocks.mjs";
import { encodeCursor } from "../src/cursor.mjs";

// ---- Pure module (#1345) ---------------------------------------------------

test("BLOCK_INSERT_COLUMNS is the stable load contract (#1345)", () => {
  assert.deepEqual(BLOCK_INSERT_COLUMNS, [
    "block_number",
    "block_hash",
    "parent_hash",
    "author",
    "extrinsic_count",
    "event_count",
    "spec_version",
    "observed_at",
  ]);
});

test("validBlockRows enforces the strict row shape (#1345)", () => {
  assert.deepEqual(validBlockRows("not-an-array"), []);
  assert.deepEqual(validBlockRows(null), []);
  const good = { block_number: 1, block_hash: "0xabc", observed_at: 5 };
  assert.equal(validBlockRows([good]).length, 1);
  // missing hash
  assert.equal(validBlockRows([{ block_number: 1, observed_at: 5 }]).length, 0);
  // empty hash
  assert.equal(validBlockRows([{ ...good, block_hash: "" }]).length, 0);
  // non-integer block_number
  assert.equal(validBlockRows([{ ...good, block_number: 1.5 }]).length, 0);
  // negative block_number
  assert.equal(validBlockRows([{ ...good, block_number: -1 }]).length, 0);
  // observed_at must be an integer
  assert.equal(validBlockRows([{ ...good, observed_at: "x" }]).length, 0);
});

test("blockInsertStatements builds chunked parameterized INSERT OR IGNORE", () => {
  const prepared = [];
  const db = {
    prepare(sql) {
      prepared.push(sql);
      return { bind: (...v) => ({ sql, v }) };
    },
  };
  const rows = Array.from({ length: 30 }, (_, i) => ({
    block_number: i,
    block_hash: `0x${i}`,
    observed_at: 1,
  }));
  const stmts = blockInsertStatements(db, rows);
  // 30 rows / 12 per statement = 3 statements (12, 12, 6)
  assert.equal(stmts.length, 3);
  assert.ok(prepared[0].startsWith("INSERT OR IGNORE INTO blocks ("));
  assert.ok(prepared[0].includes("VALUES (?"));
  // Every value is BOUND (8 cols x 12 rows = 96 params on a full chunk, <=100).
  assert.equal(stmts[0].v.length, 8 * 12);
  // All eight columns appear in the column list.
  for (const col of BLOCK_INSERT_COLUMNS) {
    assert.ok(prepared[0].includes(col), `missing ${col}`);
  }
});

test("blockInsertStatements binds missing fields as null (never interpolates)", () => {
  const db = {
    prepare(sql) {
      return { bind: (...v) => ({ sql, v }) };
    },
  };
  const [stmt] = blockInsertStatements(db, [
    { block_number: 7, block_hash: "0x7", observed_at: 9 },
  ]);
  // parent_hash, author, extrinsic_count, event_count, spec_version default to null.
  assert.deepEqual(stmt.v, [7, "0x7", null, null, null, null, null, 9]);
});

test("formatBlock maps a D1 row to an API block (ISO time)", () => {
  const out = formatBlock({
    block_number: 1000,
    block_hash: "0xhash",
    parent_hash: "0xparent",
    author: "5Author",
    extrinsic_count: 4,
    event_count: 12,
    spec_version: 201,
    observed_at: 1750000000000,
  });
  assert.equal(out.block_number, 1000);
  assert.equal(out.block_hash, "0xhash");
  assert.equal(out.author, "5Author");
  assert.equal(out.extrinsic_count, 4);
  assert.equal(out.spec_version, 201);
  assert.equal(out.observed_at, new Date(1750000000000).toISOString());
});

test("formatBlock is null-safe on junk + sparse rows", () => {
  assert.equal(formatBlock(null), null);
  assert.equal(formatBlock("x"), null);
  const out = formatBlock({ block_number: 1 });
  assert.equal(out.block_hash, null);
  assert.equal(out.author, null);
  assert.equal(out.observed_at, null);
});

test("formatBlock defaults a missing block_number to null (every field nullable)", () => {
  // A row object with NO block_number must still yield a schema-stable object
  // (block_number: null), not undefined — the cold-store / partial-row contract.
  const out = formatBlock({ block_hash: "0xabc" });
  assert.equal(out.block_number, null);
  assert.equal(out.block_hash, "0xabc");
});

test("buildBlock defaults a null/absent ref to null (regression)", () => {
  // A caller that passes no ref must get ref:null, never undefined — keeps the
  // detail artifact JSON-stable when the lookup key itself is missing.
  const out = buildBlock(undefined, undefined);
  assert.equal(out.ref, null);
  assert.equal(out.block, null);
  assert.equal(out.schema_version, 1);
});

test("pruneBlocks reports changes:null when D1 omits the meta block", async () => {
  // A delete that returns no `.meta.changes` (some D1 shapes) must surface
  // changes:null, never crash on the `?? null` fallback.
  const env = {
    METAGRAPH_HEALTH_DB: {
      prepare() {
        return { bind: () => ({ run: async () => ({}) }) };
      },
    },
  };
  const r = await pruneBlocks(env, { now: () => 1_800_000_000_000 });
  assert.equal(r.pruned, true);
  assert.equal(r.changes, null);
});

test("buildBlock wraps a row + is schema-stable when absent (#1345)", () => {
  const out = buildBlock(
    { block_number: 5, block_hash: "0x5", observed_at: 1750000000000 },
    "5",
  );
  assert.equal(out.schema_version, 1);
  assert.equal(out.ref, "5");
  assert.equal(out.block.block_number, 5);

  const empty = buildBlock(undefined, "0xdead");
  assert.equal(empty.schema_version, 1);
  assert.equal(empty.ref, "0xdead");
  assert.equal(empty.block, null);
});

test("buildBlockFeed shapes the feed + honors limit/offset", () => {
  const feed = buildBlockFeed(
    [
      { block_number: 2, block_hash: "0x2", observed_at: 1750000000000 },
      { block_number: 1, block_hash: "0x1", observed_at: 1750000000000 },
    ],
    { limit: 50, offset: 0 },
  );
  assert.equal(feed.schema_version, 1);
  assert.equal(feed.block_count, 2);
  assert.equal(feed.limit, 50);
  assert.equal(feed.offset, 0);
  assert.equal(feed.blocks[0].block_number, 2);

  const empty = buildBlockFeed(null, {});
  assert.equal(empty.block_count, 0);
  assert.deepEqual(empty.blocks, []);
});

test("BLOCK_READ_COLUMNS lists the served block columns", () => {
  for (const c of [
    "block_number",
    "block_hash",
    "parent_hash",
    "author",
    "extrinsic_count",
    "event_count",
    "observed_at",
  ]) {
    assert.ok(BLOCK_READ_COLUMNS.includes(c), `missing ${c}`);
  }
});

test("pruneBlocks deletes below the retention cutoff", async () => {
  let boundCutoff;
  const env = {
    METAGRAPH_HEALTH_DB: {
      prepare() {
        return {
          bind: (c) => {
            boundCutoff = c;
            return { run: async () => ({ meta: { changes: 9 } }) };
          },
        };
      },
    },
  };
  const now = 1_800_000_000_000;
  const r = await pruneBlocks(env, { now: () => now });
  assert.equal(r.pruned, true);
  assert.equal(r.changes, 9);
  assert.equal(boundCutoff, now - BLOCK_RETENTION_MS);
});

test("pruneBlocks no-ops without D1", async () => {
  assert.equal((await pruneBlocks({})).pruned, false);
});

test("pruneBlocks returns pruned:false when D1 throws", async () => {
  const env = {
    METAGRAPH_HEALTH_DB: {
      prepare() {
        return {
          bind: () => ({
            run: async () => {
              throw new Error("d1 down");
            },
          }),
        };
      },
    },
  };
  assert.equal((await pruneBlocks(env, { now: () => 0 })).pruned, false);
});

// ---- Route/integration (#1345) ---------------------------------------------

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// A D1 mock that routes by SQL shape so the block handlers get realistic rows.
function dbWith({ feed, detail, neighbors } = {}) {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async all() {
                // prev/next neighbor query (#1853): indexed scalar subqueries.
                if (
                  /SELECT MAX\(block_number\) FROM blocks WHERE block_number < \?/.test(
                    sql,
                  )
                )
                  return { results: [neighbors || { prev: null, next: null }] };
                if (/LIMIT \? OFFSET \?/.test(sql))
                  return { results: feed || [] };
                if (/WHERE block_hash = \?|WHERE block_number = \?/.test(sql))
                  return { results: detail ? [detail] : [] };
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
}

test("GET /blocks returns the recent feed newest-first (#1345)", async () => {
  const env = dbWith({
    feed: [
      {
        block_number: 200,
        block_hash: "0xb200",
        parent_hash: "0xb199",
        author: null,
        extrinsic_count: 3,
        event_count: 9,
        observed_at: 1750009000000,
      },
    ],
  });
  const res = await handleRequest(req("/api/v1/blocks"), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.block_count, 1);
  assert.equal(body.data.blocks[0].block_number, 200);
  assert.equal(body.data.blocks[0].extrinsic_count, 3);
  assert.equal(body.data.limit, 50);
});

test("GET /blocks clamps limit to <=100 + rejects unsupported params", async () => {
  const env = dbWith({ feed: [] });
  const ok = await handleRequest(req("/api/v1/blocks?limit=999"), env, {});
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).data.limit, 100);

  const bad = await handleRequest(req("/api/v1/blocks?bogus=1"), env, {});
  assert.equal(bad.status, 400);
});

test("GET /blocks?cursor= seeks by keyset + emits next_cursor (#1851)", async () => {
  let boundSql;
  let boundParams;
  const env = {
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        boundSql = sql;
        return {
          bind(...p) {
            boundParams = p;
            return {
              async all() {
                // Return exactly `limit` rows so a next_cursor is emitted.
                return {
                  results: [
                    { block_number: 150, block_hash: "0x150", observed_at: 1 },
                  ],
                };
              },
            };
          },
        };
      },
    },
  };
  const res = await handleRequest(
    req(`/api/v1/blocks?limit=1&cursor=${encodeCursor([200])}`),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  // Keyset seek (not OFFSET) and the cursor's block_number is bound.
  assert.ok(/WHERE block_number < \?/.test(boundSql));
  assert.ok(!/OFFSET/.test(boundSql));
  assert.equal(boundParams[0], 200);
  // A full page → next_cursor points past the last row (block 150).
  assert.equal(body.data.next_cursor, encodeCursor([150]));
});

test("GET /blocks emits next_cursor:null when the page is not full (#1851)", async () => {
  const env = dbWith({
    feed: [{ block_number: 9, block_hash: "0x9", observed_at: 1 }],
  });
  const res = await handleRequest(req("/api/v1/blocks?limit=50"), env, {});
  const body = await res.json();
  assert.equal(body.data.next_cursor, null);
});

test("GET /blocks/{number} returns detail by block_number (#1345)", async () => {
  const env = dbWith({
    detail: {
      block_number: 1234,
      block_hash: "0xabc",
      parent_hash: "0xpar",
      author: "5Author",
      extrinsic_count: 5,
      event_count: 20,
      observed_at: 1750009000000,
    },
  });
  const res = await handleRequest(req("/api/v1/blocks/1234"), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ref, "1234");
  assert.equal(body.data.block.block_number, 1234);
  assert.equal(body.data.block.block_hash, "0xabc");
});

test("GET /blocks/{ref} emits nearest stored prev/next neighbors (#1853)", async () => {
  const env = dbWith({
    detail: { block_number: 1234, block_hash: "0xabc", observed_at: 1 },
    neighbors: { prev: 1230, next: 1240 }, // gaps skipped (pruned/missing)
  });
  const res = await handleRequest(req("/api/v1/blocks/1234"), env, {});
  const body = await res.json();
  assert.equal(body.data.prev_block_number, 1230);
  assert.equal(body.data.next_block_number, 1240);
});

test("GET /blocks/{ref} nulls neighbors at a window edge (#1853)", async () => {
  const env = dbWith({
    detail: { block_number: 1, block_hash: "0x1", observed_at: 1 },
    neighbors: { prev: null, next: 2 }, // oldest stored block: no prev
  });
  const res = await handleRequest(req("/api/v1/blocks/1"), env, {});
  const body = await res.json();
  assert.equal(body.data.prev_block_number, null);
  assert.equal(body.data.next_block_number, 2);
});

test("GET /blocks/{hash} resolves a 0x block_hash ref (#1345)", async () => {
  const hash = `0x${"a".repeat(64)}`;
  const env = dbWith({
    detail: {
      block_number: 9,
      block_hash: hash,
      observed_at: 1750009000000,
    },
  });
  const res = await handleRequest(req(`/api/v1/blocks/${hash}`), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ref, hash);
  assert.equal(body.data.block.block_hash, hash);
});

test("GET /blocks/{ref} is schema-stable when cold (block:null, never 404)", async () => {
  const res = await handleRequest(req("/api/v1/blocks/777"), {}, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ref, "777");
  assert.equal(body.data.block, null);
  // No anchor when the block didn't resolve → neighbors null (#1853).
  assert.equal(body.data.prev_block_number, null);
  assert.equal(body.data.next_block_number, null);
});

test("GET /blocks is schema-stable when D1 is cold (never 404)", async () => {
  const res = await handleRequest(req("/api/v1/blocks"), {}, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.block_count, 0);
  assert.equal(Array.isArray(body.data.blocks), true);
});

// #2063: a non-hash block ref must be a strict decimal block_number. The route
// regex (/^...(\d+|0x...)$/) gates these at the router, so this hardens the three
// block HANDLERS themselves (defense in depth) — the layer the issue verifies —
// by calling each directly with a malformed ref. The mock returns the SAME detail
// row for any block WHERE (matched by SQL shape, not bind values), so a malformed
// ref that still issued the query would surface that row; the strict matcher must
// instead skip the query.
const BAD_BLOCK_REFS = [
  "0x1", // short hex (old Number("0x1") === 1, resolved block 1)
  "1e3", // scientific notation (old Number("1e3") === 1000)
  "12-3", // composite-shaped (old Number("12-3") === NaN, but never a clean guard)
  " 5", // leading whitespace (old Number(" 5") === 5)
  "99999999999999999999", // all-digits but overflows MAX_SAFE_INTEGER → 1e20
];

for (const badRef of BAD_BLOCK_REFS) {
  test(`handleBlock("${badRef}") is a clean miss, not a coerced row (#2063)`, async () => {
    const env = dbWith({
      detail: { block_number: 1, block_hash: "0xabc", observed_at: 5 },
    });
    const res = await handleBlock(req(`/api/v1/blocks/${badRef}`), env, badRef);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(
      body.data.block,
      null,
      `block ref "${badRef}" must not resolve`,
    );
  });

  test(`handleBlockExtrinsics("${badRef}") is a clean miss (#2063)`, async () => {
    const env = dbWith({
      detail: { block_number: 1 },
      feed: [{ block_number: 1, extrinsic_index: 0, observed_at: 5 }],
    });
    const res = await handleBlockExtrinsics(
      req(`/api/v1/blocks/${badRef}/extrinsics`),
      env,
      badRef,
      new URL(`https://api.metagraph.sh/api/v1/blocks/${badRef}/extrinsics`),
    );
    const body = await res.json();
    assert.equal(body.data.block_number, null);
    assert.deepEqual(body.data.extrinsics, []);
  });

  test(`handleBlockEvents("${badRef}") is a clean miss (#2063)`, async () => {
    const env = dbWith({
      detail: { block_number: 1 },
      feed: [{ block_number: 1, event_index: 0, observed_at: 5 }],
    });
    const res = await handleBlockEvents(
      req(`/api/v1/blocks/${badRef}/events`),
      env,
      badRef,
      new URL(`https://api.metagraph.sh/api/v1/blocks/${badRef}/events`),
    );
    const body = await res.json();
    assert.equal(body.data.block_number, null);
    assert.deepEqual(body.data.events, []);
  });
}

// A well-formed numeric ref still resolves (the strict matcher must not
// over-reject the canonical decimal form).
test("handleBlock resolves a well-formed numeric ref (#2063 regression guard)", async () => {
  const env = dbWith({
    detail: { block_number: 1234, block_hash: "0xabc", observed_at: 5 },
  });
  const res = await handleBlock(req("/api/v1/blocks/1234"), env, "1234");
  const body = await res.json();
  assert.equal(body.data.block.block_number, 1234);
});

test("GET /blocks/{number}/extrinsics returns the block's extrinsics (#1845)", async () => {
  const env = dbWith({
    detail: { block_number: 1234 },
    feed: [
      {
        block_number: 1234,
        extrinsic_index: 0,
        extrinsic_hash: `0x${"c".repeat(64)}`,
        signer: "5Signer",
        call_module: "Timestamp",
        call_function: "set",
        success: 1,
        observed_at: 1750009000000,
      },
    ],
  });
  const res = await handleRequest(
    req("/api/v1/blocks/1234/extrinsics"),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ref, "1234");
  assert.equal(body.data.block_number, 1234);
  assert.equal(body.data.extrinsic_count, 1);
  assert.equal(body.data.extrinsics[0].call_function, "set");
});

test("GET /blocks/{number}/extrinsics is schema-stable when the number is unknown (#1845)", async () => {
  const res = await handleRequest(
    req("/api/v1/blocks/777/extrinsics"),
    dbWith({ feed: [] }),
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ref, "777");
  assert.equal(body.data.block_number, null);
  assert.equal(body.data.extrinsic_count, 0);
  assert.equal(Array.isArray(body.data.extrinsics), true);
});

test("GET /blocks/{hash}/extrinsics resolves the hash then lists extrinsics (#1845)", async () => {
  const hash = `0x${"a".repeat(64)}`;
  const env = dbWith({
    detail: { block_number: 9 },
    feed: [
      {
        block_number: 9,
        extrinsic_index: 1,
        extrinsic_hash: `0x${"b".repeat(64)}`,
        observed_at: 1750009000000,
      },
    ],
  });
  const res = await handleRequest(
    req(`/api/v1/blocks/${hash}/extrinsics`),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ref, hash);
  assert.equal(body.data.block_number, 9);
  assert.equal(body.data.extrinsics[0].extrinsic_index, 1);
});

test("GET /blocks/{hash}/extrinsics is schema-stable when the hash is unknown (#1845)", async () => {
  const hash = `0x${"d".repeat(64)}`;
  const res = await handleRequest(
    req(`/api/v1/blocks/${hash}/extrinsics`),
    {},
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ref, hash);
  assert.equal(body.data.block_number, null);
  assert.equal(body.data.extrinsic_count, 0);
  assert.equal(Array.isArray(body.data.extrinsics), true);
});

test("GET /blocks/{ref}/extrinsics rejects an unsupported query param (#1845)", async () => {
  const res = await handleRequest(
    req("/api/v1/blocks/1234/extrinsics?bogus=1"),
    {},
    {},
  );
  assert.equal(res.status, 400);
});

// ---- loadBlock strict ref (MCP get_block) ----------------------------------
// The shared loader behind the MCP get_block tool must mirror the REST route's
// strictBlockNumber guard: a non-hash ref that isn't a strict, safe-integer
// block_number is a clean miss, never a Number()-coerced wrong-but-valid lookup.

// A d1 runner that records every query and answers the block_number SELECT with
// the row whose number is bound — so a coercion bug surfaces as a wrong-but-valid
// hit instead of the expected miss.
function recordingDb(known = new Set()) {
  const calls = [];
  const d1 = async (sql, params) => {
    calls.push({ sql, params });
    if (/WHERE block_number = \?/.test(sql)) {
      const n = params[0];
      return known.has(n)
        ? [{ block_number: n, block_hash: `0x${"a".repeat(64)}` }]
        : [];
    }
    return [];
  };
  return { d1, calls };
}

test("loadBlock treats a malformed non-hash ref as a clean miss (#2314)", async () => {
  // Each of these would Number()-coerce to a stored block_number under the old
  // path (0x1->1, 1e3->1000, ' 5'->5); the strict guard must reject them.
  const bad = [
    "0x1",
    "1e3",
    " 5",
    "12-3",
    "+7",
    "0x1f",
    "99999999999999999999",
  ];
  for (const ref of bad) {
    const { d1, calls } = recordingDb(new Set([1, 5, 7, 31, 1000]));
    const out = await loadBlock(d1, ref);
    assert.equal(out.block, null, `ref ${ref} must miss`);
    assert.equal(out.ref, ref);
    assert.equal(
      calls.some((c) => /WHERE block_number = \?/.test(c.sql)),
      false,
      `ref ${ref} must skip the block_number lookup`,
    );
  }
});

test("loadBlock still resolves a well-formed numeric ref (#2314)", async () => {
  const { d1, calls } = recordingDb(new Set([42]));
  const out = await loadBlock(d1, "42");
  assert.equal(out.block.block_number, 42);
  assert.equal(
    calls.some(
      (c) => /WHERE block_number = \?/.test(c.sql) && c.params[0] === 42,
    ),
    true,
  );
});

test("loadBlock still resolves a 64-hex block_hash ref (#2314)", async () => {
  const hash = `0x${"a".repeat(64)}`;
  const calls = [];
  const d1 = async (sql, params) => {
    calls.push({ sql, params });
    if (/WHERE block_hash = \?/.test(sql)) {
      return [{ block_number: 9, block_hash: hash }];
    }
    return [];
  };
  const out = await loadBlock(d1, hash);
  assert.equal(out.block.block_number, 9);
  assert.equal(
    calls.some(
      (c) => /WHERE block_hash = \?/.test(c.sql) && c.params[0] === hash,
    ),
    true,
  );
});
