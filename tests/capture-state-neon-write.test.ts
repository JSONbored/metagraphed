// blocks_head and raw_capture_state, mirrored (#9787).
//
// Both statements are reused verbatim from the D1 writers rather than rebuilt,
// which is the point worth testing: the COALESCE guards are what stop a re-poll
// that could not read a value from erasing one an earlier tick already stored.
import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  BLOCKS_HEAD_NEON_LANE,
  RAW_CAPTURE_STATE_NEON_LANE,
  mirrorBlocksHeadToNeon,
  mirrorRawCaptureStateToNeon,
} from "../src/capture-state-neon-write.ts";

const ctx = { waitUntil: () => undefined } as never;
const HD = { connectionString: "postgresql://x" };

function recordingSql(fail?: string) {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    sql: {
      unsafe: async (text: string, values: unknown[] = []) => {
        calls.push({ text, values });
        if (fail) throw new Error(fail);
        return [];
      },
    },
  };
}

const block = {
  block_number: 10,
  block_hash: "0xa",
  parent_hash: "0xb",
  extrinsic_count: 2,
  event_count: null,
  author: null,
  observed_at: 500,
};

describe("blocks_head", () => {
  const env = { HYPERDRIVE: HD };

  test("a re-poll that read no event_count or author cannot erase them", async () => {
    // The whole reason the statement is reused rather than rebuilt as a
    // generic upsert. Without COALESCE, a tick whose storage read failed
    // replaces a known value with NULL -- the same shape as #9634's last_ok.
    const { sql, calls } = recordingSql();
    await mirrorBlocksHeadToNeon(env, ctx, block, { sql, laneHealthDb: null });
    const { text } = calls[0]!;
    assert.ok(
      text.includes(
        "event_count=COALESCE(excluded.event_count, blocks_head.event_count)",
      ),
    );
    assert.ok(
      text.includes("author=COALESCE(excluded.author, blocks_head.author)"),
    );
    // Everything else IS overwritten -- that is what "latest head" means.
    assert.ok(text.includes("block_hash=excluded.block_hash"));
  });

  test("binds the seven columns in statement order", async () => {
    const { sql, calls } = recordingSql();
    await mirrorBlocksHeadToNeon(env, ctx, block, { sql, laneHealthDb: null });
    assert.deepEqual(calls[0]!.values, [10, "0xa", "0xb", 2, null, null, 500]);
  });

  // The off-arm test lived here until #10051: with D1 deleted the write is
  // unconditional, and the behaviour it pinned is gone.

  test("never throws when the store does", async () => {
    const { sql } = recordingSql("connection reset");
    const out = await mirrorBlocksHeadToNeon(env, ctx, block, {
      sql,
      laneHealthDb: null,
    });
    assert.equal(out.result?.ok, false);
    assert.match(out.result?.reason ?? "", /connection reset/);
  });
});

describe("raw_capture_state", () => {
  const env = {
    HYPERDRIVE: HD,
  };

  test("upserts the watermark on the network key", async () => {
    const { sql, calls } = recordingSql();
    await mirrorRawCaptureStateToNeon(env, ctx, "mainnet", 4321, 999, {
      sql,
      laneHealthDb: null,
    });
    const { text, values } = calls[0]!;
    assert.ok(text.includes("ON CONFLICT(network) DO UPDATE"));
    assert.ok(text.includes("last_contiguous_block = excluded"));
    assert.deepEqual(values, ["mainnet", 4321, 999]);
  });

  test("enabled but unbound is a verdict, not silence", async () => {
    const out = await mirrorRawCaptureStateToNeon({}, ctx, "mainnet", 1, 1, {
      laneHealthDb: null,
    });
    assert.equal(out.attempted, true);
    assert.equal(out.result, undefined);
  });
});

describe("the write-behind buffer seam (#10659)", () => {
  /** A DO namespace double that records what the lane enqueued. */
  function bufferNamespace(status = 200) {
    const sent: unknown[] = [];
    return {
      sent,
      NEON_WRITE_BUFFER: {
        idFromName: (name: string) => name,
        get: () => ({
          async fetch(request: Request) {
            sent.push(await request.json());
            return new Response("{}", { status });
          },
        }),
      },
    };
  }

  test("an UNFLAGGED lane still opens its own connection", async () => {
    // The flag defaults empty, so the deploy that introduces buffering must
    // change nothing until a lane is named.
    const ns = bufferNamespace();
    const rec = recordingSql();
    await mirrorBlocksHeadToNeon(
      {
        HYPERDRIVE: HD,
        ...ns,
      },
      ctx,
      block,
      { sql: rec.sql },
    );
    assert.equal(rec.calls.length, 1);
    assert.deepEqual(ns.sent, []);
  });

  test("blocks-head NEVER buffers, even when the flag names it", async () => {
    // It is the block explorer's live read path above the decode seam
    // (src/blocks-cold-tier.ts routes `block_number > seam` at it), so
    // deferring this write defers the visible chain tip by the whole flush
    // interval. NEVER_BUFFER_LANES makes naming it in the flag a no-op rather
    // than a regression a user finds first.
    const ns = bufferNamespace();
    const rec = recordingSql();
    await mirrorBlocksHeadToNeon(
      {
        NEON_WRITE_BUFFER_LANES: BLOCKS_HEAD_NEON_LANE,
        HYPERDRIVE: HD,
        ...ns,
      },
      ctx,
      block,
      { sql: rec.sql },
    );
    assert.deepEqual(ns.sent, [], "nothing may be enqueued");
    assert.equal(rec.calls.length, 1, "it must still write directly");
  });

  test("a FLAGGED lane enqueues instead of writing", async () => {
    const ns = bufferNamespace();
    await mirrorRawCaptureStateToNeon(
      {
        NEON_WRITE_BUFFER_LANES: RAW_CAPTURE_STATE_NEON_LANE,
        HYPERDRIVE: HD,
        ...ns,
      },
      ctx,
      "mainnet",
      4321,
      999,
      {},
    );
    assert.equal(ns.sent.length, 1);
    const sent = ns.sent[0] as {
      lane: string;
      text: string;
      values: unknown[];
    };
    assert.equal(sent.lane, RAW_CAPTURE_STATE_NEON_LANE);
    // The SAME statement the direct path would have run -- buffering must not
    // reshape the write, only defer it.
    assert.match(sent.text, /INSERT INTO raw_capture_state/);
    assert.equal(sent.values[0], "mainnet");
  });

  test("a refused enqueue costs the lane a stale verdict, not silence", async () => {
    // Backpressure has to be visible. The lane's own record() turns the throw
    // into the verdict; swallowing it would let the buffer fill while every
    // lane reported ok.
    const ns = bufferNamespace(503);
    const out = await mirrorRawCaptureStateToNeon(
      {
        NEON_WRITE_BUFFER_LANES: RAW_CAPTURE_STATE_NEON_LANE,
        HYPERDRIVE: HD,
        ...ns,
      },
      ctx,
      "mainnet",
      4321,
      999,
      {},
    );
    assert.equal(out.result?.ok, false);
    assert.match(String(out.result?.reason), /buffer refused/);
  });
});

describe("the buffer seam degrades safely", () => {
  test("a flagged lane with NO buffer binding still writes directly", async () => {
    // Flag on, binding absent -- a config half-applied. Falling through to the
    // direct connection keeps the rows landing; refusing here would drop
    // capture data over a missing binding, which is the wrong direction.
    const rec = recordingSql();
    await mirrorBlocksHeadToNeon(
      {
        NEON_WRITE_BUFFER_LANES: BLOCKS_HEAD_NEON_LANE,
        HYPERDRIVE: HD,
      },
      ctx,
      block,
      { sql: rec.sql },
    );
    assert.equal(rec.calls.length, 1);
    assert.match(rec.calls[0].text, /INSERT INTO blocks_head/);
  });
});

describe("the runner's unbound cases", () => {
  test("a bound Hyperdrive with no ctx is unbound, not a crash", async () => {
    // createPgSql needs somewhere to park its teardown. Without a ctx there is
    // no runner to build, and the lane must say so rather than throw.
    const out = await mirrorBlocksHeadToNeon(
      { HYPERDRIVE: HD },
      null,
      block,
      {},
    );
    assert.equal(out.attempted, true);
    assert.equal(out.result, undefined);
  });
});

describe("no store bound at all", () => {
  test("an enabled lane with no Hyperdrive is a MISCONFIGURATION, and says so", async () => {
    const out = await mirrorBlocksHeadToNeon({}, ctx, block, {});
    assert.equal(out.attempted, true);
    assert.equal(out.result, undefined);
  });
});

describe("a buffered lane writes no enqueue-time verdict (#10690)", () => {
  function laneSpy() {
    const rows: unknown[][] = [];
    return {
      rows,
      db: {
        prepare(sql: string) {
          return {
            bind(...values: unknown[]) {
              return {
                async run() {
                  if (sql.startsWith("INSERT")) rows.push(values);
                },
              };
            },
          };
        },
      },
    };
  }
  function bufferNs(status = 200) {
    return {
      NEON_WRITE_BUFFER: {
        idFromName: (n: string) => n,
        get: () => ({
          async fetch() {
            return new Response("{}", { status });
          },
        }),
      },
    };
  }
  const enabled = {
    NEON_WRITE_BUFFER_LANES: RAW_CAPTURE_STATE_NEON_LANE,
    HYPERDRIVE: HD,
  };

  test("a successful enqueue records nothing -- the flush owns the verdict", async () => {
    const spy = laneSpy();
    await mirrorRawCaptureStateToNeon(
      { ...enabled, ...bufferNs() },
      ctx,
      "mainnet",
      4321,
      999,
      { laneHealthDb: spy.db },
    );
    assert.deepEqual(spy.rows, []);
  });

  test("a REFUSED enqueue still records -- backpressure must stay visible", async () => {
    const spy = laneSpy();
    await mirrorRawCaptureStateToNeon(
      { ...enabled, ...bufferNs(503) },
      ctx,
      "mainnet",
      4321,
      999,
      { laneHealthDb: spy.db },
    );
    assert.equal(spy.rows.length, 1);
    assert.equal(spy.rows[0][0], `neon:${RAW_CAPTURE_STATE_NEON_LANE}`);
    assert.equal(spy.rows[0][1], "stale");
  });

  test("an INJECTED sql is never treated as buffered", async () => {
    // deps.sql went wherever the caller pointed it -- a test double or a real
    // connection. Calling that buffered would suppress a verdict for a write
    // the buffer never saw.
    const spy = laneSpy();
    const rec = recordingSql();
    await mirrorRawCaptureStateToNeon(
      { ...enabled, ...bufferNs() },
      ctx,
      "mainnet",
      4321,
      999,
      { laneHealthDb: spy.db, sql: rec.sql },
    );
    assert.equal(rec.calls.length, 1);
    assert.equal(spy.rows.length, 1, "an injected write still reports");
  });
});
