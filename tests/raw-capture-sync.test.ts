// Wiring tests for src/raw-capture-sync.ts. The capture guarantee itself is
// proven in tests/raw-chain-capture.test.ts; what matters here is that the
// lane REFUSES to run when it could not honour that guarantee — an unbound
// store or watermark must be a loud no-op, never a quiet one, because a lane
// that silently does nothing looks exactly like a healthy one.
import assert from "node:assert/strict";
import { RAW_CAPTURE_CRON } from "../workers/config.ts";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, test, vi } from "vitest";
import { pgMockEnv } from "./helpers/pg-mock.ts";

// The watermark's store is Postgres now (#10179): both halves of it --
// neonWatermark's read and mirrorRawCaptureStateToNeon's write -- build their
// own `new Client(...)`, so there is no handle a caller can inject. Mocking the
// module is the seam, and the real SQLite fixture below is attached to the
// controller so the watermark SQL is EXECUTED rather than merely recorded --
// which is the whole point of this file's fixture: the one thing that can break
// here is a column name, and a fake that records SQL never parses it.
//
// See tests/helpers/pg-mock.ts for why the controller has to be built inside
// vi.hoisted: vi.mock is hoisted above every import, so a plain `const` is read
// before initialisation.
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import {
  watermarkRead,
  RAW_CAPTURE_GENESIS_FLOOR,
  RAW_CAPTURE_LANES,
  cronStepMinutes,
  MAX_CAPTURE_CHUNK_BLOCKS,
  pacedLaneBudget,
  REQUESTS_PER_CHUNK,
  RPC_REQUESTS_PER_MINUTE_LIMIT,
  runRawCaptureSync,
  TESTNET_RAW_CAPTURE_GENESIS_FLOOR,
} from "../src/raw-capture-sync.ts";

/**
 * The raw-capture migrations, IN ORDER — 0006 creates the table, 0013 rebuilds
 * it with a network dimension (#8700).
 *
 * Applied as a chain rather than as a single final schema on purpose. D1
 * migrations in this repo are applied BY HAND to production, so the thing worth
 * proving is not "the end state parses" but "0013 applies cleanly on top of a
 * live 0006 table and carries its row across" — 0013 drops and recreates the
 * table, and a mistake there silently resets the mainnet watermark to the
 * floor, which would re-capture ~3,000 blocks and briefly report a gap that
 * does not exist.
 */
const MIGRATIONS = ["0006_raw_capture.sql", "0013_raw_capture_network.sql"].map(
  (name) =>
    fs.readFileSync(
      path.join(process.cwd(), "tests/fixtures/sqlite-schema", name),
      "utf8",
    ),
);

function applyMigrations(target: InstanceType<typeof DatabaseSync>) {
  for (const sql of MIGRATIONS) target.exec(sql);
}

let db: InstanceType<typeof DatabaseSync>;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  applyMigrations(db);
  pg.control.db = db;
  pg.control.queries.length = 0;
});

/** A `first()/run()/query()` facade over the same real SQLite database.
 *
 * Still hand-built rather than taken from the mock, because `watermarkRead` is
 * a READ-ONLY helper that takes a handle -- the lakehouse-seam watchdog passes
 * it one from `readStore` -- so its tests exercise the function directly rather
 * than through a store the lane resolves for itself. */
function runner() {
  return {
    first: async (sql: string, values: unknown[] = []) =>
      (db.prepare(sql).get(...(values as never[])) ?? null) as Record<
        string,
        unknown
      > | null,
    run: async (sql: string, values: unknown[] = []) => {
      db.prepare(sql).run(...(values as never[]));
      return { changes: 1 };
    },
    query: async (sql: string, values: unknown[] = []) =>
      db.prepare(sql).all(...(values as never[])) as Record<string, unknown>[],
  };
}

/** One call's answer, or a whole-request HTTP failure. */
type NodeReply =
  { result?: unknown; error?: { message: string } } | { httpStatus: number };

/**
 * Turns a per-CALL answer into a fetch that speaks BOTH wire forms the lane
 * uses: a single JSON-RPC request, and a BATCH array.
 *
 * Shared because every stub below needs both, and a stub that only understood
 * single requests would answer a batch with one envelope -- which the client
 * correctly refuses, so every capture assertion would fail for a reason that
 * has nothing to do with what it is testing.
 */
function jsonRpcNode(
  answer: (method: string, params: unknown[], url: string) => NodeReply,
) {
  return (async (url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as
      | { method: string; params: unknown[] }
      | { id: number; method: string; params: unknown[] }[];
    const host = String(url);
    const calls = Array.isArray(body) ? body : [body];
    const replies = calls.map((call) => answer(call.method, call.params, host));
    // A transport failure is a property of the REQUEST, so one bad call in a
    // batch fails the whole thing -- which is what a real 503 does.
    const failed = replies.find(
      (reply): reply is { httpStatus: number } => "httpStatus" in reply,
    );
    if (failed) return { ok: false, status: failed.httpStatus } as Response;
    if (!Array.isArray(body)) {
      return { ok: true, json: async () => replies[0] } as unknown as Response;
    }
    return {
      ok: true,
      json: async () =>
        body.map((call, index) => ({
          id: call.id,
          ...(replies[index] as object),
        })),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** `chain_getBlockHash` answers a LIST for a list, a bare value otherwise. */
function hashList(params: unknown[], tag = ""): NodeReply {
  const first = params[0];
  const wanted = (Array.isArray(first) ? first : [first]) as number[];
  const hashes = wanted.map((n) => `0x${tag}h${n}`);
  return { result: Array.isArray(first) ? hashes : hashes[0] };
}

/**
 * A chain stub that answers per ENDPOINT, not globally (#8700).
 *
 * The lane runs mainnet and testnet in one tick against different URLs, so a
 * URL-blind stub would give both the same head and make every single-lane
 * assertion below ambiguous. `testnetHead` defaults BELOW the testnet floor,
 * which makes that lane a legitimate no-op ("nothing to capture yet") rather
 * than a mocked-away one — the mainnet assertions then mean exactly what they
 * meant before testnet existed.
 */
function rpcFetch(
  head: number,
  testnetHead: number = TESTNET_RAW_CAPTURE_GENESIS_FLOOR - 1,
) {
  return jsonRpcNode((method, params, url) => {
    const isTestnet = url.includes("test.finney");
    const chainHead = isTestnet ? testnetHead : head;
    const tag = isTestnet ? "t" : "m";
    if (method === "chain_getHeader")
      return { result: { number: `0x${chainHead.toString(16)}` } };
    // Hashes are tagged per chain so a test can prove the bytes under a
    // testnet key came from the testnet endpoint.
    if (method === "chain_getBlockHash") return hashList(params, tag);
    if (method === "chain_getBlock")
      return {
        result: {
          block: { header: { parentHash: `0x${tag}p` }, extrinsics: ["0xaa"] },
        },
      };
    return { result: `0x${tag}events` };
  });
}

function envWith(over: Record<string, unknown> = {}) {
  const puts = new Map<string, string>();
  const env = {
    RAW_CAPTURE_ENABLED: "true",
    METAGRAPH_ARCHIVE: {
      put: async (k: string, v: string) => void puts.set(k, v),
    },
    ...pgMockEnv(),
    // Narrowed to this lane, and stated here rather than left to the helper,
    // because the two flags are NOT interchangeable and this lane is where
    // that bites: the refusal gate reads NEON_SOLE_STORE_TABLES ("is there a
    // durable watermark at all") while the write inside
    // mirrorRawCaptureStateToNeon ran gated on the dual-write flag ("may this
    // lane write"). Declare only the first and the lane runs, reports ok, and
    // silently never persists a watermark -- so every tick re-captures from
    // the genesis floor. Verified: dropping this line alone turns the
    // resume-from-the-watermark test below into a 5-block re-capture.
    ...over,
  };
  return { env, puts };
}

/** Pacing has its own tests; every other test skips the wait. */
const noSleep = async () => {};

/** The Worker's ExecutionContext, as this lane uses it: createPgSql hands the
 * pooled connection back through waitUntil, so the watermark's read and write
 * are both unreachable without one. workers/api.ts passes the real ctx. */
const CTX = { waitUntil: () => {} };

describe("runRawCaptureSync — refusal paths", () => {
  test("disabled is a quiet no-op, not an error", async () => {
    const captures: unknown[] = [];
    const { env } = envWith({ RAW_CAPTURE_ENABLED: undefined });
    const result = await runRawCaptureSync(env as never, {
      sleepFn: noSleep,
      ctx: CTX,
      recordException: (async (...a: unknown[]) => {
        captures.push(a);
        return true;
      }) as never,
    });
    assert.deepEqual(result, { ok: false, skipped: true, reason: "disabled" });
    assert.equal(captures.length, 0, "a deliberate off-state is not a fault");
  });

  test("an unbound R2 store refuses LOUDLY rather than dropping bytes", async () => {
    const captures: { route?: string }[] = [];
    const { env } = envWith({ METAGRAPH_ARCHIVE: undefined });
    const result = await runRawCaptureSync(env as never, {
      sleepFn: noSleep,
      ctx: CTX,
      recordException: (async (_e: unknown, ev: { route?: string }) => {
        captures.push(ev);
        return true;
      }) as never,
    });
    assert.equal(result.reason, "store_unavailable");
    assert.equal(captures.length, 1);
    assert.equal(captures[0]?.route, "raw-capture-sync");
  });

  // TWO ways to have no watermark, and the lane has to refuse on both. The
  // refusal is load-bearing rather than defensive: the capture resumes FROM
  // the stored value, so a tick that runs without one starts at the genesis
  // floor and re-captures the same blocks every five minutes, forever, while
  // every other signal says the lane is healthy.
  // The "not declared Neon's" arm retired with NEON_SOLE_STORE_TABLES
  // (#10051); the binding is the one way left to have no watermark store.
  for (const [what, over] of [
    ["Hyperdrive is unbound", { HYPERDRIVE: undefined }],
  ] as [string, Record<string, unknown>][]) {
    test(`an unbound watermark refuses LOUDLY when ${what}`, async () => {
      const captures: unknown[] = [];
      const { env, puts } = envWith(over);
      const result = await runRawCaptureSync(env as never, {
        sleepFn: noSleep,
        ctx: CTX,
        fetchImpl: rpcFetch(RAW_CAPTURE_GENESIS_FLOOR + 2),
        recordException: (async () => {
          captures.push(1);
          return true;
        }) as never,
      });
      assert.equal(result.reason, "watermark_unavailable");
      assert.equal(captures.length, 1);
      // Refused BEFORE capturing, not after: bytes written under a watermark
      // that cannot advance are bytes the next tick writes again.
      assert.equal(puts.size, 0);
    });
  }

  test("an RPC failure is contained and captured, never thrown at the scheduler", async () => {
    const captures: { route?: string }[] = [];
    const { env } = envWith();
    const result = await runRawCaptureSync(env as never, {
      sleepFn: noSleep,
      ctx: CTX,
      fetchImpl: (async () => {
        throw new Error("rpc down");
      }) as unknown as typeof fetch,
      recordException: (async (_e: unknown, ev: { route?: string }) => {
        captures.push(ev);
        return true;
      }) as never,
    });
    assert.equal(result.ok, false);
    assert.match(String(result.reason), /rpc down/);
    // One exception PER LANE, each attributed to its own network (#8700). A
    // single un-tagged capture would make "both chains are down" and "testnet
    // is down" the same alert.
    assert.deepEqual(captures.map((c) => c.route).sort(), [
      "raw-capture-sync:mainnet",
      "raw-capture-sync:testnet",
    ]);
  });
});

describe("runRawCaptureSync — capture", () => {
  test("first tick starts at the genesis floor and persists the watermark", async () => {
    const { env, puts } = envWith();
    const result = await runRawCaptureSync(env as never, {
      sleepFn: noSleep,
      ctx: CTX,
      fetchImpl: rpcFetch(RAW_CAPTURE_GENESIS_FLOOR + 2),
      now: () => 5000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.captured, 3);
    assert.equal(result.watermark, RAW_CAPTURE_GENESIS_FLOOR + 2);
    assert.equal(puts.size, 1);
    const row = db
      .prepare(
        `SELECT last_contiguous_block, updated_at FROM raw_capture_state`,
      )
      .get() as Record<string, number>;
    assert.equal(row.last_contiguous_block, RAW_CAPTURE_GENESIS_FLOOR + 2);
    assert.equal(row.updated_at, 5000);
  });

  test("a second tick resumes from the persisted watermark, not the floor", async () => {
    const { env, puts } = envWith();
    await runRawCaptureSync(env as never, {
      sleepFn: noSleep,
      ctx: CTX,
      fetchImpl: rpcFetch(RAW_CAPTURE_GENESIS_FLOOR + 1),
      now: () => 1,
    });
    const second = await runRawCaptureSync(env as never, {
      sleepFn: noSleep,
      ctx: CTX,
      fetchImpl: rpcFetch(RAW_CAPTURE_GENESIS_FLOOR + 4),
      now: () => 2,
    });
    assert.equal(second.captured, 3, "only the NEW blocks were captured");
    assert.equal(second.watermark, RAW_CAPTURE_GENESIS_FLOOR + 4);
    assert.equal(puts.size, 2, "two disjoint batches, no overlap");
  });

  test("caught up: no work and no write", async () => {
    const { env, puts } = envWith();
    await runRawCaptureSync(env as never, {
      sleepFn: noSleep,
      ctx: CTX,
      fetchImpl: rpcFetch(RAW_CAPTURE_GENESIS_FLOOR),
      now: () => 1,
    });
    const again = await runRawCaptureSync(env as never, {
      sleepFn: noSleep,
      ctx: CTX,
      fetchImpl: rpcFetch(RAW_CAPTURE_GENESIS_FLOOR),
      now: () => 2,
    });
    assert.equal(again.captured, 0);
    assert.equal(again.behind, 0);
    assert.equal(puts.size, 1);
  });

  test("reports lag so a backlog is observable rather than inferred", async () => {
    const { env } = envWith();
    const result = await runRawCaptureSync(env as never, {
      sleepFn: noSleep,
      ctx: CTX,
      fetchImpl: rpcFetch(RAW_CAPTURE_GENESIS_FLOOR + 10_000),
      now: () => 1,
    });
    // The DERIVED cap, not a literal: the budget follows the cron and the lane
    // count, so restating it here would be the second hand-written number
    // #9430 exists to remove.
    assert.equal(
      result.captured,
      RAW_CAPTURE_LANES[0]!.maxPerTick,
      "bounded per tick",
    );
    assert.ok(
      (result.behind ?? 0) > 9000,
      "still far behind, and says so — the next ticks drain it",
    );
  });

  test("a partial tick warns with its stop reason but still reports ok", async () => {
    const { env, puts } = envWith();
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
    // Head is reachable, but block floor+1 fails -- so the tick captures the
    // floor block and stops, which is the safe partial-run path.
    const failAt = RAW_CAPTURE_GENESIS_FLOOR + 1;
    const flaky = jsonRpcNode((method, params, url) => {
      const isTestnet = url.includes("test.finney");
      // Endpoint-aware for the same reason rpcFetch is: the testnet lane must
      // be a no-op here so `puts.size` still counts only the mainnet batch.
      if (method === "chain_getHeader")
        return {
          result: {
            number: isTestnet
              ? `0x${(TESTNET_RAW_CAPTURE_GENESIS_FLOOR - 1).toString(16)}`
              : `0x${(RAW_CAPTURE_GENESIS_FLOOR + 5).toString(16)}`,
          },
        };
      if (method === "chain_getBlockHash") return hashList(params);
      if (method === "chain_getBlock") {
        // A per-CALL refusal, which is how a node declines a height it cannot
        // serve. The chunk keeps its prefix and stops there -- the safe
        // partial-run path this test is about.
        if (params[0] === `0xh${failAt}`) {
          return { error: { message: `state already discarded at ${failAt}` } };
        }
        return {
          result: {
            block: { header: { parentHash: "0xp" }, extrinsics: ["0xaa"] },
          },
        };
      }
      return { result: "0xevents" };
    });
    try {
      const result = await runRawCaptureSync(env as never, {
        sleepFn: noSleep,
        ctx: CTX,
        fetchImpl: flaky,
        now: () => 9,
      });
      assert.equal(result.ok, true, "a partial tick is not a failed tick");
      assert.equal(result.captured, 1);
      assert.equal(result.stoppedAt, failAt);
      assert.equal(result.watermark, RAW_CAPTURE_GENESIS_FLOOR);
      assert.equal(puts.size, 1);
      assert.ok(
        warnings.some((w) => w.includes(`stopped at ${failAt}`)),
        "the stop is visible, so a stuck lane looks different from a slow one",
      );
    } finally {
      console.warn = realWarn;
    }
  });

  test("a thrown non-Error still yields a reason instead of 'undefined'", async () => {
    const { env } = envWith();
    const result = await runRawCaptureSync(env as never, {
      sleepFn: noSleep,
      ctx: CTX,
      fetchImpl: (async () => {
        throw "string failure";
      }) as unknown as typeof fetch,
      recordException: (async () => true) as never,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "string failure");
  });
});

// The read half of the watermark, which is all that survives as a standalone
// helper: the WRITE goes through neonWatermark, and the lakehouse-seam watchdog
// is the only caller that needs to read the row without writing it.
//
// Executed against a real engine rather than a recording fake, because the one
// thing that can break here is the column names being wrong -- and a fake that
// records SQL never parses it.
describe("watermarkRead", () => {
  test("returns null when no row exists yet", async () => {
    assert.equal(await watermarkRead(runner() as never)(), null);
  });

  test("reads back the row the capture lane writes, per network", async () => {
    db.prepare(
      `INSERT INTO raw_capture_state (network, last_contiguous_block, updated_at)
       VALUES (?, ?, ?)`,
    ).run("mainnet", 42, 7);
    db.prepare(
      `INSERT INTO raw_capture_state (network, last_contiguous_block, updated_at)
       VALUES (?, ?, ?)`,
    ).run("testnet", 99, 7);
    assert.equal(await watermarkRead(runner() as never, "mainnet")(), 42);
    assert.equal(await watermarkRead(runner() as never, "testnet")(), 99);
  });

  // A value that is not a number is not a watermark of zero: the capture
  // treats null as "start at the floor" and 0 as a real position, so
  // conflating them would re-capture from block 0.
  //
  // ASSERTED AGAINST A STUB, not the fixture, and deliberately so: 0013
  // declares `last_contiguous_block INTEGER NOT NULL`, and SQLite enforces it
  // -- the row this guard is about cannot be inserted at all. What CAN reach
  // the guard is a non-number from the driver: `pg` returns int8 as a STRING
  // unless a type parser is installed, and `typeof "8756635"` is not "number".
  // So the shapes below are the ones the store can actually hand back, which
  // is what the type guard is for.
  test("a non-numeric reading is null, never 0", async () => {
    for (const value of [null, undefined, "8756635", {}]) {
      const stub = {
        prepare: () => ({
          bind: () => ({
            first: async () => ({ last_contiguous_block: value }),
          }),
        }),
      };
      assert.equal(
        await watermarkRead(stub as never, "mainnet")(),
        null,
        JSON.stringify(value ?? null),
      );
    }
  });
});

// #8700: the testnet capture lane. The property that matters is ISOLATION —
// two chains writing block ranges into one bucket and one watermark table,
// where a collision would silently overwrite one chain's bytes with the
// other's and be invisible until someone decoded them.
describe("the testnet capture lane", () => {
  test("mainnet's R2 prefix and watermark row are untouched by testnet's", async () => {
    const { env, puts } = envWith();
    const result = await runRawCaptureSync(env as never, {
      sleepFn: noSleep,
      ctx: CTX,
      fetchImpl: rpcFetch(
        RAW_CAPTURE_GENESIS_FLOOR + 1,
        TESTNET_RAW_CAPTURE_GENESIS_FLOOR + 1,
      ),
      now: () => 5000,
    });
    assert.equal(result.ok, true);

    const keys = [...puts.keys()].sort();
    assert.equal(keys.length, 2, "one batch object per network");
    // Mainnet keeps the bare prefix the decode lane already lists.
    assert.ok(
      keys.some((k) => k.startsWith("chain/raw/blocks/")),
      `no mainnet key in ${keys.join(", ")}`,
    );
    assert.ok(
      keys.some((k) => k.startsWith("chain/raw/testnet/blocks/")),
      `no testnet key in ${keys.join(", ")}`,
    );
    // And neither is under the other's prefix.
    assert.equal(
      keys.filter((k) => k.startsWith("chain/raw/blocks/")).length,
      1,
      "testnet bytes must not land under the mainnet prefix",
    );

    // Spread to a plain object: node:sqlite returns null-prototype rows, which
    // deepEqual rejects against object literals even when every value matches.
    const rows = (
      db
        .prepare(
          `SELECT network, last_contiguous_block FROM raw_capture_state ORDER BY network`,
        )
        .all() as Record<string, unknown>[]
    ).map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      {
        network: "mainnet",
        last_contiguous_block: RAW_CAPTURE_GENESIS_FLOOR + 1,
      },
      {
        network: "testnet",
        last_contiguous_block: TESTNET_RAW_CAPTURE_GENESIS_FLOOR + 1,
      },
    ]);
  });

  test("the bytes under a testnet key came from the testnet endpoint", async () => {
    // The collision this guards against is not a crash — both chains produce
    // well-formed blocks — so the only proof is provenance in the payload.
    const { env, puts } = envWith();
    await runRawCaptureSync(env as never, {
      sleepFn: noSleep,
      ctx: CTX,
      fetchImpl: rpcFetch(
        RAW_CAPTURE_GENESIS_FLOOR,
        TESTNET_RAW_CAPTURE_GENESIS_FLOOR,
      ),
      now: () => 1,
    });
    for (const [key, body] of puts) {
      const first = JSON.parse(body.split("\n")[0]!) as {
        block_hash: string;
        events: string;
      };
      const expected = key.includes("/testnet/") ? "t" : "m";
      assert.ok(
        first.block_hash.startsWith(`0x${expected}h`),
        `${key} holds ${first.block_hash}, which came from the wrong chain`,
      );
      assert.equal(first.events, `0x${expected}events`);
    }
  });

  test("a testnet outage leaves the mainnet lane fully intact", async () => {
    // The reason the lanes run in sequence with independent error handling.
    const { env, puts } = envWith();
    const result = await runRawCaptureSync(env as never, {
      sleepFn: noSleep,
      ctx: CTX,
      fetchImpl: (async (url: unknown, init?: { body?: string }) => {
        if (String(url).includes("test.finney"))
          throw new Error("testnet down");
        return rpcFetch(RAW_CAPTURE_GENESIS_FLOOR + 1)(
          url as never,
          init as never,
        );
      }) as unknown as typeof fetch,
      now: () => 7,
      recordException: (async () => true) as never,
    });

    assert.equal(
      result.ok,
      true,
      "mainnet succeeded, so the tick is not a failure",
    );
    assert.equal(result.captured, 2, "mainnet captured its full batch");
    assert.equal(result.watermark, RAW_CAPTURE_GENESIS_FLOOR + 1);

    const lanes = result.lanes ?? [];
    const mainnet = lanes.find((lane) => lane.network === "mainnet");
    const testnet = lanes.find((lane) => lane.network === "testnet");
    assert.equal(mainnet?.ok, true);
    assert.equal(testnet?.ok, false);
    assert.match(String(testnet?.reason), /testnet down/);

    // Mainnet's watermark advanced and its bytes landed, despite the sibling.
    assert.equal(
      (
        db
          .prepare(
            `SELECT last_contiguous_block FROM raw_capture_state WHERE network = 'mainnet'`,
          )
          .get() as Record<string, number>
      ).last_contiguous_block,
      RAW_CAPTURE_GENESIS_FLOOR + 1,
    );
    assert.equal([...puts.keys()].length, 1);
    assert.equal(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM raw_capture_state WHERE network = 'testnet'`,
        )
        .get()?.n,
      0,
      "a failed lane must not leave a watermark claiming bytes it never wrote",
    );
  });

  test("every declared lane has a distinct network, endpoint and floor", () => {
    // Cheap, but it is the assertion that would have caught a copy-paste lane
    // pointing at mainnet's endpoint under a testnet label — which writes one
    // chain's blocks under the other's key with no error anywhere.
    const networks = RAW_CAPTURE_LANES.map((lane) => lane.network);
    assert.equal(new Set(networks).size, networks.length);
    const urls = RAW_CAPTURE_LANES.map((lane) => lane.defaultRpcUrl);
    assert.equal(new Set(urls).size, urls.length);
    const floors = RAW_CAPTURE_LANES.map((lane) => lane.genesisFloor);
    assert.equal(new Set(floors).size, floors.length);
    // The combined per-tick budget must stay inside the platform's
    // 1000-subrequest ceiling. COUNTED IN REQUESTS, NOT CALLS: a chunk costs
    // REQUESTS_PER_CHUNK however many blocks it carries, plus one head fetch
    // per lane. Counting calls here is what made this read 1,602 against a
    // ceiling of 1,000 for a tick that actually issues 66.
    const subrequests = RAW_CAPTURE_LANES.reduce(
      (total, lane) =>
        total +
        Math.ceil(lane.maxPerTick / MAX_CAPTURE_CHUNK_BLOCKS) *
          REQUESTS_PER_CHUNK +
        1,
      0,
    );
    assert.ok(
      subrequests < 1000,
      `a tick would issue ${subrequests} subrequests, over the Worker ceiling`,
    );
  });

  // This used to assert that a whole TICK fit inside one minute's allowance,
  // and that premise is exactly what capped testnet at 32 blocks (#9430). An
  // UNPACED tick fires its burst at network speed, so one minute bounds it
  // however long the tick is. A paced one spends the tick, so the tick bounds
  // it -- and what has to fit the limit is the RATE.
  test("the paced rate across all lanes stays inside the measured limit", () => {
    // MEASURED IN REQUESTS, because that is what the endpoint counts: one call
    // per request 429'd after 103, while fifty calls per request carried 1,400
    // through 140 requests untouched (2026-08-16). A gap between CHUNKS times
    // the requests a chunk costs is the lane's real rate.
    for (const lane of RAW_CAPTURE_LANES) {
      assert.ok(lane.minGapMs > 0, `${lane.network} is not paced at all`);
      const requestsPerMinute =
        (60_000 / lane.minGapMs) *
        REQUESTS_PER_CHUNK *
        RAW_CAPTURE_LANES.length;
      assert.ok(
        requestsPerMinute < RPC_REQUESTS_PER_MINUTE_LIMIT,
        `${lane.network} sustains ${requestsPerMinute.toFixed(0)} requests/min across ${RAW_CAPTURE_LANES.length} lanes, at or over ${RPC_REQUESTS_PER_MINUTE_LIMIT}/min`,
      );
    }
  });

  test("a paced tick finishes inside its own interval", () => {
    // Lanes run CONCURRENTLY, so the wall time is one lane's, not the sum --
    // but it still has to leave slack for jitter and a mid-tick redeploy.
    //
    // The gap is between CHUNK STARTS, so the span is the chunk COUNT times
    // the gap. Multiplying by the block count instead reads 20 minutes for a
    // tick that spends 45 seconds -- and would push the lane back to reading
    // one block at a time to satisfy it.
    const intervalMs = cronStepMinutes(RAW_CAPTURE_CRON) * 60_000;
    for (const lane of RAW_CAPTURE_LANES) {
      const chunks = Math.ceil(lane.maxPerTick / MAX_CAPTURE_CHUNK_BLOCKS);
      const spendMs = chunks * lane.minGapMs;
      assert.ok(
        spendMs < intervalMs,
        `${lane.network} would spend ${(spendMs / 60_000).toFixed(1)} min of a ${intervalMs / 60_000} min tick`,
      );
    }
  });

  // The paired positive: a budget test that only says "not too fast" is
  // satisfied by a lane that never catches up.
  test("the budget lets every lane outpace the chain it follows", () => {
    const ticksPerHour = 60 / cronStepMinutes(RAW_CAPTURE_CRON);
    for (const lane of RAW_CAPTURE_LANES) {
      const perHour = lane.maxPerTick * ticksPerHour;
      // Bittensor produces a block every 12 s on both chains.
      assert.ok(
        perHour > 3600 / 12,
        `${lane.network} captures ${perHour}/h against a chain producing 300/h -- it can never catch up`,
      );
    }
  });

  test("a third network would narrow the shared allowance", () => {
    const two = pacedLaneBudget(2, cronStepMinutes(RAW_CAPTURE_CRON));
    const three = pacedLaneBudget(3, cronStepMinutes(RAW_CAPTURE_CRON));
    assert.ok(three.maxBlocks < two.maxBlocks);
    assert.ok(three.minGapMs > two.minGapMs);
  });

  test("an unreadable cron narrows the budget rather than widening it", () => {
    assert.equal(cronStepMinutes("11,41 * * * *"), 5);
    assert.equal(cronStepMinutes(""), 5);
    assert.equal(cronStepMinutes("*/2 * * * *"), 2);
  });
});

// #9430. Concurrency is what turns the shared budget into throughput -- each
// lane gets the whole interval instead of half -- but only if isolation still
// holds, which now comes from runLane converting failures into results rather
// than from ordering.
describe("the lanes run concurrently, and stay isolated", () => {
  test("one lane's endpoint failing does not stop the other", async () => {
    const { env } = envWith();
    // Only the testnet endpoint fails.
    const result = (await runRawCaptureSync(env as never, {
      sleepFn: noSleep,
      ctx: CTX,
      now: () => 1,
      fetchImpl: (async (url: string, init: RequestInit) => {
        if (String(url).includes("test.finney")) {
          throw new Error("testnet endpoint down");
        }
        return rpcFetch(RAW_CAPTURE_GENESIS_FLOOR + 100)(
          url as never,
          init as never,
        );
      }) as never,
    })) as { lanes?: { network: string; ok: boolean; captured?: number }[] };
    const lanes = result.lanes ?? [];
    const mainnet = lanes.find((l) => l.network === "mainnet");
    const testnet = lanes.find((l) => l.network === "testnet");
    // The POSITIVE first: mainnet actually captured. An "isolation" test where
    // neither lane ran passes for the wrong reason.
    assert.ok(
      (mainnet?.captured ?? 0) > 0,
      "mainnet captured nothing, so isolation proves nothing",
    );
    assert.equal(
      testnet?.ok,
      false,
      "the failing lane must report its failure",
    );
  });

  test("both lanes are attempted in one tick", async () => {
    const { env } = envWith();
    const seen = new Set<string>();
    const result = (await runRawCaptureSync(env as never, {
      sleepFn: noSleep,
      ctx: CTX,
      now: () => 1,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.add(String(url).includes("test.finney") ? "testnet" : "mainnet");
        return rpcFetch(RAW_CAPTURE_GENESIS_FLOOR + 100)(
          url as never,
          init as never,
        );
      }) as never,
    })) as { lanes?: { network: string }[] };
    assert.deepEqual([...seen].sort(), ["mainnet", "testnet"]);
    assert.equal((result.lanes ?? []).length, RAW_CAPTURE_LANES.length);
  });
});

/**
 * The pool widens the rotation — and the wiring that makes it do so.
 *
 * The measured ceiling on this lane is a PER-HOST rate limit, so one host was
 * the whole budget and the lane fell 8,409 blocks (~28 h) behind on 2026-08-16.
 * The endpoint lookup is DEFAULTED rather than injected in production, because
 * an injectable nothing injects is a feature that never runs — these prove it
 * reaches captureTick, and that a pool which cannot answer degrades to exactly
 * the single-endpoint lane this was before.
 */
describe("the archive endpoints a lane reads from", () => {
  /** Answers RPC for any host, recording which hosts were asked. */
  function hostTrackingFetch(hosts: Set<string>) {
    return jsonRpcNode((method, params, url) => {
      hosts.add(new URL(url).origin);
      // Above BOTH lanes' genesis floors, or nextCaptureHeights yields nothing
      // and the tick fetches no blocks at all -- which looks exactly like a
      // rotation that never happened.
      if (method === "chain_getHeader")
        return { result: { number: "0x989680" } };
      if (method === "chain_getBlockHash") return hashList(params);
      if (method === "chain_getBlock") {
        return {
          result: {
            block: {
              header: { number: "0x1", parentHash: "0xp" },
              extrinsics: ["0xaa"],
            },
          },
        };
      }
      return { result: "0xevents" };
    });
  }

  test("a pool member is ACTUALLY read, not merely resolved", async () => {
    const hosts = new Set<string>();
    const { env } = envWith();
    await runRawCaptureSync(env as never, {
      sleepFn: noSleep,
      ctx: CTX,
      fetchImpl: hostTrackingFetch(hosts),
      endpointDeps: {
        readArtifact: async () => ({
          ok: true,
          data: {
            pools: [
              {
                id: "finney-rpc",
                endpoints: [
                  {
                    id: "second",
                    url: "https://second-archive.example",
                    kind: "subtensor-rpc",
                    auth_required: false,
                    public_safe: true,
                    pool_eligible: true,
                    archive_support: true,
                    status: "ok",
                  },
                ],
              },
            ],
          },
        }),
      },
    });
    assert.ok(
      hosts.has("https://second-archive.example"),
      `the pool member was never read; hosts asked: ${[...hosts].join(", ")}`,
    );
  });

  test("a pool that cannot answer leaves the configured host doing the work", async () => {
    // The degrade path, which is what runs whenever R2 is unreachable. It must
    // be the lane exactly as it was, never a tick that reads nothing.
    const hosts = new Set<string>();
    const { env } = envWith();
    const result = await runRawCaptureSync(env as never, {
      sleepFn: noSleep,
      ctx: CTX,
      fetchImpl: hostTrackingFetch(hosts),
      endpointDeps: {
        readArtifact: async () => {
          throw new Error("r2 down");
        },
      },
    });
    assert.equal(result.ok, true);
    // Both lanes run, so both configured hosts appear; what must NOT appear is
    // any host the (unreadable) pool would have contributed.
    assert.ok(hosts.has("https://archive.chain.opentensor.ai"));
    assert.equal(hosts.size, RAW_CAPTURE_LANES.length);
  });
});

/**
 * The budget must not scale with how many endpoints the lane reads.
 *
 * This is the correction of a wrong premise, pinned so it cannot come back.
 * Adding hosts LOOKS like it should buy proportional throughput; #9378 measured
 * that it does not, because the limit is per CLIENT -- "probing
 * test.chain.opentensor.ai straight afterwards stopped after 4 blocks, because
 * the first probe had already spent the budget."
 *
 * A multiplier here does not raise the ceiling, it spends one minute's
 * allowance in a quarter of the minute and buys a 429 partway through the tick.
 * The rotation stays for FAILOVER and archive coverage; the rate is unchanged.
 */
describe("the tick budget against the endpoint count", () => {
  test("more endpoints do NOT widen the budget", async () => {
    const hosts = new Set<string>();
    const { env } = envWith();
    const pool = (n: number) => ({
      readArtifact: async () => ({
        ok: true,
        data: {
          pools: [
            {
              id: "finney-rpc",
              endpoints: Array.from({ length: n }, (_, i) => ({
                id: `archive-${i}`,
                url: `https://archive-${i}.example`,
                kind: "subtensor-rpc",
                auth_required: false,
                public_safe: true,
                pool_eligible: true,
                archive_support: true,
                status: "ok",
              })),
            },
          ],
        },
      }),
    });
    const gaps: number[] = [];
    for (const n of [1, 6]) {
      hosts.clear();
      await runRawCaptureSync(env as never, {
        ctx: CTX,
        endpointDeps: pool(n),
        // PINNED, because the gap is now a CYCLE time: captureTick subtracts a
        // read's own duration from it, so against a real clock the recorded
        // sleeps come back 2999 and 3000 and this test would fail on the
        // millisecond a fake fetch happened to take rather than on the budget.
        now: () => 1_000,
        // The paced gap IS the budget's observable half, so recording it is
        // how this asserts the rate rather than the endpoint list.
        sleepFn: async (ms) => {
          gaps.push(ms);
        },
        fetchImpl: jsonRpcNode((method, params, url) => {
          hosts.add(new URL(url).origin);
          if (method === "chain_getHeader")
            return { result: { number: "0x989680" } };
          if (method === "chain_getBlockHash") return hashList(params);
          if (method === "chain_getBlock") {
            return {
              result: {
                block: {
                  header: { number: "0x1", parentHash: "0xp" },
                  extrinsics: ["0xaa"],
                },
              },
            };
          }
          return { result: "0xevents" };
        }),
      });
    }
    // Six endpoints were genuinely read -- the rotation is live, so this is not
    // passing because the pool arm never ran.
    assert.ok(hosts.size > 1, `rotation did not engage: ${[...hosts].length}`);
    const distinct = [...new Set(gaps)];
    assert.equal(
      distinct.length,
      1,
      `the per-block gap must not depend on the endpoint count; saw ${distinct.join(", ")}`,
    );
  });
});
