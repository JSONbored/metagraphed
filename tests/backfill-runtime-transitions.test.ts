import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  assertValidOptions,
  decodeBlockTimestampMs,
  decodeCompactU64,
  findSpecTransitions,
  parseArgs,
  reconcileAction,
  type BoundaryRow,
} from "../scripts/backfill-runtime-transitions.ts";

// SCALE compact encoder — test-local inverse of decodeCompactU64, so the
// timestamp fixtures below are built rather than hand-transcribed.
function encodeCompact(value: bigint): number[] {
  if (value < 64n) return [Number(value) << 2];
  if (value < 2n ** 14n) {
    const v = (Number(value) << 2) | 0b01;
    return [v & 0xff, v >> 8];
  }
  if (value < 2n ** 30n) {
    const v = (Number(value) << 2) | 0b10;
    return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
  }
  const payload: number[] = [];
  let rest = value;
  while (rest > 0n) {
    payload.push(Number(rest & 0xffn));
    rest >>= 8n;
  }
  return [((payload.length - 4) << 2) | 0b11, ...payload];
}

// An unsigned v4 `timestamp.set` inherent: compact length ++ 0x04 ++ pallet
// index ++ call index ++ compact u64 moment.
function timestampExtrinsicHex(ms: bigint, palletIndex = 2): string {
  const body = [0x04, palletIndex, 0x00, ...encodeCompact(ms)];
  const bytes = [...encodeCompact(BigInt(body.length)), ...body];
  return `0x${bytes.map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

describe("decodeCompactU64", () => {
  test("round-trips all four modes", () => {
    for (const value of [
      0n,
      63n,
      64n,
      16_383n,
      16_384n,
      1_073_741_823n,
      1_073_741_824n,
      1_750_000_000_000n,
    ]) {
      const bytes = new Uint8Array(encodeCompact(value));
      const out = decodeCompactU64(bytes, 0);
      assert.ok(out, `decode failed for ${value}`);
      assert.equal(out![0], value);
      assert.equal(out![1], bytes.length);
    }
  });

  test("rejects truncated input and out-of-range offsets", () => {
    assert.equal(decodeCompactU64(new Uint8Array([]), 0), null);
    assert.equal(decodeCompactU64(new Uint8Array([0x01]), 0), null); // two-byte mode, one byte
    assert.equal(decodeCompactU64(new Uint8Array([0x02, 0x00]), 0), null); // four-byte mode, two bytes
    assert.equal(decodeCompactU64(new Uint8Array([0x00]), 5), null);
  });

  test("rejects big-int mode payloads longer than a u64", () => {
    // (9-byte payload) << 2 | 0b11
    const first = ((9 - 4) << 2) | 0b11;
    assert.equal(
      decodeCompactU64(new Uint8Array([first, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 0),
      null,
    );
  });
});

describe("decodeBlockTimestampMs", () => {
  const ms = 1_750_000_000_000n; // 2025-06-15T15:06:40Z — inside the sane window

  test("decodes a realistic timestamp.set inherent", () => {
    assert.equal(decodeBlockTimestampMs(timestampExtrinsicHex(ms)), Number(ms));
  });

  test("is pallet-index agnostic — the range check is the validator", () => {
    for (const palletIndex of [0, 2, 3, 7]) {
      assert.equal(
        decodeBlockTimestampMs(timestampExtrinsicHex(ms, palletIndex)),
        Number(ms),
      );
    }
  });

  test("rejects a signed first extrinsic (not the inherent)", () => {
    // 0x84 = v4 with the signed bit — a signed extrinsic can't be timestamp.set.
    const unsigned = timestampExtrinsicHex(ms);
    const signed = unsigned.replace(/^(0x[0-9a-f]{2})04/, "$184");
    assert.notEqual(signed, unsigned);
    assert.equal(decodeBlockTimestampMs(signed), null);
  });

  test("rejects a decoded moment outside the sane window instead of returning garbage", () => {
    // A wrong-pallet decode lands on arbitrary bytes; the guard is the range.
    assert.equal(decodeBlockTimestampMs(timestampExtrinsicHex(5n)), null);
    assert.equal(
      decodeBlockTimestampMs(timestampExtrinsicHex(9_999_999_999_999_999n)),
      null,
    );
  });

  test("rejects malformed input", () => {
    for (const bad of [null, undefined, "", "0x", "0xzz", "0x0403", "nothex"]) {
      assert.equal(decodeBlockTimestampMs(bad), null, JSON.stringify(bad));
    }
  });

  test("decodes REAL inherents from both extrinsic formats (fixtures captured live 2026-07-30)", () => {
    // finney block 1,000,000 — extrinsic format v4 (0x04): 2023-08-07
    const v4 = decodeBlockTimestampMs("0x280402000b810da3cb8901");
    assert.ok(v4 != null);
    assert.equal(new Date(v4!).toISOString().slice(0, 7), "2023-08");
    // finney block 8,400,000 — bare extrinsic format v5 (0x05): 2026-06
    const v5 = decodeBlockTimestampMs("0x280502000b206374c29e01");
    assert.ok(v5 != null);
    assert.equal(new Date(v5!).toISOString().slice(0, 7), "2026-06");
  });
});

describe("findSpecTransitions", () => {
  // A step function over block height, mirroring how spec versions actually
  // behave (monotone, changing at exact boundaries).
  function specStep(boundaries: [number, number][]): (b: number) => number {
    return (block: number) => {
      let spec = boundaries[0][1];
      for (const [at, v] of boundaries) {
        if (block >= at) spec = v;
      }
      return spec;
    };
  }

  test("finds exact boundaries over a large range", async () => {
    const truth: [number, number][] = [
      [0, 101],
      [8_486_593, 423],
      [8_599_188, 424],
      [8_713_793, 440],
    ];
    const fn = specStep(truth);
    let calls = 0;
    const out = await findSpecTransitions(0, 8_750_000, async (b) => {
      calls += 1;
      return fn(b);
    });
    assert.deepEqual(
      out.map((t) => [t.block_number, t.spec_version]),
      truth,
    );
    // Divide-and-conquer, not a scan: 3 boundaries over 8.75M blocks must
    // cost O(boundaries · log(range)), nowhere near the block count.
    assert.ok(calls < 250, `used ${calls} lookups`);
  });

  test("a constant range yields only the low endpoint", async () => {
    const out = await findSpecTransitions(100, 10_000, async () => 217);
    assert.deepEqual(out, [{ block_number: 100, spec_version: 217 }]);
  });

  test("adjacent-block transition is pinned without splitting", async () => {
    const out = await findSpecTransitions(10, 11, async (b) =>
      b < 11 ? 1 : 2,
    );
    assert.deepEqual(
      out.map((t) => t.block_number),
      [10, 11],
    );
  });
});

describe("reconcileAction", () => {
  const truth: BoundaryRow = {
    block_number: 8_486_593,
    spec_version: 423,
    block_hash: "0xabc",
    parent_hash: "0xdef",
    extrinsic_count: 17,
    event_count: 120,
    observed_at_ms: 1_750_000_000_000,
  };

  test("no row at the height -> insert (the common case: coverage is islands)", () => {
    assert.equal(reconcileAction(truth, undefined), "insert");
  });

  test("agreement on hash, spec, and counts -> in_sync", () => {
    assert.equal(
      reconcileAction(truth, {
        block_hash: "0xabc",
        spec_version: 423,
        extrinsic_count: 17,
        event_count: 120,
      }),
      "in_sync",
    );
  });

  test("an existing row is never trusted: any disagreement -> overwrite", () => {
    for (const bad of [
      {
        block_hash: "0xother",
        spec_version: 423,
        extrinsic_count: 17,
        event_count: 120,
      },
      {
        block_hash: "0xabc",
        spec_version: 217,
        extrinsic_count: 17,
        event_count: 120,
      },
      {
        block_hash: "0xabc",
        spec_version: 423,
        extrinsic_count: 3,
        event_count: 120,
      },
      {
        block_hash: null,
        spec_version: null,
        extrinsic_count: null,
        event_count: null,
      },
    ]) {
      assert.equal(
        reconcileAction(truth, bad),
        "overwrite",
        JSON.stringify(bad),
      );
    }
  });

  test("stored null event_count is upgraded when chain truth has a value, tolerated when truth is also unknown", () => {
    const stored = {
      block_hash: "0xabc",
      spec_version: 423,
      extrinsic_count: 17,
      event_count: null,
    };
    assert.equal(reconcileAction(truth, stored), "overwrite");
    assert.equal(
      reconcileAction({ ...truth, event_count: null }, stored),
      "in_sync",
    );
  });
});

describe("parseArgs / assertValidOptions", () => {
  test("defaults are a dry run against the public archive", () => {
    const opts = parseArgs([]);
    assert.equal(opts.write, false);
    assert.equal(opts.from, 0);
    assert.equal(opts.to, null);
    assert.match(opts.archiveUrl, /^https:\/\//);
  });

  test("rejects an unknown flag", () => {
    assert.throws(() => parseArgs(["--bogus"]), /unrecognized argument/);
  });

  test("--write without a database target is refused", () => {
    const opts = parseArgs(["--write"]);
    opts.databaseUrl = "";
    assert.throws(() => assertValidOptions(opts), /refusing to guess/);
  });

  test("range validation", () => {
    assert.throws(
      () => assertValidOptions(parseArgs(["--from", "100", "--to", "50"])),
      /must be greater/,
    );
    assert.throws(
      () => assertValidOptions(parseArgs(["--from", "-1"])),
      /non-negative/,
    );
  });
});
