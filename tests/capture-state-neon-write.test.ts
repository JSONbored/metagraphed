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
import { NEVER_BUFFER_LANES } from "../src/neon-write-buffer.ts";

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

  test("raw-capture-state NEVER buffers, because its reader is its writer", async () => {
    // THE REGRESSION THIS PINS, measured on production 2026-08-16.
    //
    // `neonWatermarkRead` (src/raw-capture-sync.ts) SELECTs
    // `last_contiguous_block` straight from Postgres to decide where the next
    // tick resumes. While this lane was buffered, that read returned a
    // watermark its own earlier ticks had already moved past, so every tick
    // inside the ten-minute flush window resumed at the same height and
    // re-captured the same blocks -- and because the R2 key is derived from
    // the block range, the re-writes were byte-identical and nothing errored.
    //
    // Capture ran at `maxBlocks per FLUSH INTERVAL` instead of per tick: 10
    // blocks per 10 minutes against a chain producing 5 a minute, while every
    // tick recorded `ok, 10 captured`. Naming the lane in the flag has to stay
    // a no-op, not become a five-fold throughput cut nobody can see.
    const ns = bufferNamespace();
    const rec = recordingSql();
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
      { sql: rec.sql },
    );
    assert.deepEqual(ns.sent, [], "nothing may be enqueued");
    assert.equal(rec.calls.length, 1, "it must still write directly");
    assert.match(rec.calls[0]!.text, /INSERT INTO raw_capture_state/);
    assert.equal(rec.calls[0]!.values[0], "mainnet");
  });

  test("BOTH lanes this module writes are exempt, so adding a third is a decision", () => {
    // A guard on the guard. Every write in this file is now unbufferable, and
    // that is a property of what these two tables ARE -- one is the explorer's
    // live tip, the other is the capture lane's own resume point. A third
    // writer added here inherits neither exemption automatically, and this
    // fails until whoever adds it has decided which way it goes.
    for (const lane of [BLOCKS_HEAD_NEON_LANE, RAW_CAPTURE_STATE_NEON_LANE]) {
      assert.ok(
        NEVER_BUFFER_LANES.has(lane),
        `${lane} must be in NEVER_BUFFER_LANES`,
      );
    }
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
        async query() {
          return [];
        },
        async run(sql: string, values: unknown[] = []) {
          if (sql.startsWith("INSERT")) rows.push(values);
          return { changes: 1 };
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

  // THE ENQUEUE-TIME VERDICT CASES USED TO LIVE HERE and cannot any more:
  // neither lane this module writes is bufferable, so `buffered` is false on
  // every path through it and an enqueue is unreachable. The behaviour they
  // asserted -- a buffered success records nothing, a refused one records --
  // is not lost, it belongs to the seam rather than to this caller and is
  // covered in tests/neon-write.test.ts ("a buffered lane's enqueue-time
  // verdict") against the runner itself. What remains here is the part that IS
  // this module's: that a flag naming either lane changes nothing.

  test("an INJECTED sql is never treated as buffered", async () => {
    // deps.sql went wherever the caller pointed it -- a test double or a real
    // connection. Calling that buffered would suppress a verdict for a write
    // the buffer never saw.
    //
    // It doubles as this block's remaining coverage of the flagged case: the
    // env below NAMES raw-capture-state, and the write still lands and still
    // records, which is what the exemption is for.
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
