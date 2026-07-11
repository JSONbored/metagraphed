import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";
import { handleExtrinsic } from "../workers/request-handlers/entities.mjs";
import {
  EXTRINSIC_READ_COLUMNS,
  EXTRINSIC_RETENTION_MS,
  buildExtrinsic,
  buildExtrinsicFeed,
  EXTRINSICS_CSV_COLUMNS,
  extrinsicsToCsvRows,
  formatExtrinsic,
  loadExtrinsic,
  loadExtrinsics,
} from "../src/extrinsics.mjs";
import { encodeCursor } from "../src/cursor.mjs";
import { DAY_MS } from "../workers/config.mjs";

// ---- Pure module (#1345) ---------------------------------------------------

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

test("formatExtrinsic drops an out-of-range observed_at instead of throwing", () => {
  // A finite but out-of-range epoch (beyond the ±8.64e15 ms JS Date limit) would
  // make new Date(n).toISOString() throw a RangeError and 500 the extrinsics feed.
  // A single corrupt observed_at cell must degrade to null, not crash the row.
  let out;
  assert.doesNotThrow(() => {
    out = formatExtrinsic({
      block_number: 5,
      extrinsic_index: 0,
      observed_at: 9e15,
    });
  });
  assert.equal(out.observed_at, null);
  // A valid timestamp still renders as ISO (no regression).
  assert.equal(
    formatExtrinsic({
      block_number: 5,
      extrinsic_index: 0,
      observed_at: 1750000000000,
    }).observed_at,
    new Date(1750000000000).toISOString(),
  );
});

test("formatExtrinsic coerces D1 numeric-string fee_tao/tip_tao and rounds to rao", () => {
  // D1 can return the REAL fee/tip columns as numeric strings; a bare `?? null`
  // would leak the string into the ["number","null"] contract field. Coercion
  // also rounds float noise to rao precision (9 dp). Mirrors #2662.
  const out = formatExtrinsic({
    block_number: 10,
    extrinsic_index: 0,
    fee_tao: "0.0125",
    tip_tao: "0.10000000004",
    observed_at: 1750000000000,
  });
  assert.equal(out.fee_tao, 0.0125);
  assert.equal(typeof out.fee_tao, "number");
  assert.equal(out.tip_tao, 0.1); // rounded to rao (9 dp)
  assert.equal(typeof out.tip_tao, "number");
});

test("formatExtrinsic maps a null/absent fee_tao/tip_tao to null", () => {
  const out = formatExtrinsic({ block_number: 10, extrinsic_index: 0 });
  assert.equal(out.fee_tao, null);
  assert.equal(out.tip_tao, null);
});

test("formatExtrinsic maps a non-numeric fee_tao/tip_tao to null (not NaN)", () => {
  // A non-finite / non-numeric cell must fall through to null, never leak NaN
  // into the ["number","null"] contract field.
  const out = formatExtrinsic({
    block_number: 10,
    extrinsic_index: 0,
    fee_tao: "not-a-number",
    tip_tao: "abc",
  });
  assert.equal(out.fee_tao, null);
  assert.equal(out.tip_tao, null);
});

test("formatExtrinsic rejects blank fee_tao/tip_tao cells that coerce to 0", () => {
  // Mirrors the blank-cell guard in toChainPosition() (#2974): Number("") is 0.
  for (const blank of ["", "   "]) {
    const out = formatExtrinsic({
      block_number: 10,
      extrinsic_index: 0,
      fee_tao: blank,
      tip_tao: blank,
      observed_at: 1750000000000,
    });
    assert.equal(out.fee_tao, null, `fee_tao for ${JSON.stringify(blank)}`);
    assert.equal(out.tip_tao, null, `tip_tao for ${JSON.stringify(blank)}`);
  }
  // A literal zero fee/tip is still valid — only blank strings are rejected.
  const zero = formatExtrinsic({
    block_number: 10,
    extrinsic_index: 0,
    fee_tao: 0,
    tip_tao: "0",
    observed_at: 1750000000000,
  });
  assert.equal(zero.fee_tao, 0);
  assert.equal(zero.tip_tao, 0);
});

test("formatExtrinsic coerces a string-typed observed_at cell to an ISO timestamp", () => {
  // D1 can return the INTEGER observed_at as a numeric string; the old
  // Number.isFinite(string) guard dropped a real timestamp to null. Mirrors #2708.
  const out = formatExtrinsic({
    block_number: 10,
    extrinsic_index: 0,
    observed_at: "1750000000000",
  });
  assert.equal(out.observed_at, new Date(1750000000000).toISOString());
});

test("formatExtrinsic keeps a null/blank/invalid observed_at as null (not epoch 1970)", () => {
  assert.equal(
    formatExtrinsic({ block_number: 10, extrinsic_index: 0, observed_at: null })
      .observed_at,
    null,
  );
  assert.equal(
    formatExtrinsic({ block_number: 10, extrinsic_index: 0, observed_at: "" })
      .observed_at,
    null,
  );
  assert.equal(
    formatExtrinsic({
      block_number: 10,
      extrinsic_index: 0,
      observed_at: "not-a-timestamp",
    }).observed_at,
    null,
  );
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

test("formatExtrinsic preserves a U256 value past Number.MAX_SAFE_INTEGER through the REAL JSON.parse path, not just pre-parsed objects (#4692 review fix)", () => {
  // Gittensory review caught that the original #4692 PR's precision claim
  // was false: decodeEthereumEvmCallArgs ran on the output of a plain
  // JSON.parse(row.call_args), which had already silently rounded any U256
  // limb past 2^53 before decodeU256Limbs ever saw it. This constructs the
  // call_args as a raw JSON TEXT string (as it would exist in Postgres'
  // call_args::text column) containing the true, exact large-limb literal --
  // NOT a JS object built from a number literal in source code, which would
  // already be rounded by the JS parser before ever reaching JSON.stringify.
  const callArgsText =
    '{"transaction":{"name":"EIP1559","values":[{"value":[[9131459485341369597,0,0,0]],"nonce":[[69392,0,0,0]]}]}}';
  const out = formatExtrinsic({
    block_number: 8587453,
    extrinsic_index: 9,
    call_module: "Ethereum",
    call_function: "transact",
    call_args: callArgsText,
  });
  assert.equal(out.call_args.transaction.EIP1559.value, "9131459485341369597");
  assert.equal(out.call_args.transaction.EIP1559.nonce, "69392");
});

test("formatExtrinsic does NOT extend the big-int-safe parse to call types outside indexer-rs-ethereum-decode.mjs's dispatch table -- preserves existing (already-imprecise) D1-serving behavior for out-of-scope call types", () => {
  // Scoping the fix to hasEthereumEvmDecoder's 4 call types is deliberate:
  // SubtensorModule.register's PoW nonce precision loss is an existing,
  // already-accepted issue (#4693's scope) -- this must not silently change
  // that field's type from number to string as a side effect of #4692.
  const out = formatExtrinsic({
    block_number: 1,
    extrinsic_index: 0,
    call_module: "SubtensorModule",
    call_function: "register",
    call_args: '{"nonce":[9131459485341369597]}',
  });
  assert.equal(typeof out.call_args.nonce, "number");
  assert.equal(out.call_args.nonce, 9131459485341369000);
});

test("formatExtrinsic unwraps a single-element BTreeSet (real SubtensorModule.claim_root, block 8587445/19, #4693)", () => {
  const out = formatExtrinsic({
    block_number: 8587445,
    extrinsic_index: 19,
    call_module: "SubtensorModule",
    call_function: "claim_root",
    call_args: '{"subnets": [[104]]}',
  });
  assert.deepEqual(out.call_args.subnets, [104]);
});

test("formatExtrinsic pins SubtensorModule.register's PoW nonce precision as an accepted, tested invariant (real block 8556317/20, #4693) -- Postgres's exact literal converges on the same value D1 already serves, not a regression to fix here", () => {
  // nonce is a BARE u64 scalar in the real Postgres row (confirmed via
  // direct query -- not newtype-wrapped like most other fields), and
  // formatExtrinsic deliberately does NOT route SubtensorModule.register
  // through the big-int-safe parse (#4692's hasEthereumEvmDecoder gate) --
  // per #4693's explicit requirement, this ticket pins the current
  // convergent-but-lossy behavior rather than fixing it.
  const out = formatExtrinsic({
    block_number: 8556317,
    extrinsic_index: 20,
    call_module: "SubtensorModule",
    call_function: "register",
    call_args:
      '{"work":[16,64,112,106],"nonce":9131459485341369597,"netuid":21}',
  });
  assert.equal(out.call_args.nonce, 9131459485341369000);
});

test("formatExtrinsic pins SubtensorModule.set_children's near-u64::MAX sentinel precision as an accepted, tested invariant (real block 8585337/19, #4693)", () => {
  // children is Vec<(u64, AccountId32)> -- children[0][0] is the proportion
  // (here the true u64::MAX "take-all" sentinel), children[0][1] the child's
  // AccountId32 (untouched here -- top-level AccountId32 decode is a
  // separate, not-yet-covered gap, out of #4693's scope).
  const out = formatExtrinsic({
    block_number: 8585337,
    extrinsic_index: 19,
    call_module: "SubtensorModule",
    call_function: "set_children",
    call_args:
      '{"netuid":121,"children":[[18446744073709551615,[[100,65,10,124,236,80,140,19,181,73,132,35,107,50,57,120,44,20,174,42,203,246,252,17,211,55,209,239,75,249,82,33]]]]}',
  });
  assert.equal(out.call_args.children[0][0], 18446744073709552000);
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

test("formatExtrinsic coerces a string-typed D1 success cell", () => {
  assert.equal(
    formatExtrinsic({ block_number: 1, extrinsic_index: 0, success: "1" })
      .success,
    true,
  );
  assert.equal(
    formatExtrinsic({ block_number: 1, extrinsic_index: 0, success: "0" })
      .success,
    false,
  );
});

test("extrinsicsToCsvRows projects composite extrinsic_id and core columns", () => {
  const row = formatExtrinsic({
    block_number: 100,
    extrinsic_index: 3,
    signer: "5Signer",
    call_module: "SubtensorModule",
    call_function: "add_stake",
    success: 1,
  });
  assert.deepEqual(extrinsicsToCsvRows([row]), [
    {
      extrinsic_id: "100-3",
      block_number: 100,
      signer: "5Signer",
      call_module: "SubtensorModule",
      call_function: "add_stake",
      success: true,
    },
  ]);
  assert.deepEqual(EXTRINSICS_CSV_COLUMNS, [
    "extrinsic_id",
    "block_number",
    "signer",
    "call_module",
    "call_function",
    "success",
  ]);
});

test("extrinsicsToCsvRows nulls extrinsic_id when chain position is incomplete", () => {
  assert.deepEqual(
    extrinsicsToCsvRows([
      {
        block_number: 100,
        extrinsic_index: null,
        signer: null,
        call_module: null,
        call_function: null,
        success: null,
      },
    ]),
    [
      {
        extrinsic_id: null,
        block_number: 100,
        signer: null,
        call_module: null,
        call_function: null,
        success: null,
      },
    ],
  );
  assert.deepEqual(
    extrinsicsToCsvRows([
      {
        block_number: null,
        extrinsic_index: 3,
        signer: "5Signer",
        call_module: "Balances",
        call_function: "transfer",
        success: false,
      },
    ]),
    [
      {
        extrinsic_id: null,
        block_number: null,
        signer: "5Signer",
        call_module: "Balances",
        call_function: "transfer",
        success: false,
      },
    ],
  );
  assert.deepEqual(extrinsicsToCsvRows(null), []);
});

test("formatExtrinsic is null-safe on junk + sparse rows", () => {
  assert.equal(formatExtrinsic(null), null);
  assert.equal(formatExtrinsic("x"), null);
  const out = formatExtrinsic({ block_number: 1, extrinsic_index: 0 });
  assert.equal(out.extrinsic_hash, null);
  assert.equal(out.signer, null);
  assert.equal(out.observed_at, null);
});

test("formatExtrinsic coerces string-typed chain-position cells to Numbers", () => {
  // D1 can return an INTEGER column as a numeric string ("1" not 1); the bare
  // `?? null` pass-through this replaced would have leaked strings into the API
  // payload and broken downstream arithmetic/comparisons.
  const out = formatExtrinsic({
    block_number: "8400000",
    extrinsic_index: "3",
  });
  assert.equal(out.block_number, 8400000);
  assert.equal(typeof out.block_number, "number");
  assert.equal(out.extrinsic_index, 3);
  assert.equal(typeof out.extrinsic_index, "number");
});

test("formatExtrinsic coerces a fully missing chain-position to null (both fields)", () => {
  // A row without block_number / extrinsic_index keys must still yield null for
  // both — exercises the `value == null` short-circuit in toChainPosition that
  // the partial-row cases above don't reach (every input above was a defined
  // primitive, so the helper's null guard was never hit).
  const out = formatExtrinsic({});
  assert.equal(out.block_number, null);
  assert.equal(out.extrinsic_index, null);
});

test("formatExtrinsic rejects negative or non-integer chain-position cells to null", () => {
  // Guard the toChainPosition helper: negatives and floats are not valid chain
  // positions, so the formatter must fall back to null rather than coerce them.
  assert.equal(
    formatExtrinsic({ block_number: -1, extrinsic_index: 0 }).block_number,
    null,
  );
  assert.equal(
    formatExtrinsic({ block_number: 1, extrinsic_index: 1.5 }).extrinsic_index,
    null,
  );
  assert.equal(
    formatExtrinsic({ block_number: "abc", extrinsic_index: 0 }).block_number,
    null,
  );
});

test("formatExtrinsic rejects blank chain-position cells that coerce to 0", () => {
  // Mirrors the blank-cell guard in blocks.mjs (#2947): Number("") and
  // Number("   ") are 0, which would fabricate genesis block / index 0.
  for (const blank of ["", "   "]) {
    const out = formatExtrinsic({
      block_number: blank,
      extrinsic_index: blank,
    });
    assert.equal(
      out.block_number,
      null,
      `block_number for ${JSON.stringify(blank)}`,
    );
    assert.equal(
      out.extrinsic_index,
      null,
      `extrinsic_index for ${JSON.stringify(blank)}`,
    );
  }
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

test("GET /extrinsics?success=true binds 1; an invalid success returns 400 (#2575)", async () => {
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

  const bad = await handleRequest(
    req("/api/v1/extrinsics?success=maybe"),
    env,
    {},
  );
  assert.equal(bad.status, 400);
  const body = await bad.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "invalid_query");
  assert.equal(body.meta.parameter, "success");
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

// ---- loadExtrinsic strict ref (MCP get_extrinsic) --------------------------
// The shared loader behind the MCP get_extrinsic tool must mirror the REST
// route's COMPOSITE_REF_RE guard: a non-hash ref must be exactly two strict,
// safe-integer decimal halves — a malformed composite is a clean miss, never a
// Number()-coerced wrong-but-valid lookup.

// A d1 runner that records every query and answers the composite SELECT with the
// row whose (block, index) is bound — so a coercion bug surfaces as a
// wrong-but-valid hit instead of the expected miss.
function recordingExtrinsicDb(known = new Set()) {
  const calls = [];
  const d1 = async (sql, params) => {
    calls.push({ sql, params });
    if (/block_number = \? AND extrinsic_index = \?/.test(sql)) {
      const key = `${params[0]}-${params[1]}`;
      return known.has(key)
        ? [{ block_number: params[0], extrinsic_index: params[1] }]
        : [];
    }
    return [];
  };
  return { d1, calls };
}

test("loadExtrinsic treats a malformed composite ref as a clean miss (#2316)", async () => {
  // Each would coerce to a stored (block, index) under the old loose split path
  // (1e3-0 -> 1000,0; 0x10-0 -> 16,0; 5-0-0 -> 5,0; 5.0-0 -> 5,0); the strict
  // COMPOSITE_REF_RE guard must reject them.
  const bad = [
    "1e3-0",
    "0x10-0",
    " 5-0",
    "5-0-0",
    "5.0-0",
    "5-",
    "-3",
    "5",
    "99999999999999999999-0",
  ];
  for (const ref of bad) {
    const { d1, calls } = recordingExtrinsicDb(
      new Set(["1000-0", "16-0", "5-0", "1234-3"]),
    );
    const out = await loadExtrinsic(d1, ref);
    assert.equal(out.extrinsic, null, `ref ${ref} must miss`);
    assert.equal(out.ref, ref);
    assert.equal(
      calls.some((c) =>
        /block_number = \? AND extrinsic_index = \?/.test(c.sql),
      ),
      false,
      `ref ${ref} must skip the composite lookup`,
    );
  }
});

test("loadExtrinsic still resolves a canonical composite ref (#2316)", async () => {
  const { d1, calls } = recordingExtrinsicDb(new Set(["1234-3"]));
  const out = await loadExtrinsic(d1, "1234-3");
  assert.equal(out.extrinsic.block_number, 1234);
  assert.equal(out.extrinsic.extrinsic_index, 3);
  assert.equal(
    calls.some(
      (c) =>
        /block_number = \? AND extrinsic_index = \?/.test(c.sql) &&
        c.params[0] === 1234 &&
        c.params[1] === 3,
    ),
    true,
  );
});

test("loadExtrinsic still resolves a 64-hex extrinsic_hash ref (#2316)", async () => {
  const hash = `0x${"b".repeat(64)}`;
  const calls = [];
  const d1 = async (sql, params) => {
    calls.push({ sql, params });
    if (/WHERE extrinsic_hash = \?/.test(sql)) {
      return [{ block_number: 7, extrinsic_index: 2, extrinsic_hash: hash }];
    }
    return [];
  };
  const out = await loadExtrinsic(d1, hash);
  assert.equal(out.extrinsic.block_number, 7);
  assert.equal(out.extrinsic.extrinsic_index, 2);
  assert.equal(
    calls.some(
      (c) => /WHERE extrinsic_hash = \?/.test(c.sql) && c.params[0] === hash,
    ),
    true,
  );
});

test("loadExtrinsic lowercases a mixed-case 0x extrinsic_hash before binding (#2349)", async () => {
  // The poller stores hashes lowercase + D1 is BINARY-collated, so an upper-case
  // ref must be lowercased before binding or the MCP get_extrinsic tool misses an
  // extrinsic the REST route resolves. Mirrors the REST handleExtrinsic guard (#1955).
  const lower = `0x${"b".repeat(64)}`;
  const mixed = `0x${"B".repeat(64)}`;
  const calls = [];
  const d1 = async (sql, params) => {
    calls.push({ sql, params });
    if (/WHERE extrinsic_hash = \?/.test(sql)) {
      return params[0] === lower
        ? [{ block_number: 7, extrinsic_index: 2, extrinsic_hash: lower }]
        : [];
    }
    return [];
  };
  const out = await loadExtrinsic(d1, mixed);
  assert.equal(out.extrinsic.block_number, 7);
  assert.equal(out.extrinsic.extrinsic_index, 2);
  assert.equal(
    calls.some(
      (c) => /WHERE extrinsic_hash = \?/.test(c.sql) && c.params[0] === lower,
    ),
    true,
    "the hash bind parameter must be lowercased",
  );
});

// ---- loadExtrinsics filters (shared REST + MCP list_extrinsics) ------------

function recordingExtrinsicsD1(capture = []) {
  return async (sql, params) => {
    capture.push({ sql, params });
    return [];
  };
}

test("loadExtrinsics applies the conjunctive filter set (#1846)", async () => {
  const capture = [];
  const d1 = recordingExtrinsicsD1(capture);
  const toMs = 1_800_000_000_000;
  const fromMs = toMs - 60_000;
  await loadExtrinsics(d1, {
    block: 1234,
    signer: "5Signer",
    callModule: "SubtensorModule",
    callFunction: "add_stake",
    success: false,
    blockStart: 1200,
    blockEnd: 1300,
    from: fromMs,
    to: toMs,
    nowMs: toMs,
  });
  const { sql, params } = capture[0];
  assert.ok(/block_number = \?/.test(sql));
  assert.ok(/signer = \?/.test(sql));
  assert.ok(/call_module = \?/.test(sql));
  assert.ok(/call_function = \?/.test(sql));
  assert.ok(/success = \?/.test(sql));
  assert.ok(/block_number >= \?/.test(sql));
  assert.ok(/block_number <= \?/.test(sql));
  assert.ok(/observed_at >= \?/.test(sql));
  assert.ok(/observed_at <= \?/.test(sql));
  assert.ok(params.includes(0));
  assert.ok(params.includes("5Signer"));
});

test("loadExtrinsics short-circuits impossible time ranges before D1", async () => {
  const capture = [];
  const d1 = recordingExtrinsicsD1(capture);
  const nowMs = 1_800_000_000_000;
  assert.equal(typeof EXTRINSIC_RETENTION_MS, "number");
  const floor = nowMs - EXTRINSIC_RETENTION_MS;
  const empty = await loadExtrinsics(d1, {
    from: nowMs + DAY_MS + 1,
    nowMs,
  });
  assert.equal(empty.extrinsic_count, 0);
  assert.equal(capture.length, 0);

  capture.length = 0;
  const expired = await loadExtrinsics(d1, { to: floor - 1, nowMs });
  assert.equal(expired.extrinsic_count, 0);
  assert.equal(capture.length, 0);

  capture.length = 0;
  const inverted = await loadExtrinsics(d1, { from: 200, to: 100, nowMs });
  assert.equal(inverted.extrinsic_count, 0);
  assert.equal(capture.length, 0);

  capture.length = 0;
  const invertedBlockRange = await loadExtrinsics(d1, {
    blockStart: 200,
    blockEnd: 100,
    nowMs,
  });
  assert.equal(invertedBlockRange.extrinsic_count, 0);
  assert.equal(capture.length, 0);
});

test("loadExtrinsics binds success=true as 1 and omits success when unset", async () => {
  const capture = [];
  const d1 = recordingExtrinsicsD1(capture);
  await loadExtrinsics(d1, { success: true });
  assert.ok(/success = \?/.test(capture[0].sql));
  assert.ok(capture[0].params.includes(1));

  capture.length = 0;
  await loadExtrinsics(d1, {});
  assert.ok(!/success = \?/.test(capture[0].sql));
});

test("loadExtrinsics forces observed_at index for a narrow time-only window", async () => {
  const capture = [];
  const d1 = recordingExtrinsicsD1(capture);
  const nowMs = 1_800_000_000_000;
  const fromMs = nowMs - 60_000;
  await loadExtrinsics(d1, { from: fromMs, to: nowMs, nowMs });
  assert.ok(/INDEXED BY idx_extrinsics_observed_order/.test(capture[0].sql));
});

test("loadExtrinsics forces module index for a call_module-only scan", async () => {
  const capture = [];
  const d1 = recordingExtrinsicsD1(capture);
  await loadExtrinsics(d1, { callModule: "SubtensorModule" });
  assert.ok(/INDEXED BY idx_extrinsics_module_block/.test(capture[0].sql));
});

test("loadExtrinsics ANDs keyset cursor with filters and drops OFFSET", async () => {
  const capture = [];
  const d1 = recordingExtrinsicsD1(capture);
  await loadExtrinsics(d1, {
    signer: "5Signer",
    cursor: encodeCursor([4200000, 3]),
  });
  const { sql, params } = capture[0];
  assert.ok(/signer = \?/.test(sql));
  assert.ok(/\(block_number, extrinsic_index\) < \(\?, \?\)/.test(sql));
  assert.ok(!/OFFSET/.test(sql));
  assert.ok(params.includes(4200000));
  assert.ok(params.includes(3));
});

// #4322 — Multisig approval-chain linking: call_hash filter.
test("loadExtrinsics binds callHash as a quoted LIKE match and omits it when unset", async () => {
  const capture = [];
  const d1 = recordingExtrinsicsD1(capture);
  const hash = `0x${"a".repeat(64)}`;
  await loadExtrinsics(d1, { callModule: "Multisig", callHash: hash });
  assert.ok(/call_args LIKE \?/.test(capture[0].sql));
  assert.ok(capture[0].params.includes(`%"${hash}"%`));

  capture.length = 0;
  await loadExtrinsics(d1, {});
  assert.ok(!/call_args LIKE \?/.test(capture[0].sql));
});

test("loadExtrinsics does not force the module index when callHash is also set", async () => {
  const capture = [];
  const d1 = recordingExtrinsicsD1(capture);
  const hash = `0x${"b".repeat(64)}`;
  await loadExtrinsics(d1, { callModule: "Multisig", callHash: hash });
  assert.ok(!/INDEXED BY idx_extrinsics_module_block/.test(capture[0].sql));
});
