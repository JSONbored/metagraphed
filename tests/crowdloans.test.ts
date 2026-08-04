import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CROWDLOANS_KV_TTL,
  CROWDLOANS_NEGATIVE_KV_TTL,
  CROWDLOANS_FIELD_SOURCES,
  CROWDLOAN_FIELD_SOURCES,
  MAX_CROWDLOANS_FANOUT,
  decodeCrowdloan,
  isCrowdloanId,
  loadCrowdloan,
  loadCrowdloans,
} from "../src/crowdloans.ts";
import { encodeAccountId32 } from "../src/ss58.ts";
import { handleRequest } from "../workers/api.ts";
import { mockEnv } from "./row-type.ts";
import type { AnyFn, Row } from "./row-type.ts";

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// Mirrors withFetchStub in tests/subnet-lease.test.ts.
function withFetchStub(stub: AnyFn, fn: AnyFn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = orig;
  });
}

function hex(bytes: Uint8Array) {
  return "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function repeatByte(byte: number, n: number) {
  return new Uint8Array(n).fill(byte);
}
function u32le(n: number) {
  return new Uint8Array([
    n & 0xff,
    (n >> 8) & 0xff,
    (n >> 16) & 0xff,
    (n >> 24) & 0xff,
  ]);
}
function u64le(n: bigint | number) {
  const out = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
function concatBytes(...parts: Uint8Array[]) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const RAO = 1_000_000_000n;

// Synthetic but SCALE-correct CrowdloanInfo encodings, built field-by-field
// per src/crowdloans.ts's header. The field order there was read off live
// finney runtime metadata and verified byte-exact against real entries — see
// the golden-value test at the bottom of this file, which pins the exact
// 139-byte layout a real record has.
function encodeCrowdloan({
  creatorByte = 0x11,
  depositRao = 10n * RAO,
  minContributionRao = RAO / 10n,
  end = 6_989_100,
  capRao = 30n * RAO,
  fundsByte = 0x22,
  raisedRao = 30n * RAO,
  targetByte = 0x33 as number | null,
  callTag = 0,
  callBody = new Uint8Array(0),
  finalized = 1,
  contributorsCount = 3,
} = {}) {
  return concatBytes(
    repeatByte(creatorByte, 32),
    u64le(depositRao),
    u64le(minContributionRao),
    u32le(end),
    u64le(capRao),
    repeatByte(fundsByte, 32),
    u64le(raisedRao),
    targetByte === null
      ? new Uint8Array([0])
      : concatBytes(new Uint8Array([1]), repeatByte(targetByte, 32)),
    new Uint8Array([callTag]),
    callBody,
    new Uint8Array([finalized]),
    u32le(contributorsCount),
  );
}

// Stubs one JSON-RPC method at a time. `handlers` maps an RPC method name to
// a function of (params) -> result; anything unmapped is a hard test failure
// rather than a silent undefined, so a route that starts making an unexpected
// call is caught here rather than in production.
function rpcStub(handlers: Record<string, AnyFn>, opts: Row = {}) {
  return async (_url: string, init: Row) => {
    const body = JSON.parse(String(init.body)) as Row;
    const method = String(body.method);
    if (opts.httpError)
      return { ok: false, status: 502 } as unknown as Response;
    if (opts.throws) throw new Error("network down");
    const handler = handlers[method];
    assert.ok(handler, `unexpected RPC method ${method}`);
    return {
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: handler(body.params),
      }),
    } as unknown as Response;
  };
}

// state_queryStorageAt's response shape: one block entry whose `changes` is a
// [key, value|null] pair per requested key.
function queryStorageAtResult(entries: [string, string | null][]) {
  return [{ block: "0xblock", changes: entries }];
}

function kvStub(store = new Map<string, string>(), opts: Row = {}) {
  return {
    get: async (key: string, _o?: Row) => {
      if (opts.getThrows) throw new Error("kv down");
      const raw = store.get(key);
      return raw === undefined ? null : JSON.parse(raw);
    },
    put: async (key: string, value: string, options?: Row) => {
      if (opts.putThrows) throw new Error("kv down");
      store.set(key, value);
      (opts.puts as Row[] | undefined)?.push({ key, value, options });
    },
  };
}

describe("isCrowdloanId", () => {
  test("accepts the u32 range and rejects everything outside it", () => {
    assert.equal(isCrowdloanId(0), true);
    assert.equal(isCrowdloanId(15), true);
    assert.equal(isCrowdloanId(4294967295), true);
    assert.equal(isCrowdloanId(4294967296), false);
    assert.equal(isCrowdloanId(-1), false);
    assert.equal(isCrowdloanId(1.5), false);
    assert.equal(isCrowdloanId("3"), false);
    assert.equal(isCrowdloanId(null), false);
    assert.equal(isCrowdloanId(undefined), false);
  });
});

describe("decodeCrowdloan", () => {
  test("decodes a full record with a target address", () => {
    const decoded = decodeCrowdloan(hex(encodeCrowdloan())) as Row;
    assert.equal(decoded.creator, encodeAccountId32(repeatByte(0x11, 32)));
    assert.equal(decoded.deposit_tao, 10);
    assert.equal(decoded.min_contribution_tao, 0.1);
    assert.equal(decoded.end, 6_989_100);
    assert.equal(decoded.cap_tao, 30);
    assert.equal(
      decoded.funds_account,
      encodeAccountId32(repeatByte(0x22, 32)),
    );
    assert.equal(decoded.raised_tao, 30);
    assert.equal(
      decoded.target_address,
      encodeAccountId32(repeatByte(0x33, 32)),
    );
    assert.equal(decoded.has_dispatch_call, false);
    assert.equal(decoded.finalized, true);
    assert.equal(decoded.contributors_count, 3);
    assert.equal(decoded.percent_raised, 100);
  });

  test("decodes a record with no target address", () => {
    const decoded = decodeCrowdloan(
      hex(encodeCrowdloan({ targetByte: null })),
    ) as Row;
    assert.equal(decoded.target_address, null);
    assert.equal(decoded.has_dispatch_call, false);
  });

  test("an unfinalized, partially-raised crowdloan reports its true percentage", () => {
    const decoded = decodeCrowdloan(
      hex(
        encodeCrowdloan({
          capRao: 200n * RAO,
          raisedRao: 50n * RAO,
          finalized: 0,
          contributorsCount: 7,
        }),
      ),
    ) as Row;
    assert.equal(decoded.finalized, false);
    assert.equal(decoded.raised_tao, 50);
    assert.equal(decoded.percent_raised, 25);
    assert.equal(decoded.contributors_count, 7);
  });

  // The whole reason the two trailing fields are read from the tail rather
  // than forwards: a Some-valued `call` is a variable-width Bounded<Call> this
  // module cannot decode, and reading forwards past it would land on the
  // wrong bytes.
  test("a Some-valued dispatch call still yields correct trailing fields", () => {
    const decoded = decodeCrowdloan(
      hex(
        encodeCrowdloan({
          callTag: 1,
          callBody: repeatByte(0xab, 41),
          finalized: 0,
          contributorsCount: 99,
        }),
      ),
    ) as Row;
    assert.equal(decoded.has_dispatch_call, true);
    assert.equal(decoded.finalized, false);
    assert.equal(decoded.contributors_count, 99);
  });

  test("a zero cap yields a null percentage rather than dividing by zero", () => {
    const decoded = decodeCrowdloan(
      hex(encodeCrowdloan({ capRao: 0n, raisedRao: 0n })),
    ) as Row;
    assert.equal(decoded.cap_tao, 0);
    assert.equal(decoded.percent_raised, null);
  });

  test("rao below one TAO keeps full precision", () => {
    const decoded = decodeCrowdloan(
      hex(encodeCrowdloan({ raisedRao: 1_500_000_000n, capRao: 3n * RAO })),
    ) as Row;
    assert.equal(decoded.raised_tao, 1.5);
    assert.equal(decoded.percent_raised, 50);
  });

  test("returns null on malformed input rather than throwing", () => {
    assert.equal(decodeCrowdloan(null), null);
    assert.equal(decodeCrowdloan(undefined), null);
    assert.equal(decodeCrowdloan(42), null);
    assert.equal(decodeCrowdloan("not-hex"), null);
    assert.equal(decodeCrowdloan("0xabc"), null, "odd-length hex");
    assert.equal(decodeCrowdloan("0x00"), null, "too short");
  });

  test("rejects a malformed Option<AccountId32> tag", () => {
    const bytes = encodeCrowdloan();
    bytes[100] = 7; // the target_address Option tag
    assert.equal(decodeCrowdloan(hex(bytes)), null);
  });

  test("rejects a malformed Option<Call> tag", () => {
    const bytes = encodeCrowdloan();
    bytes[133] = 9; // the call Option tag, after a Some target
    assert.equal(decodeCrowdloan(hex(bytes)), null);
  });

  test("rejects a malformed bool", () => {
    const bytes = encodeCrowdloan();
    bytes[bytes.length - 5] = 2; // finalized is neither 0 nor 1
    assert.equal(decodeCrowdloan(hex(bytes)), null);
  });

  test("rejects a Some target that overruns the buffer", () => {
    // Fixed prefix + a Some tag, then truncated before the 32-byte address
    // plus the trailer it promises.
    const truncated = concatBytes(
      repeatByte(0x11, 32),
      u64le(0n),
      u64le(0n),
      u32le(0),
      u64le(0n),
      repeatByte(0x22, 32),
      u64le(0n),
      new Uint8Array([1]),
      repeatByte(0x33, 20),
    );
    assert.equal(decodeCrowdloan(hex(truncated)), null);
  });
});

describe("loadCrowdloans", () => {
  const nextIdOnly = (n: number) => ({
    state_getStorage: () => hex(u32le(n)),
  });

  test("lists every crowdloan the chain reports", async () => {
    const record = hex(encodeCrowdloan({ contributorsCount: 5 }));
    const puts: Row[] = [];
    const env = mockEnv({
      METAGRAPH_CONTROL: kvStub(new Map(), { puts }),
    }) as unknown as Env;
    const out = (await withFetchStub(
      rpcStub({
        state_getStorage: () => hex(u32le(3)),
        state_queryStorageAt: (params: unknown[]) =>
          queryStorageAtResult((params[0] as string[]).map((k) => [k, record])),
      }),
      () => loadCrowdloans(env),
    )) as Row;

    assert.equal(out.next_crowdloan_id, 3);
    assert.equal(out.crowdloan_count, 3);
    const rows = out.crowdloans as Row[];
    assert.deepEqual(
      rows.map((r) => r.crowdloan_id),
      [0, 1, 2],
    );
    assert.equal(rows[0].contributors_count, 5);
    assert.deepEqual(out.field_sources, CROWDLOANS_FIELD_SOURCES);
    // A successful read caches for the full TTL.
    assert.equal(puts[0].options?.expirationTtl, CROWDLOANS_KV_TTL);
  });

  // dissolve() removes the record while NextCrowdloanId keeps counting, so a
  // gap is normal chain state, not an error — and must not appear as a null
  // hole in the array.
  test("omits dissolved ids instead of emitting null holes", async () => {
    const record = hex(encodeCrowdloan());
    const env = mockEnv({ METAGRAPH_CONTROL: kvStub() }) as unknown as Env;
    const out = (await withFetchStub(
      rpcStub({
        state_getStorage: () => hex(u32le(3)),
        state_queryStorageAt: (params: unknown[]) =>
          queryStorageAtResult(
            (params[0] as string[]).map((k, i) => [k, i === 1 ? null : record]),
          ),
      }),
      () => loadCrowdloans(env),
    )) as Row;

    assert.equal(out.next_crowdloan_id, 3);
    assert.equal(out.crowdloan_count, 2, "the dissolved id is omitted");
    assert.deepEqual(
      (out.crowdloans as Row[]).map((r) => r.crowdloan_id),
      [0, 2],
      "surviving ids keep their real crowdloan_id, not an array index",
    );
  });

  test("an absent NextCrowdloanId is a confirmed empty chain, not a failure", async () => {
    const puts: Row[] = [];
    const env = mockEnv({
      METAGRAPH_CONTROL: kvStub(new Map(), { puts }),
    }) as unknown as Env;
    const out = (await withFetchStub(
      rpcStub({ state_getStorage: () => null }),
      () => loadCrowdloans(env),
    )) as Row;
    assert.equal(out.next_crowdloan_id, 0);
    assert.equal(out.crowdloan_count, 0);
    assert.deepEqual(out.crowdloans, []);
    assert.equal(puts[0].options?.expirationTtl, CROWDLOANS_KV_TTL);
  });

  test("an RPC failure yields a null next_crowdloan_id on the short TTL", async () => {
    const puts: Row[] = [];
    const env = mockEnv({
      METAGRAPH_CONTROL: kvStub(new Map(), { puts }),
    }) as unknown as Env;
    const out = (await withFetchStub(rpcStub({}, { httpError: true }), () =>
      loadCrowdloans(env),
    )) as Row;
    assert.equal(out.next_crowdloan_id, null);
    assert.deepEqual(out.crowdloans, []);
    assert.equal(puts[0].options?.expirationTtl, CROWDLOANS_NEGATIVE_KV_TTL);
  });

  test("a thrown fetch is caught, not propagated", async () => {
    const env = mockEnv({ METAGRAPH_CONTROL: kvStub() }) as unknown as Env;
    const out = (await withFetchStub(rpcStub({}, { throws: true }), () =>
      loadCrowdloans(env),
    )) as Row;
    assert.equal(out.next_crowdloan_id, null);
  });

  test("a malformed NextCrowdloanId is treated as unknown", async () => {
    const env = mockEnv({ METAGRAPH_CONTROL: kvStub() }) as unknown as Env;
    const out = (await withFetchStub(
      rpcStub({ state_getStorage: () => "0xdead" }),
      () => loadCrowdloans(env),
    )) as Row;
    assert.equal(out.next_crowdloan_id, null);
    assert.deepEqual(out.crowdloans, []);
  });

  test("a failed batch read degrades to empty on the short TTL", async () => {
    const puts: Row[] = [];
    const env = mockEnv({
      METAGRAPH_CONTROL: kvStub(new Map(), { puts }),
    }) as unknown as Env;
    const out = (await withFetchStub(
      rpcStub({
        state_getStorage: () => hex(u32le(2)),
        state_queryStorageAt: () => null,
      }),
      () => loadCrowdloans(env),
    )) as Row;
    assert.equal(out.next_crowdloan_id, 2);
    assert.deepEqual(out.crowdloans, []);
    assert.equal(puts[0].options?.expirationTtl, CROWDLOANS_NEGATIVE_KV_TTL);
  });

  test("a batch response missing its changes array degrades to empty", async () => {
    const env = mockEnv({ METAGRAPH_CONTROL: kvStub() }) as unknown as Env;
    const out = (await withFetchStub(
      rpcStub({
        state_getStorage: () => hex(u32le(2)),
        state_queryStorageAt: () => [{ block: "0xblock" }],
      }),
      () => loadCrowdloans(env),
    )) as Row;
    assert.deepEqual(out.crowdloans, []);
  });

  test("malformed change entries are skipped, not fatal", async () => {
    const record = hex(encodeCrowdloan());
    const env = mockEnv({ METAGRAPH_CONTROL: kvStub() }) as unknown as Env;
    const out = (await withFetchStub(
      rpcStub({
        state_getStorage: () => hex(u32le(2)),
        state_queryStorageAt: (params: unknown[]) => {
          const keys = params[0] as string[];
          return [
            {
              block: "0xblock",
              changes: [
                "not-a-pair",
                [keys[0]],
                [123, record],
                [keys[1], record],
              ],
            },
          ];
        },
      }),
      () => loadCrowdloans(env),
    )) as Row;
    assert.equal(out.crowdloan_count, 1);
    assert.equal((out.crowdloans as Row[])[0].crowdloan_id, 1);
  });

  // Guards the fan-out: a corrupt NextCrowdloanId must not turn one request
  // into an unbounded batch of storage keys.
  test("clamps the fan-out to MAX_CROWDLOANS_FANOUT", async () => {
    let requestedKeys = 0;
    const env = mockEnv({ METAGRAPH_CONTROL: kvStub() }) as unknown as Env;
    await withFetchStub(
      rpcStub({
        state_getStorage: () => hex(u32le(4_000_000_000)),
        state_queryStorageAt: (params: unknown[]) => {
          requestedKeys = (params[0] as string[]).length;
          return queryStorageAtResult([]);
        },
      }),
      () => loadCrowdloans(env),
    );
    assert.equal(requestedKeys, MAX_CROWDLOANS_FANOUT);
  });

  test("serves a cached payload without touching the chain", async () => {
    const store = new Map<string, string>([
      [
        "crowdloans:index",
        JSON.stringify({ schema_version: 1, crowdloan_count: 1, cached: true }),
      ],
    ]);
    const env = mockEnv({ METAGRAPH_CONTROL: kvStub(store) }) as unknown as Env;
    const out = (await withFetchStub(
      () => assert.fail("cache hit must not hit the RPC"),
      () => loadCrowdloans(env),
    )) as Row;
    assert.equal(out.cached, true);
    assert.deepEqual(out.field_sources, CROWDLOANS_FIELD_SOURCES);
  });

  test("a KV read failure falls through to the live RPC", async () => {
    const env = mockEnv({
      METAGRAPH_CONTROL: kvStub(new Map(), { getThrows: true }),
    }) as unknown as Env;
    const out = (await withFetchStub(rpcStub(nextIdOnly(0)), () =>
      loadCrowdloans(env),
    )) as Row;
    assert.equal(out.next_crowdloan_id, 0);
  });

  test("a KV write failure is non-fatal", async () => {
    const env = mockEnv({
      METAGRAPH_CONTROL: kvStub(new Map(), { putThrows: true }),
    }) as unknown as Env;
    const out = (await withFetchStub(rpcStub(nextIdOnly(0)), () =>
      loadCrowdloans(env),
    )) as Row;
    assert.equal(out.next_crowdloan_id, 0);
  });

  test("works with no KV binding at all", async () => {
    const env = mockEnv({ METAGRAPH_CONTROL: undefined }) as unknown as Env;
    const out = (await withFetchStub(rpcStub(nextIdOnly(0)), () =>
      loadCrowdloans(env),
    )) as Row;
    assert.equal(out.next_crowdloan_id, 0);
  });
});

describe("loadCrowdloan", () => {
  test("returns a decoded record for an existing id", async () => {
    const puts: Row[] = [];
    const env = mockEnv({
      METAGRAPH_CONTROL: kvStub(new Map(), { puts }),
    }) as unknown as Env;
    const out = (await withFetchStub(
      rpcStub({
        state_getStorage: () => hex(encodeCrowdloan({ contributorsCount: 12 })),
      }),
      () => loadCrowdloan(env, 7),
    )) as Row;
    assert.equal(out.crowdloan_id, 7);
    assert.equal(out.exists, true);
    assert.equal((out.crowdloan as Row).crowdloan_id, 7);
    assert.equal((out.crowdloan as Row).contributors_count, 12);
    assert.deepEqual(out.field_sources, CROWDLOAN_FIELD_SOURCES);
    assert.equal(puts[0].options?.expirationTtl, CROWDLOANS_KV_TTL);
  });

  test("a confirmed-absent id is exists:false, not null", async () => {
    const env = mockEnv({ METAGRAPH_CONTROL: kvStub() }) as unknown as Env;
    const out = (await withFetchStub(
      rpcStub({ state_getStorage: () => null }),
      () => loadCrowdloan(env, 99),
    )) as Row;
    assert.equal(out.exists, false);
    assert.equal(out.crowdloan, null);
  });

  // The distinction the route exists to preserve: "no such crowdloan" must be
  // distinguishable from "we could not find out".
  test("an RPC failure is exists:null, not exists:false", async () => {
    const puts: Row[] = [];
    const env = mockEnv({
      METAGRAPH_CONTROL: kvStub(new Map(), { puts }),
    }) as unknown as Env;
    const out = (await withFetchStub(rpcStub({}, { httpError: true }), () =>
      loadCrowdloan(env, 1),
    )) as Row;
    assert.equal(out.exists, null);
    assert.equal(out.crowdloan, null);
    assert.equal(puts[0].options?.expirationTtl, CROWDLOANS_NEGATIVE_KV_TTL);
  });

  test("an undecodable record is exists:null, not a partial row", async () => {
    const env = mockEnv({ METAGRAPH_CONTROL: kvStub() }) as unknown as Env;
    const out = (await withFetchStub(
      rpcStub({ state_getStorage: () => "0xdeadbeef" }),
      () => loadCrowdloan(env, 1),
    )) as Row;
    assert.equal(out.exists, null);
    assert.equal(out.crowdloan, null);
  });

  test("rejects an out-of-range id before any RPC", async () => {
    const env = mockEnv({ METAGRAPH_CONTROL: kvStub() }) as unknown as Env;
    await assert.rejects(
      () =>
        withFetchStub(
          () => assert.fail("must not reach the RPC"),
          () => loadCrowdloan(env, 4294967296),
        ),
      RangeError,
    );
  });

  test("serves a cached payload without touching the chain", async () => {
    const store = new Map<string, string>([
      ["crowdloan:4", JSON.stringify({ schema_version: 1, cached: true })],
    ]);
    const env = mockEnv({ METAGRAPH_CONTROL: kvStub(store) }) as unknown as Env;
    const out = (await withFetchStub(
      () => assert.fail("cache hit must not hit the RPC"),
      () => loadCrowdloan(env, 4),
    )) as Row;
    assert.equal(out.cached, true);
  });

  test("a KV read failure falls through to the live RPC", async () => {
    const env = mockEnv({
      METAGRAPH_CONTROL: kvStub(new Map(), { getThrows: true }),
    }) as unknown as Env;
    const out = (await withFetchStub(
      rpcStub({ state_getStorage: () => null }),
      () => loadCrowdloan(env, 4),
    )) as Row;
    assert.equal(out.exists, false);
  });

  test("a KV write failure is non-fatal", async () => {
    const env = mockEnv({
      METAGRAPH_CONTROL: kvStub(new Map(), { putThrows: true }),
    }) as unknown as Env;
    const out = (await withFetchStub(
      rpcStub({ state_getStorage: () => null }),
      () => loadCrowdloan(env, 4),
    )) as Row;
    assert.equal(out.exists, false);
  });

  test("works with no KV binding at all", async () => {
    const env = mockEnv({ METAGRAPH_CONTROL: undefined }) as unknown as Env;
    const out = (await withFetchStub(
      rpcStub({ state_getStorage: () => null }),
      () => loadCrowdloan(env, 4),
    )) as Row;
    assert.equal(out.exists, false);
  });
});

describe("the crowdloan routes", () => {
  test("GET /api/v1/crowdloans serves the list", async () => {
    const env = mockEnv({ METAGRAPH_CONTROL: kvStub() }) as unknown as Env;
    const res = await withFetchStub(
      rpcStub({
        state_getStorage: () => hex(u32le(1)),
        state_queryStorageAt: (params: unknown[]) =>
          queryStorageAtResult([
            [(params[0] as string[])[0], hex(encodeCrowdloan())],
          ]),
      }),
      () => handleRequest(req("/api/v1/crowdloans"), env),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal(body.ok, true);
    assert.equal((body.data as Row).crowdloan_count, 1);
  });

  test("GET /api/v1/crowdloans/{id} serves one record", async () => {
    const env = mockEnv({ METAGRAPH_CONTROL: kvStub() }) as unknown as Env;
    const res = await withFetchStub(
      rpcStub({ state_getStorage: () => hex(encodeCrowdloan()) }),
      () => handleRequest(req("/api/v1/crowdloans/2"), env),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Row;
    assert.equal((body.data as Row).crowdloan_id, 2);
    assert.equal((body.data as Row).exists, true);
  });

  test("an unknown query param is a 400 on both routes", async () => {
    const env = mockEnv({ METAGRAPH_CONTROL: kvStub() }) as unknown as Env;
    for (const path of [
      "/api/v1/crowdloans?limit=5",
      "/api/v1/crowdloans/1?x=1",
    ]) {
      const res = await withFetchStub(
        () => assert.fail("must not reach the RPC"),
        () => handleRequest(req(path), env),
      );
      assert.equal(res.status, 400, path);
    }
  });

  // The router's own regex only matches \d+, so an id above u32 is the only
  // way to reach the handler's range check.
  test("an out-of-range id is a 400, not a 500", async () => {
    const env = mockEnv({ METAGRAPH_CONTROL: kvStub() }) as unknown as Env;
    const res = await withFetchStub(
      () => assert.fail("must not reach the RPC"),
      () => handleRequest(req("/api/v1/crowdloans/4294967296"), env),
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as Row;
    assert.equal((body.error as Row).code, "invalid_crowdloan_id");
  });

  test("a non-numeric id does not match the route at all", async () => {
    const env = mockEnv({ METAGRAPH_CONTROL: kvStub() }) as unknown as Env;
    const res = await handleRequest(req("/api/v1/crowdloans/abc"), env);
    assert.equal(res.status, 404);
  });

  test("both routes rate-limit per client", async () => {
    const env = mockEnv({
      METAGRAPH_CONTROL: kvStub(),
      RPC_RATE_LIMITER: { limit: async () => ({ success: false }) },
    }) as unknown as Env;
    for (const path of ["/api/v1/crowdloans", "/api/v1/crowdloans/1"]) {
      const res = await withFetchStub(
        () => assert.fail("a rate-limited request must not reach the RPC"),
        () => handleRequest(req(path), env),
      );
      assert.equal(res.status, 429, path);
      const body = (await res.json()) as Row;
      assert.equal((body.error as Row).code, "crowdloan_rate_limited");
      assert.ok(res.headers.get("retry-after"));
    }
  });

  test("a passing rate limiter lets the request through", async () => {
    const env = mockEnv({
      METAGRAPH_CONTROL: kvStub(),
      RPC_RATE_LIMITER: { limit: async () => ({ success: true }) },
    }) as unknown as Env;
    const res = await withFetchStub(
      rpcStub({ state_getStorage: () => null }),
      () => handleRequest(req("/api/v1/crowdloans/1"), env),
    );
    assert.equal(res.status, 200);
  });

  // Both routes read finney storage directly, so they must be mainnet-only —
  // a testnet-prefixed request has nothing to answer from.
  test("the routes serve testnet's own crowdloans, from the testnet RPC", async () => {
    // Was asserted mainnet-only because src/crowdloans.ts hardcoded the finney
    // endpoint. The Crowdloan pallet is present and identical on testnet, with
    // its own NextCrowdloanId sequence, so #8700 reads whichever chain was
    // asked for. Asserting the endpoint rather than the body: both chains
    // return a well-formed 200, so only the URL distinguishes a correct answer
    // from finney's numbers served under a testnet path.
    const env = mockEnv({ METAGRAPH_CONTROL: kvStub() }) as unknown as Env;
    const seen: string[] = [];
    await withFetchStub(
      async (url: unknown) => {
        seen.push(String(url));
        return {
          ok: true,
          json: async () => ({ jsonrpc: "2.0", id: 1, result: null }),
        };
      },
      async () => {
        for (const path of [
          "/api/v1/testnet/crowdloans",
          "/api/v1/testnet/crowdloans/1",
        ]) {
          const res = await handleRequest(req(path), env);
          assert.equal(res.status, 200, path);
        }
        assert.ok(seen.length > 0, "no RPC call was made");
        for (const url of seen) {
          assert.ok(
            url.startsWith("https://test.finney.opentensor.ai"),
            `testnet request read from ${url}`,
          );
        }
      },
    );
  });
});

// A golden value captured from live finney on 2026-08-02 (crowdloan id 0).
// Pins the exact on-chain byte layout this module's decoder assumes: if a
// runtime upgrade reorders or resizes a CrowdloanInfo field, this fails
// loudly here rather than silently serving wrong numbers. Account bytes are
// zeroed — the layout, not the identities, is what is under test.
describe("the on-chain layout", () => {
  test("a real 139-byte record decodes to its known values", () => {
    const golden = concatBytes(
      repeatByte(0x00, 32), // creator
      u64le(10n * RAO), // deposit: 10 TAO
      u64le(100_000_000n), // min_contribution: 0.1 TAO
      u32le(6_989_100), // end
      u64le(30n * RAO), // cap: 30 TAO
      repeatByte(0x00, 32), // funds_account
      u64le(30n * RAO), // raised: 30 TAO
      new Uint8Array([1]),
      repeatByte(0x00, 32), // target_address: Some
      new Uint8Array([0]), // call: None
      new Uint8Array([1]), // finalized: true
      u32le(3), // contributors_count
    );
    assert.equal(golden.length, 139, "the live record length");
    const decoded = decodeCrowdloan(hex(golden)) as Row;
    assert.equal(decoded.deposit_tao, 10);
    assert.equal(decoded.min_contribution_tao, 0.1);
    assert.equal(decoded.end, 6_989_100);
    assert.equal(decoded.cap_tao, 30);
    assert.equal(decoded.raised_tao, 30);
    assert.equal(decoded.finalized, true);
    assert.equal(decoded.contributors_count, 3);
    assert.equal(decoded.percent_raised, 100);
  });
});
