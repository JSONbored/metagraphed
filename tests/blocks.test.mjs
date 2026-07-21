import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";
import {
  handleBlock,
  handleBlockEvents,
  handleBlockExtrinsics,
} from "../workers/request-handlers/entities.mjs";
import {
  BLOCK_READ_COLUMNS,
  buildBlock,
  buildBlockFeed,
  formatBlock,
  loadBlock,
  loadBlocks,
  MAX_BLOCK_COUNT_FILTER,
} from "../src/blocks.mjs";
import { encodeCursor } from "../src/cursor.ts";

// ---- Pure module (#1345) ---------------------------------------------------

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

test("formatBlock treats an empty-string author as null (Postgres backfill gap, not a valid value)", () => {
  const out = formatBlock({
    block_number: 1000,
    block_hash: "0xhash",
    author: "",
  });
  assert.equal(out.author, null);
});

test("formatBlock treats a whitespace-only author as null", () => {
  const out = formatBlock({
    block_number: 1000,
    block_hash: "0xhash",
    author: "   ",
  });
  assert.equal(out.author, null);
});

test("formatBlock preserves a real decoded author string unchanged", () => {
  const out = formatBlock({
    block_number: 1000,
    block_hash: "0xhash",
    author: "5HjhkCMa89QJbFULs8WPZBgVg8kMq5qdX1nx7CnQpZgoyKAN",
  });
  assert.equal(out.author, "5HjhkCMa89QJbFULs8WPZBgVg8kMq5qdX1nx7CnQpZgoyKAN");
});

test("formatBlock coerces string-typed observed_at cells to ISO timestamps", () => {
  const out = formatBlock({
    block_number: 1000,
    block_hash: "0xhash",
    observed_at: "1750000000000",
  });
  assert.equal(out.observed_at, new Date(1750000000000).toISOString());
});

test("formatBlock preserves null observed_at as null (not epoch 1970)", () => {
  const out = formatBlock({
    block_number: 1000,
    block_hash: "0xhash",
    observed_at: null,
  });
  assert.equal(out.observed_at, null);
});

test("formatBlock drops invalid observed_at strings to null", () => {
  const out = formatBlock({
    block_number: 1000,
    block_hash: "0xhash",
    observed_at: "not-a-timestamp",
  });
  assert.equal(out.observed_at, null);
});

test("formatBlock drops blank observed_at strings to null (not epoch 1970)", () => {
  const out = formatBlock({
    block_number: 1000,
    block_hash: "0xhash",
    observed_at: "",
  });
  assert.equal(out.observed_at, null);
});

test("formatBlock drops whitespace-only observed_at strings to null", () => {
  const out = formatBlock({
    block_number: 1000,
    block_hash: "0xhash",
    observed_at: "   ",
  });
  assert.equal(out.observed_at, null);
});

test("formatBlock drops out-of-range observed_at strings to null", () => {
  const out = formatBlock({
    block_number: 1000,
    block_hash: "0xhash",
    observed_at: "8640000000000001",
  });
  assert.equal(out.observed_at, null);
});

test("formatBlock drops out-of-range observed_at numbers to null", () => {
  const out = formatBlock({
    block_number: 1000,
    block_hash: "0xhash",
    observed_at: 8640000000000001,
  });
  assert.equal(out.observed_at, null);
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

test("formatBlock coerces a string-typed block_number cell to a Number", () => {
  // D1 can return an INTEGER column as a numeric string ("1000" not 1000); the
  // bare `?? null` pass-through this replaced would have leaked the string into
  // the API payload and broken downstream arithmetic/comparisons.
  const out = formatBlock({ block_number: "1000", block_hash: "0xabc" });
  assert.equal(out.block_number, 1000);
  assert.equal(typeof out.block_number, "number");
});

test("formatBlock coerces string-typed extrinsic_count/event_count/spec_version cells", () => {
  // Same D1 numeric-string hazard as block_number: these INTEGER columns must
  // not leak the string form into their ["integer","null"] contract fields.
  const out = formatBlock({
    block_number: 1000,
    extrinsic_count: "4",
    event_count: "12",
    spec_version: "201",
  });
  assert.equal(out.extrinsic_count, 4);
  assert.equal(typeof out.extrinsic_count, "number");
  assert.equal(out.event_count, 12);
  assert.equal(typeof out.event_count, "number");
  assert.equal(out.spec_version, 201);
  assert.equal(typeof out.spec_version, "number");
  // A missing/invalid count falls through to null, never NaN.
  const sparse = formatBlock({ block_number: 1, extrinsic_count: "oops" });
  assert.equal(sparse.extrinsic_count, null);
  assert.equal(sparse.event_count, null);
  assert.equal(sparse.spec_version, null);
});

test("formatBlock rejects a negative or non-integer block_number cell to null", () => {
  // Guard the toBlockNumber helper: negatives and floats are not valid block
  // heights, so the formatter must fall back to null rather than coerce them.
  assert.equal(formatBlock({ block_number: -1 }).block_number, null);
  assert.equal(formatBlock({ block_number: 1.5 }).block_number, null);
  assert.equal(formatBlock({ block_number: "abc" }).block_number, null);
});

test("formatBlock rejects blank integer cells that coerce to 0 (not block 0)", () => {
  // Mirrors the blank-cell guard in account-events.mjs (#2897): Number("") and
  // Number("   ") are 0, which would fabricate genesis height / counts.
  for (const blank of ["", "   "]) {
    const out = formatBlock({
      block_number: blank,
      extrinsic_count: blank,
      event_count: blank,
      spec_version: blank,
    });
    assert.equal(
      out.block_number,
      null,
      `block_number for ${JSON.stringify(blank)}`,
    );
    assert.equal(
      out.extrinsic_count,
      null,
      `extrinsic_count for ${JSON.stringify(blank)}`,
    );
    assert.equal(
      out.event_count,
      null,
      `event_count for ${JSON.stringify(blank)}`,
    );
    assert.equal(
      out.spec_version,
      null,
      `spec_version for ${JSON.stringify(blank)}`,
    );
  }
});

test("loadBlock resolves neighbors when D1 returns a string-typed block_number (#1853)", async () => {
  // D1 can return the INTEGER block_number as a numeric string. The neighbor
  // guard must coerce the resolved anchor (like formatBlock) before the MAX/MIN
  // lookup — a bare Number.isInteger("1234") is false, which skipped the query
  // and wrongly reported prev/next_block_number: null for a block that has
  // neighbors. Regression for the missed sibling of the #2489 string-cell fix.
  const d1 = async (sql, params) => {
    if (/block_number = \?/.test(sql)) {
      return [{ block_number: "1234", block_hash: "0xabc", observed_at: 1 }];
    }
    if (/MAX\(block_number\)/.test(sql)) {
      // The anchor must be bound as a Number, not the raw "1234" string.
      assert.deepEqual(params, [1234, 1234]);
      return [{ prev: 1230, next: 1240 }];
    }
    return [];
  };
  const out = await loadBlock(d1, "1234");
  assert.equal(out.block.block_number, 1234);
  assert.equal(out.prev_block_number, 1230);
  assert.equal(out.next_block_number, 1240);
});

test("loadBlock coerces string-typed neighbor heights from D1 (#1853)", async () => {
  const d1 = async (sql) => {
    if (/block_number = \?/.test(sql)) {
      return [{ block_number: 1234, block_hash: "0xabc", observed_at: 1 }];
    }
    if (/MAX\(block_number\)/.test(sql)) {
      return [{ prev: "1230", next: "1240" }];
    }
    return [];
  };
  const out = await loadBlock(d1, "1234");
  assert.equal(out.prev_block_number, 1230);
  assert.equal(out.next_block_number, 1240);
  assert.equal(typeof out.prev_block_number, "number");
  assert.equal(typeof out.next_block_number, "number");
});

test("buildBlock defaults a null/absent ref to null (regression)", () => {
  // A caller that passes no ref must get ref:null, never undefined — keeps the
  // detail artifact JSON-stable when the lookup key itself is missing.
  const out = buildBlock(undefined, undefined);
  assert.equal(out.ref, null);
  assert.equal(out.block, null);
  assert.equal(out.schema_version, 1);
});

test("buildBlock coerces string-typed neighbor heights to integers (#1853)", () => {
  const row = { block_number: 1234, block_hash: "0xabc", observed_at: 1 };
  const out = buildBlock(row, "1234", { prev: "1230", next: "1240" });
  assert.equal(out.block.block_number, 1234);
  assert.equal(out.prev_block_number, 1230);
  assert.equal(out.next_block_number, 1240);
  assert.equal(typeof out.prev_block_number, "number");
  assert.equal(typeof out.next_block_number, "number");
});

test("buildBlock nulls invalid neighbor cells instead of leaking strings", () => {
  const row = { block_number: 1, block_hash: "0xabc", observed_at: 1 };
  const out = buildBlock(row, "1", { prev: "oops", next: -5 });
  assert.equal(out.prev_block_number, null);
  assert.equal(out.next_block_number, null);
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

test("GET /blocks clamps limit to <=100 + rejects unsupported params", async () => {
  const env = dbWith({ feed: [] });
  const ok = await handleRequest(req("/api/v1/blocks?limit=999"), env, {});
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).data.limit, 100);

  const bad = await handleRequest(req("/api/v1/blocks?bogus=1"), env, {});
  assert.equal(bad.status, 400);
});

test("GET /blocks rejects non-integer numeric filters with 400 (#2310)", async () => {
  const env = dbWith({ feed: [] });
  for (const query of [
    "block_start=abc",
    "block_end=abc",
    "block_start=12.9",
    "from=foo",
    "to=foo",
    "min_extrinsics=1.5",
    "min_events=-1",
    "spec_version=foo",
  ]) {
    const res = await handleRequest(req(`/api/v1/blocks?${query}`), env, {});
    assert.equal(res.status, 400, query);
    const body = await res.json();
    assert.equal(body.ok, false, query);
    assert.equal(body.error.code, "invalid_query", query);
  }
});

test("GET /blocks emits next_cursor:null when the page is not full (#1851)", async () => {
  const env = dbWith({
    feed: [{ block_number: 9, block_hash: "0x9", observed_at: 1 }],
  });
  const res = await handleRequest(req("/api/v1/blocks?limit=50"), env, {});
  const body = await res.json();
  assert.equal(body.data.next_cursor, null);
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

test("loadBlock lowercases a mixed-case 0x block_hash before binding (#2349)", async () => {
  // The poller stores hashes lowercase + D1 is BINARY-collated, so an upper-case
  // ref must be lowercased before binding or the MCP get_block tool misses a
  // block the REST route resolves. Mirrors the REST handleBlock guard (#1955).
  const lower = `0x${"a".repeat(64)}`;
  const mixed = `0x${"A".repeat(64)}`;
  const calls = [];
  const d1 = async (sql, params) => {
    calls.push({ sql, params });
    if (/WHERE block_hash = \?/.test(sql)) {
      return params[0] === lower
        ? [{ block_number: 9, block_hash: lower }]
        : [];
    }
    return [];
  };
  const out = await loadBlock(d1, mixed);
  assert.equal(out.block.block_number, 9);
  assert.equal(
    calls.some(
      (c) => /WHERE block_hash = \?/.test(c.sql) && c.params[0] === lower,
    ),
    true,
    "the hash bind parameter must be lowercased",
  );
});

// ---- loadBlocks filters (shared REST + MCP list_blocks) --------------------

function recordingBlocksD1(capture = []) {
  return async (sql, params) => {
    capture.push({ sql, params });
    return [];
  };
}

test("loadBlocks applies the conjunctive filter set (#1991)", async () => {
  const capture = [];
  const d1 = recordingBlocksD1(capture);
  await loadBlocks(d1, {
    author: "5Author",
    specVersion: 423,
    blockStart: 100,
    blockEnd: 200,
    from: 1000,
    to: 2000,
    minExtrinsics: 1,
    minEvents: 5,
    limit: 10,
    offset: 0,
  });
  const { sql, params } = capture[0];
  assert.ok(/author = \?/.test(sql));
  assert.ok(/spec_version = \?/.test(sql));
  assert.ok(/block_number >= \?/.test(sql));
  assert.ok(/block_number <= \?/.test(sql));
  assert.ok(/observed_at >= \?/.test(sql));
  assert.ok(/observed_at <= \?/.test(sql));
  assert.ok(/extrinsic_count >= \?/.test(sql));
  assert.ok(/event_count >= \?/.test(sql));
  assert.ok(params.includes("5Author"));
  assert.ok(params.includes(423));
  assert.equal(params.at(-2), 10);
  assert.equal(params.at(-1), 0);
});

test("loadBlocks short-circuits impossible ranges and count floors before D1", async () => {
  const capture = [];
  const d1 = recordingBlocksD1(capture);
  const empty = await loadBlocks(d1, {
    blockStart: 20,
    blockEnd: 10,
    from: 200,
    to: 100,
    minEvents: MAX_BLOCK_COUNT_FILTER + 1,
  });
  assert.equal(empty.block_count, 0);
  assert.equal(empty.next_cursor, null);
  assert.equal(capture.length, 0);
});

test("loadBlocks ANDs keyset cursor with filters and drops OFFSET", async () => {
  const capture = [];
  const d1 = recordingBlocksD1(capture);
  await loadBlocks(d1, {
    author: "5Author",
    cursor: encodeCursor([300]),
  });
  const { sql, params } = capture[0];
  assert.ok(/author = \? AND block_number < \?/.test(sql));
  assert.ok(!/OFFSET/.test(sql));
  assert.ok(params.includes(300));
});

test("loadBlocks keeps the plain OFFSET path when unfiltered", async () => {
  const capture = [];
  const d1 = recordingBlocksD1(capture);
  await loadBlocks(d1, { limit: 10, offset: 20 });
  const { sql } = capture[0];
  assert.ok(!/WHERE/.test(sql));
  assert.ok(/ORDER BY block_number DESC LIMIT \? OFFSET \?/.test(sql));
});
