import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";
import { handleExtrinsic } from "../workers/request-handlers/entities.ts";
import {
  EXTRINSIC_READ_COLUMNS,
  EXTRINSIC_RETENTION_MS,
  buildExtrinsic,
  buildExtrinsicFeed,
  EXTRINSICS_CSV_COLUMNS,
  extrinsicsToCsvRows,
  formatExtrinsic,
  loadExtrinsics,
} from "../src/extrinsics.ts";
import { encodeCursor } from "../src/cursor.ts";
import { DAY_MS } from "../workers/config.ts";
import type { Row } from "./row-type.ts";

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
  })!;
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
  let out: Row | undefined;
  assert.doesNotThrow(() => {
    out = formatExtrinsic({
      block_number: 5,
      extrinsic_index: 0,
      observed_at: 9e15,
    }) as Row;
  });
  assert.equal(out!.observed_at, null);
  // A valid timestamp still renders as ISO (no regression).
  assert.equal(
    formatExtrinsic({
      block_number: 5,
      extrinsic_index: 0,
      observed_at: 1750000000000,
    })!.observed_at,
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
  })!;
  assert.equal(out.fee_tao, 0.0125);
  assert.equal(typeof out.fee_tao, "number");
  assert.equal(out.tip_tao, 0.1); // rounded to rao (9 dp)
  assert.equal(typeof out.tip_tao, "number");
});

test("formatExtrinsic maps a null/absent fee_tao/tip_tao to null", () => {
  const out = formatExtrinsic({ block_number: 10, extrinsic_index: 0 })!;
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
  })!;
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
    })!;
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
  })!;
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
  })!;
  assert.equal(out.observed_at, new Date(1750000000000).toISOString());
});

test("formatExtrinsic keeps a null/blank/invalid observed_at as null (not epoch 1970)", () => {
  assert.equal(
    formatExtrinsic({
      block_number: 10,
      extrinsic_index: 0,
      observed_at: null,
    })!.observed_at,
    null,
  );
  assert.equal(
    formatExtrinsic({ block_number: 10, extrinsic_index: 0, observed_at: "" })!
      .observed_at,
    null,
  );
  assert.equal(
    formatExtrinsic({
      block_number: 10,
      extrinsic_index: 0,
      observed_at: "not-a-timestamp",
    })!.observed_at,
    null,
  );
});

test("formatExtrinsic parses call_args (array, object, parse-failure->null)", () => {
  // Substrate call args are canonically a LIST of {name,value} descriptors.
  const arr = formatExtrinsic({
    block_number: 1,
    extrinsic_index: 0,
    call_args: '[{"name":"netuid","value":1}]',
  })!;
  assert.deepEqual(arr.call_args, [{ name: "netuid", value: 1 }]);
  // An object payload is also tolerated.
  const obj = formatExtrinsic({
    block_number: 1,
    extrinsic_index: 0,
    call_args: '{"netuid":1}',
  })!;
  assert.deepEqual(obj.call_args, { netuid: 1 });
  // Malformed JSON -> null (never throws).
  const bad = formatExtrinsic({
    block_number: 1,
    extrinsic_index: 0,
    call_args: "not-json",
  })!;
  assert.equal(bad.call_args, null);
  // Absent -> null; fee_tao absent -> null.
  const sparse = formatExtrinsic({ block_number: 1, extrinsic_index: 0 })!;
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
  })!;
  assert.equal(
    (out.call_args as Row).transaction.EIP1559.value,
    "9131459485341369597",
  );
  assert.equal((out.call_args as Row).transaction.EIP1559.nonce, "69392");
});

test("formatExtrinsic extends the big-int-safe parse to EVERY call type, not just indexer-rs-ethereum-decode.ts's dispatch table (fixed 2026-07-15, was previously scoped narrow)", () => {
  // An exhaustive live audit found the plain-JSON.parse rounding bug reaches
  // far more call types than the handful indexer-rs-ethereum-decode.ts
  // names -- SubtensorModule.register's PoW nonce is exactly one instance of
  // a general problem, not a special case. parseJsonPreservingBigInts now
  // runs unconditionally in formatExtrinsic, so this out-of-scope call type
  // gets exact precision too, matching how U256 fields already work
  // (a JS number that would lose precision arrives as a decimal string
  // instead).
  const out = formatExtrinsic({
    block_number: 1,
    extrinsic_index: 0,
    call_module: "SubtensorModule",
    call_function: "register",
    call_args: '{"nonce":[9131459485341369597]}',
  })!;
  assert.equal(typeof (out.call_args as Row).nonce, "string");
  assert.equal((out.call_args as Row).nonce, "9131459485341369597");
});

test("formatExtrinsic unwraps a single-element BTreeSet (real SubtensorModule.claim_root, block 8587445/19, #4693)", () => {
  const out = formatExtrinsic({
    block_number: 8587445,
    extrinsic_index: 19,
    call_module: "SubtensorModule",
    call_function: "claim_root",
    call_args: '{"subnets": [[104]]}',
  })!;
  assert.deepEqual((out.call_args as Row).subnets, [104]);
});

test("formatExtrinsic correctly unwraps a BTreeSet nested inside Utility.batch, through the FULL real pipeline (real production fixture, block 8604111/11, fixed 2026-07-12)", () => {
  // Before this fix, a nested claim_root's `subnets` was corrupted into an
  // opaque hex string ("0x0102030405") by postgres-call-args.ts's generic
  // nested-call byte-blob heuristic, running before decodeBTreeSetFields
  // ever got a chance to see the real array -- confirmed live via direct
  // Postgres query for this exact block/extrinsic.
  const callArgsText = JSON.stringify([
    {
      name: "calls",
      type: "Vec<RuntimeCall>",
      value: [
        {
          name: "SubtensorModule",
          values: [
            { name: "claim_root", values: { subnets: [[1, 2, 3, 4, 5]] } },
          ],
        },
      ],
    },
  ]);
  const out = formatExtrinsic({
    block_number: 8604111,
    extrinsic_index: 11,
    call_module: "Utility",
    call_function: "batch",
    call_args: callArgsText,
  })!;
  const nestedCall = (out.call_args as Row)[0].value[0];
  assert.equal(nestedCall.call_module, "SubtensorModule");
  assert.equal(nestedCall.call_function, "claim_root");
  assert.deepEqual(nestedCall.call_args.subnets, [1, 2, 3, 4, 5]);
});

test("formatExtrinsic preserves SubtensorModule.register's PoW nonce precision exactly (real block 8556317/20, fixed 2026-07-15)", () => {
  // nonce is a BARE u64 scalar in the real Postgres row (confirmed via
  // direct query -- not newtype-wrapped like most other fields).
  // parseJsonPreservingBigInts now runs unconditionally in formatExtrinsic,
  // so this arrives as the exact decimal string instead of a rounded number.
  const out = formatExtrinsic({
    block_number: 8556317,
    extrinsic_index: 20,
    call_module: "SubtensorModule",
    call_function: "register",
    call_args:
      '{"work":[16,64,112,106],"nonce":9131459485341369597,"netuid":21}',
  })!;
  assert.equal((out.call_args as Row).nonce, "9131459485341369597");
});

test("formatExtrinsic preserves SubtensorModule.set_children's near-u64::MAX sentinel precision exactly (real block 8585337/19, fixed 2026-07-15)", () => {
  // children is Vec<(u64, AccountId32)> -- children[0][0] is the proportion
  // (here the true u64::MAX "take-all" sentinel), children[0][1] the child's
  // AccountId32 (untouched here -- top-level AccountId32 decode is a
  // separate gap).
  const out = formatExtrinsic({
    block_number: 8585337,
    extrinsic_index: 19,
    call_module: "SubtensorModule",
    call_function: "set_children",
    call_args:
      '{"netuid":121,"children":[[18446744073709551615,[[100,65,10,124,236,80,140,19,181,73,132,35,107,50,57,120,44,20,174,42,203,246,252,17,211,55,209,239,75,249,82,33]]]]}',
  })!;
  assert.equal((out.call_args as Row).children[0][0], "18446744073709551615");
});

test("formatExtrinsic preserves SubtensorModule.set_root_weights's version_key precision exactly (real block 4633973/7, found by 2026-07-15 exhaustive audit)", () => {
  const out = formatExtrinsic({
    block_number: 4633973,
    extrinsic_index: 7,
    call_module: "SubtensorModule",
    call_function: "set_root_weights",
    call_args:
      '{"hotkey":"5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y","netuid":0,"dests":[1],"weights":[65535],"version_key":18446744073709551615}',
  })!;
  assert.equal((out.call_args as Row).version_key, "18446744073709551615");
});

test("formatExtrinsic preserves SubtensorModule.faucet's PoW nonce precision exactly (real block 2351609/48, found by 2026-07-15 exhaustive audit)", () => {
  const out = formatExtrinsic({
    block_number: 2351609,
    extrinsic_index: 48,
    call_module: "SubtensorModule",
    call_function: "faucet",
    call_args:
      '{"work":[16,64,112,106],"nonce":13306593199926106273,"netuid":1,"block_number":2351600}',
  })!;
  assert.equal((out.call_args as Row).nonce, "13306593199926106273");
});

test("formatExtrinsic preserves a large u64 nested inside Proxy.proxy -> Utility.force_batch -> SubtensorModule.remove_stake (found by 2026-07-15 exhaustive audit, block 8623242/13)", () => {
  // Built as a raw JSON TEXT string (not JSON.stringify of a JS object) --
  // same reason as the U256 test above: a JS number literal this large is
  // already rounded by V8 before JSON.stringify ever runs, which would test
  // nothing.
  const callArgsText =
    '[{"name":"real","type":"MultiAddress","value":{"name":"Id","values":[[1,2,3]]}},' +
    '{"name":"force_proxy_type","type":"Option<ProxyType>","value":null},' +
    '{"name":"call","type":"RuntimeCall","value":{"name":"Utility","values":[' +
    '{"name":"force_batch","values":[[{"name":"SubtensorModule","values":[' +
    '{"name":"remove_stake","values":{"hotkey":[[4,5,6]],"netuid":1,' +
    '"amount_unstaked":18446744073709551615}}]}]]}]}}]';
  const out = formatExtrinsic({
    block_number: 8623242,
    extrinsic_index: 13,
    call_module: "Proxy",
    call_function: "proxy",
    call_args: callArgsText,
  })!;
  const nestedCall = (out.call_args as Row)[2].value.call_args[0][0];
  assert.equal(nestedCall.call_args.amount_unstaked, "18446744073709551615");
});

test("formatExtrinsic normalizes success (0->false, null->null)", () => {
  assert.equal(
    formatExtrinsic({ block_number: 1, extrinsic_index: 0, success: 0 })!
      .success,
    false,
  );
  assert.equal(
    formatExtrinsic({ block_number: 1, extrinsic_index: 0, success: null })!
      .success,
    null,
  );
  assert.equal(
    formatExtrinsic({ block_number: 1, extrinsic_index: 0 })!.success,
    null,
  );
});

test("formatExtrinsic coerces a string-typed D1 success cell", () => {
  assert.equal(
    formatExtrinsic({ block_number: 1, extrinsic_index: 0, success: "1" })!
      .success,
    true,
  );
  assert.equal(
    formatExtrinsic({ block_number: 1, extrinsic_index: 0, success: "0" })!
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
  })!;
  assert.deepEqual(
    extrinsicsToCsvRows([row as unknown as Record<string, unknown>]),
    [
      {
        extrinsic_id: "100-3",
        block_number: 100,
        signer: "5Signer",
        call_module: "SubtensorModule",
        call_function: "add_stake",
        success: true,
      },
    ],
  );
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
  assert.equal(
    formatExtrinsic("x" as unknown as Record<string, unknown>),
    null,
  );
  const out = formatExtrinsic({ block_number: 1, extrinsic_index: 0 })!;
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
  })!;
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
  const out = formatExtrinsic({})!;
  assert.equal(out.block_number, null);
  assert.equal(out.extrinsic_index, null);
});

test("formatExtrinsic rejects negative or non-integer chain-position cells to null", () => {
  // Guard the toChainPosition helper: negatives and floats are not valid chain
  // positions, so the formatter must fall back to null rather than coerce them.
  assert.equal(
    formatExtrinsic({ block_number: -1, extrinsic_index: 0 })!.block_number,
    null,
  );
  assert.equal(
    formatExtrinsic({ block_number: 1, extrinsic_index: 1.5 })!.extrinsic_index,
    null,
  );
  assert.equal(
    formatExtrinsic({ block_number: "abc", extrinsic_index: 0 })!.block_number,
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
    })!;
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
  assert.equal((out.extrinsic as Row).block_number, 5);
  assert.equal((out.extrinsic as Row).extrinsic_index, 1);

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

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// A D1 mock that routes by SQL shape so the extrinsic handlers get realistic rows.
function dbWith({
  feed,
  detail,
  events,
}: { feed?: Row; detail?: Row; events?: Row[] } = {}) {
  return {
    METAGRAPH_HEALTH_DB: {
      prepare(sql: string) {
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

test("GET /extrinsics/{hash} is schema-stable when cold (extrinsic:null, never 404)", async () => {
  const hash = `0x${"d".repeat(64)}`;
  const res = await handleRequest(req(`/api/v1/extrinsics/${hash}`), {}, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ref, hash);
  assert.equal(body.data.extrinsic, null);
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
      env as unknown as Env,
      badRef,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
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
test("GET /extrinsics is schema-stable when D1 is cold (never 404)", async () => {
  const res = await handleRequest(req("/api/v1/extrinsics"), {}, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.extrinsic_count, 0);
  assert.equal(Array.isArray(body.data.extrinsics), true);
});

// ---- loadExtrinsics filters (shared REST + MCP list_extrinsics) ------------

function recordingExtrinsicsD1(capture: Row[] = []) {
  return async (sql: string, params: unknown[]) => {
    capture.push({ sql, params });
    return [];
  };
}

test("loadExtrinsics applies the conjunctive filter set (#1846)", async () => {
  const capture: Row[] = [];
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
  const capture: Row[] = [];
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
  const capture: Row[] = [];
  const d1 = recordingExtrinsicsD1(capture);
  await loadExtrinsics(d1, { success: true });
  assert.ok(/success = \?/.test(capture[0].sql));
  assert.ok(capture[0].params.includes(1));

  capture.length = 0;
  await loadExtrinsics(d1, {});
  assert.ok(!/success = \?/.test(capture[0].sql));
});

test("loadExtrinsics forces observed_at index for a narrow time-only window", async () => {
  const capture: Row[] = [];
  const d1 = recordingExtrinsicsD1(capture);
  const nowMs = 1_800_000_000_000;
  const fromMs = nowMs - 60_000;
  await loadExtrinsics(d1, { from: fromMs, to: nowMs, nowMs });
  assert.ok(/INDEXED BY idx_extrinsics_observed_order/.test(capture[0].sql));
});

test("loadExtrinsics forces module index for a call_module-only scan", async () => {
  const capture: Row[] = [];
  const d1 = recordingExtrinsicsD1(capture);
  await loadExtrinsics(d1, { callModule: "SubtensorModule" });
  assert.ok(/INDEXED BY idx_extrinsics_module_block/.test(capture[0].sql));
});

test("loadExtrinsics ANDs keyset cursor with filters and drops OFFSET", async () => {
  const capture: Row[] = [];
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
  const capture: Row[] = [];
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
  const capture: Row[] = [];
  const d1 = recordingExtrinsicsD1(capture);
  const hash = `0x${"b".repeat(64)}`;
  await loadExtrinsics(d1, { callModule: "Multisig", callHash: hash });
  assert.ok(!/INDEXED BY idx_extrinsics_module_block/.test(capture[0].sql));
});
