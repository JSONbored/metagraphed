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
  const env = { NEON_DUAL_WRITE_LANES: BLOCKS_HEAD_NEON_LANE, HYPERDRIVE: HD };

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

  test("off unless the flag names the lane", async () => {
    const { sql, calls } = recordingSql();
    const out = await mirrorBlocksHeadToNeon(
      { NEON_DUAL_WRITE_LANES: "neurons", HYPERDRIVE: HD },
      ctx,
      block,
      { sql, laneHealthDb: null },
    );
    assert.equal(out.attempted, false);
    assert.equal(calls.length, 0);
  });

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
    NEON_DUAL_WRITE_LANES: RAW_CAPTURE_STATE_NEON_LANE,
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
    const out = await mirrorRawCaptureStateToNeon(
      { NEON_DUAL_WRITE_LANES: RAW_CAPTURE_STATE_NEON_LANE },
      ctx,
      "mainnet",
      1,
      1,
      { laneHealthDb: null },
    );
    assert.equal(out.attempted, true);
    assert.equal(out.result, undefined);
  });
});
