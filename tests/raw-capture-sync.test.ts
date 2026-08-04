// Wiring tests for src/raw-capture-sync.ts. The capture guarantee itself is
// proven in tests/raw-chain-capture.test.ts; what matters here is that the
// lane REFUSES to run when it could not honour that guarantee — an unbound
// store or watermark must be a loud no-op, never a quiet one, because a lane
// that silently does nothing looks exactly like a healthy one.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, test } from "vitest";
import {
  d1Watermark,
  RAW_CAPTURE_GENESIS_FLOOR,
  RAW_CAPTURE_LANES,
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
    fs.readFileSync(path.join(process.cwd(), "migrations/d1", name), "utf8"),
);

function applyMigrations(target: InstanceType<typeof DatabaseSync>) {
  for (const sql of MIGRATIONS) target.exec(sql);
}

let db: InstanceType<typeof DatabaseSync>;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  applyMigrations(db);
});

/** D1-shaped facade over a real SQLite database, so the watermark SQL is
 * executed rather than merely recorded. */
function d1() {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first: async () =>
              (db.prepare(sql).get(...(values as never[])) ?? null) as Record<
                string,
                unknown
              > | null,
            run: async () => db.prepare(sql).run(...(values as never[])),
            all: async () => db.prepare(sql).all(...(values as never[])),
          };
        },
      };
    },
  };
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
  return (async (url: unknown, init?: { body?: string }) => {
    const isTestnet = String(url).includes("test.finney");
    const chainHead = isTestnet ? testnetHead : head;
    const tag = isTestnet ? "t" : "m";
    const req = JSON.parse(init?.body ?? "{}") as {
      method: string;
      params: unknown[];
    };
    const reply = (result: unknown) =>
      ({ ok: true, json: async () => ({ result }) }) as unknown as Response;
    if (req.method === "chain_getHeader")
      return reply({ number: `0x${chainHead.toString(16)}` });
    // Hashes are tagged per chain so a test can prove the bytes under a
    // testnet key came from the testnet endpoint.
    if (req.method === "chain_getBlockHash")
      return reply(`0x${tag}h${req.params[0]}`);
    if (req.method === "chain_getBlock")
      return reply({
        block: { header: { parentHash: `0x${tag}p` }, extrinsics: ["0xaa"] },
      });
    return reply(`0x${tag}events`);
  }) as unknown as typeof fetch;
}

function envWith(over: Record<string, unknown> = {}) {
  const puts = new Map<string, string>();
  const env = {
    RAW_CAPTURE_ENABLED: "true",
    METAGRAPH_ARCHIVE: {
      put: async (k: string, v: string) => void puts.set(k, v),
    },
    METAGRAPH_HEALTH_DB: d1(),
    ...over,
  };
  return { env, puts };
}

describe("runRawCaptureSync — refusal paths", () => {
  test("disabled is a quiet no-op, not an error", async () => {
    const captures: unknown[] = [];
    const { env } = envWith({ RAW_CAPTURE_ENABLED: undefined });
    const result = await runRawCaptureSync(env as never, {
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
      recordException: (async (_e: unknown, ev: { route?: string }) => {
        captures.push(ev);
        return true;
      }) as never,
    });
    assert.equal(result.reason, "store_unavailable");
    assert.equal(captures.length, 1);
    assert.equal(captures[0]?.route, "raw-capture-sync");
  });

  test("an unbound watermark refuses LOUDLY — without it a resume point is unknowable", async () => {
    const captures: unknown[] = [];
    const { env } = envWith({ METAGRAPH_HEALTH_DB: undefined });
    const result = await runRawCaptureSync(env as never, {
      recordException: (async () => {
        captures.push(1);
        return true;
      }) as never,
    });
    assert.equal(result.reason, "watermark_unavailable");
    assert.equal(captures.length, 1);
  });

  test("an RPC failure is contained and captured, never thrown at the scheduler", async () => {
    const captures: { route?: string }[] = [];
    const { env } = envWith();
    const result = await runRawCaptureSync(env as never, {
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
      fetchImpl: rpcFetch(RAW_CAPTURE_GENESIS_FLOOR + 1),
      now: () => 1,
    });
    const second = await runRawCaptureSync(env as never, {
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
      fetchImpl: rpcFetch(RAW_CAPTURE_GENESIS_FLOOR),
      now: () => 1,
    });
    const again = await runRawCaptureSync(env as never, {
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
      fetchImpl: rpcFetch(RAW_CAPTURE_GENESIS_FLOOR + 10_000),
      now: () => 1,
    });
    assert.equal(result.captured, 150, "bounded per tick");
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
    const flaky = (async (url: unknown, init?: { body?: string }) => {
      const isTestnet = String(url).includes("test.finney");
      const req = JSON.parse(init?.body ?? "{}") as {
        method: string;
        params: unknown[];
      };
      const reply = (r: unknown) =>
        ({
          ok: true,
          json: async () => ({ result: r }),
        }) as unknown as Response;
      // Endpoint-aware for the same reason rpcFetch is: the testnet lane must
      // be a no-op here so `puts.size` still counts only the mainnet batch.
      if (req.method === "chain_getHeader")
        return reply({
          number: isTestnet
            ? `0x${(TESTNET_RAW_CAPTURE_GENESIS_FLOOR - 1).toString(16)}`
            : `0x${(RAW_CAPTURE_GENESIS_FLOOR + 5).toString(16)}`,
        });
      if (req.method === "chain_getBlockHash") {
        if (req.params[0] === failAt)
          return { ok: false, status: 503 } as Response;
        return reply(`0xh${req.params[0]}`);
      }
      if (req.method === "chain_getBlock")
        return reply({
          block: { header: { parentHash: "0xp" }, extrinsics: ["0xaa"] },
        });
      return reply("0xevents");
    }) as unknown as typeof fetch;
    try {
      const result = await runRawCaptureSync(env as never, {
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
      fetchImpl: (async () => {
        throw "string failure";
      }) as unknown as typeof fetch,
      recordException: (async () => true) as never,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "string failure");
  });
});

describe("d1Watermark", () => {
  test("returns null when no row exists yet", async () => {
    const wm = d1Watermark(d1() as never, () => 1);
    assert.equal(await wm.read(), null);
  });

  test("write then read round-trips, and a second write updates in place", async () => {
    const wm = d1Watermark(d1() as never, () => 7);
    await wm.write(42);
    assert.equal(await wm.read(), 42);
    await wm.write(99);
    assert.equal(await wm.read(), 99);
    const count = db
      .prepare(`SELECT count(*) AS n FROM raw_capture_state`)
      .get() as Record<string, number>;
    assert.equal(count.n, 1, "single-row table stays single-row");
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
    // 1000-subrequest ceiling: 3 RPC calls per block plus one head fetch each.
    const subrequests = RAW_CAPTURE_LANES.reduce(
      (total, lane) => total + lane.maxPerTick * 3 + 1,
      0,
    );
    assert.ok(
      subrequests < 1000,
      `a tick would issue ${subrequests} subrequests, over the Worker ceiling`,
    );
  });
});
