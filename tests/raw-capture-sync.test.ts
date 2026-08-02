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
  runRawCaptureSync,
} from "../src/raw-capture-sync.ts";

const SCHEMA = fs.readFileSync(
  path.join(process.cwd(), "migrations/d1/0006_raw_capture.sql"),
  "utf8",
);

let db: InstanceType<typeof DatabaseSync>;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
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

function rpcFetch(head: number) {
  return (async (_u: unknown, init?: { body?: string }) => {
    const req = JSON.parse(init?.body ?? "{}") as {
      method: string;
      params: unknown[];
    };
    const reply = (result: unknown) =>
      ({ ok: true, json: async () => ({ result }) }) as unknown as Response;
    if (req.method === "chain_getHeader")
      return reply({ number: `0x${head.toString(16)}` });
    if (req.method === "chain_getBlockHash")
      return reply(`0xh${req.params[0]}`);
    if (req.method === "chain_getBlock")
      return reply({
        block: { header: { parentHash: "0xp" }, extrinsics: ["0xaa"] },
      });
    return reply("0xevents");
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
    const captures: unknown[] = [];
    const { env } = envWith();
    const result = await runRawCaptureSync(env as never, {
      fetchImpl: (async () => {
        throw new Error("rpc down");
      }) as unknown as typeof fetch,
      recordException: (async () => {
        captures.push(1);
        return true;
      }) as never,
    });
    assert.equal(result.ok, false);
    assert.match(String(result.reason), /rpc down/);
    assert.equal(captures.length, 1);
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
    const flaky = (async (_u: unknown, init?: { body?: string }) => {
      const req = JSON.parse(init?.body ?? "{}") as {
        method: string;
        params: unknown[];
      };
      const reply = (r: unknown) =>
        ({
          ok: true,
          json: async () => ({ result: r }),
        }) as unknown as Response;
      if (req.method === "chain_getHeader")
        return reply({
          number: `0x${(RAW_CAPTURE_GENESIS_FLOOR + 5).toString(16)}`,
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
