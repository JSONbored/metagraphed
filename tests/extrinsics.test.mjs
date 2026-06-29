import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";
import { handleExtrinsic } from "../workers/request-handlers/entities.mjs";
import {
  EXTRINSIC_INSERT_COLUMNS,
  EXTRINSIC_READ_COLUMNS,
  EXTRINSIC_RETENTION_MS,
  buildExtrinsic,
  buildExtrinsicFeed,
  extrinsicInsertStatements,
  formatExtrinsic,
  pruneExtrinsics,
  validExtrinsicRows,
} from "../src/extrinsics.mjs";
import { encodeCursor } from "../src/cursor.mjs";

// ---- Pure module (#1345) ---------------------------------------------------

test("EXTRINSIC_INSERT_COLUMNS is the stable load contract (#1345/#1855)", () => {
  assert.deepEqual(EXTRINSIC_INSERT_COLUMNS, [
    "block_number",
    "extrinsic_index",
    "extrinsic_hash",
    "signer",
    "call_module",
    "call_function",
    "call_args",
    "success",
    "fee_tao",
    "tip_tao",
    "observed_at",
  ]);
  // 11 cols x ROWS_PER_STMT(9) = 99 bound params — under D1's 100 ceiling.
  assert.equal(EXTRINSIC_INSERT_COLUMNS.length, 11);
});

test("validExtrinsicRows enforces the strict row shape (#1345)", () => {
  assert.deepEqual(validExtrinsicRows("not-an-array"), []);
  assert.deepEqual(validExtrinsicRows(null), []);
  const good = { block_number: 1, extrinsic_index: 0, observed_at: 5 };
  assert.equal(validExtrinsicRows([good]).length, 1);
  // missing extrinsic_index
  assert.equal(
    validExtrinsicRows([{ block_number: 1, observed_at: 5 }]).length,
    0,
  );
  // non-integer block_number
  assert.equal(validExtrinsicRows([{ ...good, block_number: 1.5 }]).length, 0);
  // negative block_number
  assert.equal(validExtrinsicRows([{ ...good, block_number: -1 }]).length, 0);
  // non-integer extrinsic_index
  assert.equal(
    validExtrinsicRows([{ ...good, extrinsic_index: 1.5 }]).length,
    0,
  );
  // negative extrinsic_index
  assert.equal(
    validExtrinsicRows([{ ...good, extrinsic_index: -1 }]).length,
    0,
  );
  // observed_at must be an integer
  assert.equal(validExtrinsicRows([{ ...good, observed_at: "x" }]).length, 0);
});

test("extrinsicInsertStatements builds chunked parameterized INSERT OR IGNORE", () => {
  const prepared = [];
  const db = {
    prepare(sql) {
      prepared.push(sql);
      return { bind: (...v) => ({ sql, v }) };
    },
  };
  const rows = Array.from({ length: 30 }, (_, i) => ({
    block_number: 1,
    extrinsic_index: i,
    observed_at: 1,
  }));
  const stmts = extrinsicInsertStatements(db, rows);
  // 30 rows / 9 per statement = 4 statements (9, 9, 9, 3)
  assert.equal(stmts.length, 4);
  assert.ok(prepared[0].startsWith("INSERT OR IGNORE INTO extrinsics ("));
  assert.ok(prepared[0].includes("VALUES (?"));
  // Every value is BOUND (11 cols x 9 rows = 99 params on a full chunk, <=100).
  assert.equal(stmts[0].v.length, 11 * 9);
  // All eleven columns appear in the column list.
  for (const col of EXTRINSIC_INSERT_COLUMNS) {
    assert.ok(prepared[0].includes(col), `missing ${col}`);
  }
});

test("extrinsicInsertStatements binds missing fields as null (never interpolates)", () => {
  const db = {
    prepare(sql) {
      return { bind: (...v) => ({ sql, v }) };
    },
  };
  const [stmt] = extrinsicInsertStatements(db, [
    { block_number: 7, extrinsic_index: 2, observed_at: 9 },
  ]);
  // hash, signer, call_module, call_function, call_args, success, fee_tao, tip_tao default to null.
  assert.deepEqual(stmt.v, [
    7,
    2,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    9,
  ]);
});

test("formatExtrinsic maps a D1 row to an API extrinsic (ISO time, bool success)", () => {
  const out = formatExtrinsic({
    block_number: 1000,
    extrinsic_index: 4,
    extrinsic_hash: "0xhash",
    signer: "5Signer",
    call_module: "SubtensorModule",
    call_function: "add_stake",
    call_args: '[{"name":"hotkey","value":"5H..."}]',
    fee_tao: 0.0125,
    tip_tao: 0.5,
    success: 1,
    observed_at: 1750000000000,
  });
  assert.equal(out.block_number, 1000);
  assert.equal(out.extrinsic_index, 4);
  assert.equal(out.extrinsic_hash, "0xhash");
  assert.equal(out.signer, "5Signer");
  assert.equal(out.call_module, "SubtensorModule");
  assert.equal(out.call_function, "add_stake");
  assert.deepEqual(out.call_args, [{ name: "hotkey", value: "5H..." }]);
  assert.equal(out.fee_tao, 0.0125);
  assert.equal(out.tip_tao, 0.5);
  assert.equal(out.success, true);
  assert.equal(out.observed_at, new Date(1750000000000).toISOString());
});

test("formatExtrinsic parses call_args (array, object, parse-failure->null)", () => {
  // Substrate call args are canonically a LIST of {name,value} descriptors.
  const arr = formatExtrinsic({
    block_number: 1,
    extrinsic_index: 0,
    call_args: '[{"name":"netuid","value":1}]',
  });
  assert.deepEqual(arr.call_args, [{ name: "netuid", value: 1 }]);
  // An object payload is also tolerated.
  const obj = formatExtrinsic({
    block_number: 1,
    extrinsic_index: 0,
    call_args: '{"netuid":1}',
  });
  assert.deepEqual(obj.call_args, { netuid: 1 });
  // Malformed JSON -> null (never throws).
  const bad = formatExtrinsic({
    block_number: 1,
    extrinsic_index: 0,
    call_args: "not-json",
  });
  assert.equal(bad.call_args, null);
  // Absent -> null; fee_tao absent -> null.
  const sparse = formatExtrinsic({ block_number: 1, extrinsic_index: 0 });
  assert.equal(sparse.call_args, null);
  assert.equal(sparse.fee_tao, null);
});

test("formatExtrinsic normalizes success (0->false, null->null)", () => {
  assert.equal(
    formatExtrinsic({ block_number: 1, extrinsic_index: 0, success: 0 })
      .success,
    false,
  );
  assert.equal(
    formatExtrinsic({ block_number: 1, extrinsic_index: 0, success: null })
      .success,
    null,
  );
  assert.equal(
    formatExtrinsic({ block_number: 1, extrinsic_index: 0 }).success,
    null,
  );
});

test("formatExtrinsic is null-safe on junk + sparse rows", () => {
  assert.equal(formatExtrinsic(null), null);
  assert.equal(formatExtrinsic("x"), null);
  const out = formatExtrinsic({ block_number: 1, extrinsic_index: 0 });
  assert.equal(out.extrinsic_hash, null);
  assert.equal(out.signer, null);
  assert.equal(out.observed_at, null);
});

test("buildExtrinsic wraps a row + is schema-stable when absent (#1345)", () => {
  const hash = `0x${"a".repeat(64)}`;
  const out = buildExtrinsic(
    {
      block_number: 5,
      extrinsic_index: 1,
      extrinsic_hash: hash,
      observed_at: 1750000000000,
    },
    hash,
  );
  assert.equal(out.schema_version, 1);
  assert.equal(out.ref, hash);
  assert.equal(out.extrinsic.block_number, 5);
  assert.equal(out.extrinsic.extrinsic_index, 1);

  const empty = buildExtrinsic(undefined, "0xdead");
  assert.equal(empty.schema_version, 1);
  assert.equal(empty.ref, "0xdead");
  assert.equal(empty.extrinsic, null);
});

test("buildExtrinsicFeed shapes the feed + honors limit/offset", () => {
  const feed = buildExtrinsicFeed(
    [
      { block_number: 2, extrinsic_index: 1, observed_at: 1750000000000 },
      { block_number: 2, extrinsic_index: 0, observed_at: 1750000000000 },
    ],
    { limit: 50, offset: 0 },
  );
  assert.equal(feed.schema_version, 1);
  assert.equal(feed.extrinsic_count, 2);
  assert.equal(feed.limit, 50);
  assert.equal(feed.offset, 0);
  assert.equal(feed.extrinsics[0].extrinsic_index, 1);

  const empty = buildExtrinsicFeed(null, {});
  assert.equal(empty.extrinsic_count, 0);
  assert.deepEqual(empty.extrinsics, []);
});

test("EXTRINSIC_READ_COLUMNS lists the served extrinsic columns", () => {
  for (const c of [
    "block_number",
    "extrinsic_index",
    "extrinsic_hash",
    "signer",
    "call_module",
    "call_function",
    "success",
    "observed_at",
  ]) {
    assert.ok(EXTRINSIC_READ_COLUMNS.includes(c), `missing ${c}`);
  }
});

test("pruneExtrinsics deletes below the retention cutoff", async () => {
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
  const r = await pruneExtrinsics(env, { now: () => now });
  assert.equal(r.pruned, true);
  assert.equal(r.changes, 9);
  assert.equal(boundCutoff, now - EXTRINSIC_RETENTION_MS);
});

test("pruneExtrinsics no-ops without D1", async () => {
  assert.equal((await pruneExtrinsics({})).pruned, false);
});

test("pruneExtrinsics returns pruned:false when D1 throws", async () => {
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
  assert.equal((await pruneExtrinsics(env, { now: () => 0 })).pruned, false);
});

// ---- Route/integration (#1345) ---------------------------------------------

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// A D1 mock that routes by SQL shape so the extrinsic handlers get realistic rows.
function dbWith({ feed, detail, events } = {}) {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async all() {
                // Emitted-events embed (#1849): FROM account_events — check the
                // table BEFORE the generic composite WHERE (both share that shape).
                if (/FROM account_events/.test(sql))
                  return { results: events || [] };
                if (/WHERE extrinsic_hash = \?/.test(sql))
                  return { results: detail ? [detail] : [] };
                // Composite-id detail (#1848): WHERE block_number=? AND extrinsic_index=?.
                if (
                  /WHERE block_number = \? AND extrinsic_index = \?/.test(sql)
                )
                  return { results: detail ? [detail] : [] };
                if (/LIMIT \? OFFSET \?/.test(sql))
                  return { results: feed || [] };
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
}

test("GET /extrinsics returns the recent feed newest-first (#1345)", async () => {
  const env = dbWith({
    feed: [
      {
        block_number: 200,
        extrinsic_index: 2,
        extrinsic_hash: `0x${"b".repeat(64)}`,
        signer: "5Signer",
        call_module: "SubtensorModule",
        call_function: "add_stake",
        success: 1,
        observed_at: 1750009000000,
      },
    ],
  });
  const res = await handleRequest(req("/api/v1/extrinsics"), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.extrinsic_count, 1);
  assert.equal(body.data.extrinsics[0].block_number, 200);
  assert.equal(body.data.extrinsics[0].call_function, "add_stake");
  assert.equal(body.data.extrinsics[0].success, true);
  assert.equal(body.data.limit, 50);
});

test("GET /extrinsics?cursor= seeks by the composite keyset + emits next_cursor (#1851)", async () => {
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
                return {
                  results: [
                    {
                      block_number: 150,
                      extrinsic_index: 4,
                      extrinsic_hash: `0x${"a".repeat(64)}`,
                      observed_at: 1,
                    },
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
    req(`/api/v1/extrinsics?limit=1&cursor=${encodeCursor([200, 2])}`),
    env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  // Row-value seek on the (block_number, extrinsic_index) PK, no OFFSET.
  assert.ok(/\(block_number, extrinsic_index\) < \(\?, \?\)/.test(boundSql));
  assert.ok(!/OFFSET/.test(boundSql));
  assert.ok(boundParams.includes(200));
  assert.ok(boundParams.includes(2));
  // Full page → next_cursor past the last row (150, 4).
  assert.equal(body.data.next_cursor, encodeCursor([150, 4]));
});

test("GET /extrinsics clamps limit to <=100 + rejects unsupported params", async () => {
  const env = dbWith({ feed: [] });
  const ok = await handleRequest(req("/api/v1/extrinsics?limit=999"), env, {});
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).data.limit, 100);

  const bad = await handleRequest(req("/api/v1/extrinsics?bogus=1"), env, {});
  assert.equal(bad.status, 400);
});

test("GET /extrinsics rejects non-numeric value filters with 400 (#2086)", async () => {
  const env = dbWith({ feed: [] });
  for (const query of [
    "block=abc",
    "from=foo",
    "to=foo",
    "block_start=abc",
    "block_end=abc",
  ]) {
    const res = await handleRequest(
      req(`/api/v1/extrinsics?${query}`),
      env,
      {},
    );
    assert.equal(res.status, 400, query);
    const body = await res.json();
    assert.equal(body.ok, false);
  }
});

test("GET /extrinsics?block=<n> scopes the feed to one block (#1345)", async () => {
  let boundSql;
  const env = {
    METAGRAPH_HEALTH_DB: {
      prepare(sql) {
        boundSql = sql;
        return {
          bind() {
            return {
              async all() {
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
  const res = await handleRequest(
    req("/api/v1/extrinsics?block=1234"),
    env,
    {},
  );
  assert.equal(res.status, 200);
  assert.ok(/WHERE block_number = \?/.test(boundSql));
});

test("GET /extrinsics applies the conjunctive filter set (#1846)", async () => {
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
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
  // from/to must land inside the retained hot window; an impossible/expired
  // range (e.g. the 1970 epoch) is intentionally short-circuited before the
  // WHERE clause is ever built (#1846 DoS hardening), so use a recent window
  // here to exercise the full conjunctive filter path this test asserts.
  const toMs = Date.now();
  const fromMs = toMs - 60_000;
  const res = await handleRequest(
    req(
      `/api/v1/extrinsics?signer=5Signer&call_module=SubtensorModule&call_function=add_stake&success=false&block_start=100&block_end=200&from=${fromMs}&to=${toMs}`,
    ),
    env,
    {},
  );
  assert.equal(res.status, 200);
  assert.ok(/signer = \?/.test(boundSql));
  assert.ok(/call_module = \?/.test(boundSql));
  assert.ok(/call_function = \?/.test(boundSql));
  assert.ok(/success = \?/.test(boundSql));
  assert.ok(/block_number >= \?/.test(boundSql));
  assert.ok(/block_number <= \?/.test(boundSql));
  assert.ok(/observed_at >= \?/.test(boundSql));
  assert.ok(/observed_at <= \?/.test(boundSql));
  // success=false binds the literal 0 (never !=1, which would leak NULL rows).
  assert.ok(boundParams.includes(0));
  assert.ok(boundParams.includes("5Signer"));
  // limit + offset are the last two bound params.
  assert.equal(boundParams.at(-2), 50);
  assert.equal(boundParams.at(-1), 0);
});

test("GET /extrinsics?success=true binds 1; an invalid success is ignored (#1846)", async () => {
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
                return { results: [] };
              },
            };
          },
        };
      },
    },
  };
  await handleRequest(req("/api/v1/extrinsics?success=true"), env, {});
  assert.ok(/success = \?/.test(boundSql));
  assert.ok(boundParams.includes(1));

  // A non-true/false success value adds no condition (no WHERE).
  await handleRequest(req("/api/v1/extrinsics?success=maybe"), env, {});
  assert.ok(!/success = \?/.test(boundSql));
  assert.ok(!/WHERE/.test(boundSql));
});

test("GET /extrinsics/{hash} returns detail by extrinsic_hash (#1345)", async () => {
  const hash = `0x${"c".repeat(64)}`;
  const env = dbWith({
    detail: {
      block_number: 1234,
      extrinsic_index: 3,
      extrinsic_hash: hash,
      signer: "5Signer",
      call_module: "Balances",
      call_function: "transfer",
      success: 0,
      observed_at: 1750009000000,
    },
  });
  const res = await handleRequest(req(`/api/v1/extrinsics/${hash}`), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ref, hash);
  assert.equal(body.data.extrinsic.extrinsic_hash, hash);
  assert.equal(body.data.extrinsic.call_function, "transfer");
  assert.equal(body.data.extrinsic.success, false);
});

test("GET /extrinsics/{hash} is schema-stable when cold (extrinsic:null, never 404)", async () => {
  const hash = `0x${"d".repeat(64)}`;
  const res = await handleRequest(req(`/api/v1/extrinsics/${hash}`), {}, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ref, hash);
  assert.equal(body.data.extrinsic, null);
});

test("GET /extrinsics/{block}-{index} resolves by the composite id (#1848)", async () => {
  const env = dbWith({
    detail: {
      block_number: 1234,
      extrinsic_index: 3,
      extrinsic_hash: null,
      call_module: "Timestamp",
      call_function: "set",
      success: 1,
      observed_at: 1750009000000,
    },
  });
  const res = await handleRequest(req("/api/v1/extrinsics/1234-3"), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ref, "1234-3");
  assert.equal(body.data.extrinsic.block_number, 1234);
  assert.equal(body.data.extrinsic.extrinsic_index, 3);
  // A null-hash extrinsic — previously unaddressable — is now reachable.
  assert.equal(body.data.extrinsic.extrinsic_hash, null);
});

test("GET /extrinsics/{block}-{index} is schema-stable when cold (#1848)", async () => {
  const res = await handleRequest(req("/api/v1/extrinsics/777-0"), {}, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ref, "777-0");
  assert.equal(body.data.extrinsic, null);
  // The events embed (#1849) is always present + empty when the ref is cold.
  assert.deepEqual(body.data.events, []);
});

test("GET /extrinsics/{ref} embeds the events the extrinsic emitted (#1849)", async () => {
  const hash = `0x${"e".repeat(64)}`;
  const env = dbWith({
    detail: {
      block_number: 1234,
      extrinsic_index: 2,
      extrinsic_hash: hash,
      call_module: "SubtensorModule",
      call_function: "add_stake",
      success: 1,
      observed_at: 1750009000000,
    },
    events: [
      {
        block_number: 1234,
        event_index: 5,
        event_kind: "StakeAdded",
        hotkey: "5Hk",
        coldkey: "5Co",
        netuid: 7,
        uid: 3,
        amount_tao: 1.5,
        observed_at: 1750009000000,
        extrinsic_index: 2,
      },
    ],
  });
  const res = await handleRequest(req(`/api/v1/extrinsics/${hash}`), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.extrinsic.extrinsic_index, 2);
  assert.equal(body.data.events.length, 1);
  assert.equal(body.data.events[0].event_kind, "StakeAdded");
  assert.equal(body.data.events[0].extrinsic_index, 2);
});

// #2063: the composite "<block>-<index>" parser used split("-") + Number(),
// which resolved several malformed refs to a wrong-but-VALID row. The route regex
// (/^...\d+-\d+$/) gates these at the router, so this hardens the HANDLER itself
// (defense in depth) — the layer the issue verifies — by calling handleExtrinsic
// directly with the malformed ref. The mock returns the SAME detail row for any
// composite WHERE (it matches by SQL shape, not bind values), so a malformed ref
// that still issued the query would surface that row; the strict matcher must
// instead skip the query → extrinsic:null.
for (const badRef of [
  "1234-3-5", // extra segment (old split dropped "5", resolved 1234-3)
  "1234-", // empty index half (old Number("") === 0, resolved 1234-0)
  "-3", // empty block half (old Number("") === 0, resolved 0-3)
  "0x1-2", // hex (old Number("0x1") === 1, resolved 1-2)
  "1e3-2", // scientific notation (old Number("1e3") === 1000, resolved 1000-2)
  "99999999999999999999-3", // block half overflows MAX_SAFE_INTEGER → 1e20
]) {
  test(`handleExtrinsic("${badRef}") is a clean miss, not a coerced row (#2063)`, async () => {
    const env = dbWith({
      detail: {
        block_number: 1234,
        extrinsic_index: 3,
        extrinsic_hash: null,
        call_module: "Timestamp",
        call_function: "set",
        success: 1,
        observed_at: 1750009000000,
      },
    });
    const res = await handleExtrinsic(
      req(`/api/v1/extrinsics/${badRef}`),
      env,
      badRef,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.ref, badRef);
    assert.equal(
      body.data.extrinsic,
      null,
      `malformed composite ref "${badRef}" must not resolve to a row`,
    );
    assert.deepEqual(body.data.events, []);
  });
}

// A well-formed composite ref still resolves (the strict matcher must not
// over-reject the canonical "<block>-<index>" form).
test("handleExtrinsic resolves a well-formed composite ref (#2063 regression guard)", async () => {
  const env = dbWith({
    detail: {
      block_number: 1234,
      extrinsic_index: 3,
      extrinsic_hash: null,
      call_module: "Timestamp",
      call_function: "set",
      success: 1,
      observed_at: 1750009000000,
    },
  });
  const res = await handleExtrinsic(
    req("/api/v1/extrinsics/1234-3"),
    env,
    "1234-3",
  );
  const body = await res.json();
  assert.equal(body.data.extrinsic.block_number, 1234);
  assert.equal(body.data.extrinsic.extrinsic_index, 3);
});

test("GET /extrinsics is schema-stable when D1 is cold (never 404)", async () => {
  const res = await handleRequest(req("/api/v1/extrinsics"), {}, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.extrinsic_count, 0);
  assert.equal(Array.isArray(body.data.extrinsics), true);
});
