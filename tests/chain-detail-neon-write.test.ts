// The chain-detail mirror (#9787).
//
// Four tables, one producer pass, and an ORDER that is load-bearing:
// chain_detail_blocks is the coverage register -- the thing that says "this
// block's detail is stored" -- so it goes last and is withheld entirely when
// any detail table failed. A register over missing detail reads downstream as
// "this block genuinely had no extrinsics", which is indistinguishable from the
// truth and is never revisited.
import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  CHAIN_DETAIL_MIRROR_PLANS,
  mirrorChainDetailToNeon,
} from "../src/chain-detail-neon-write.ts";

const env = {
  HYPERDRIVE: { connectionString: "postgresql://x" },
};
const ctx = { waitUntil: () => undefined } as never;

function recordingSql(fail?: RegExp) {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    texts: () => calls.map((c) => c.text),
    sql: {
      unsafe: async (text: string, values: unknown[] = []) => {
        calls.push({ text, values });
        if (fail?.test(text)) throw new Error("boom");
        return [];
      },
    },
  };
}

const input = {
  blockRows: [{ block_number: 10 }],
  extrinsicRows: [{ block_number: 10, extrinsic_index: 0, success: 1 }],
  chainEventRows: [{ block_number: 10, event_index: 0 }],
  accountEventRows: [{ block_number: 10, event_index: 0 }],
};

describe("write order", () => {
  test("the coverage register is written LAST", async () => {
    const { sql, texts } = recordingSql();
    await mirrorChainDetailToNeon(env, ctx, input, {
      sql,
      laneHealthDb: null,
    });
    const t = texts();
    const blocksAt = t.findIndex((x) => x.includes("INTO chain_detail_blocks"));
    assert.ok(blocksAt >= 0, "the register was never written");
    for (const table of [
      "chain_detail_extrinsics",
      "chain_detail_chain_events",
      "chain_detail_account_events",
    ]) {
      const at = t.findIndex((x) => x.includes(`INTO ${table}`));
      assert.ok(at >= 0, `${table} was not written`);
      assert.ok(at < blocksAt, `${table} was written after the register`);
    }
  });

  test("the register is WITHHELD when any detail table failed", async () => {
    const { sql, texts } = recordingSql(/chain_detail_chain_events/);
    const out = await mirrorChainDetailToNeon(env, ctx, input, {
      sql,
      laneHealthDb: null,
    });
    assert.equal(
      texts().some((t) => t.includes("INTO chain_detail_blocks")),
      false,
      "coverage was claimed over detail that did not land",
    );
    assert.equal(out.results.chain_detail_blocks?.ok, false);
    assert.match(
      out.results.chain_detail_blocks?.reason ?? "",
      /register withheld/,
    );
  });

  test("the declared plans are the four tables, register last", () => {
    assert.deepEqual(
      CHAIN_DETAIL_MIRROR_PLANS.map((p) => p.table),
      [
        "chain_detail_extrinsics",
        "chain_detail_chain_events",
        "chain_detail_account_events",
        "chain_detail_blocks",
      ],
    );
  });
});

describe("the nullable boolean", () => {
  test("success binds as a BOOLEAN, not 0/1", async () => {
    // D1 stored it 0/1 with a CHECK; Neon's column is BOOLEAN and a number is
    // a type error there, not a coercion.
    const { sql, calls } = recordingSql();
    await mirrorChainDetailToNeon(env, ctx, input, {
      sql,
      laneHealthDb: null,
    });
    const ext = calls.find((c) => c.text.includes("chain_detail_extrinsics"))!;
    assert.ok(
      ext.values.includes(true),
      "success 1 did not become boolean true",
    );
    assert.equal(
      ext.values.includes(1),
      false,
      "a 0/1 flag reached a BOOLEAN column",
    );
  });

  test("a NULL success stays null, never false", async () => {
    // An undecoded outcome is UNKNOWN -- a third state. Boolean(null) would
    // publish "it failed", a claim the chain never made.
    const { sql, calls } = recordingSql();
    await mirrorChainDetailToNeon(
      env,
      ctx,
      {
        ...input,
        extrinsicRows: [
          { block_number: 10, extrinsic_index: 0, success: null },
        ],
      },
      { sql, laneHealthDb: null },
    );
    const ext = calls.find((c) => c.text.includes("chain_detail_extrinsics"))!;
    assert.ok(ext.values.includes(null));
    assert.equal(ext.values.includes(false), false);
  });
});

describe("gating", () => {
  // "off unless the flag names the lane" lived here until #10051: with D1
  // deleted the write is unconditional, and the off-arm it pinned is gone.
  test("unbound is a verdict, not silence", async () => {
    const out = await mirrorChainDetailToNeon({}, ctx, input, {
      laneHealthDb: null,
    });
    assert.equal(out.attempted, true);
    // The miss is IN-BAND since #10051: empty results let a sync route ack a
    // write nothing held, so every table reports the unbound failure.
    assert.ok(Object.keys(out.results).length > 0, "the miss must be in-band");
    for (const r of Object.values(out.results)) {
      assert.deepEqual(r, {
        ok: false,
        rows: 0,
        statements: 0,
        reason: "hyperdrive unbound",
      });
    }
  });

  test("never throws when the store does", async () => {
    const { sql } = recordingSql(/./);
    const out = await mirrorChainDetailToNeon(env, ctx, input, {
      sql,
      laneHealthDb: null,
    });
    assert.equal(out.attempted, true);
    assert.ok(Object.values(out.results).some((r) => !r.ok));
  });
});
