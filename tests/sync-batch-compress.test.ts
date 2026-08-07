// The compressed sync-batches wire format (metagraphed#9759).
//
// The property worth testing is not "gzip works". It is that the BUDGET now
// measures the compressed size, that an incompressible payload still fails
// LOUDLY rather than degrading into the split the multi-family shape exists to
// prevent, and that a body which cannot be decompressed comes back as null --
// because the consumer acks null and retries a throw, and getting that
// backwards loses rows for the largest lane on the platform.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  compressSyncBatchMessage,
  decompressSyncBatchMessage,
  isCompressedSyncBatchBody,
  SYNC_BATCH_COMPRESSION,
} from "../src/sync-batch-compress.ts";
import {
  packMultiFamilyMessage,
  SYNC_BATCH_MAX_BYTES,
  validSyncBatchMessage,
} from "../src/sync-batch-queue.ts";

/** A chain-detail-shaped payload: repetitive, because the real one is. The same
 * ss58 addresses, pallet names and event kinds appear hundreds of times, which
 * is why the measured ratio on a real block is 11.8x rather than 2x. */
function chainDetailFamilies(events: number) {
  const HOTKEY = "5FyVinYphF6JS5FZHzhMQffxtgbz1WxwUEBAxTRo9nABwb5g";
  const COLDKEY = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  return {
    blockRows: [
      { block_number: 8_790_494, block_hash: `0x${"ab".repeat(32)}` },
    ],
    extrinsicRows: Array.from({ length: 35 }, (_unused, i) => ({
      block_number: 8_790_494,
      extrinsic_index: i,
      signer: COLDKEY,
      call_module: "SubtensorModule",
      call_function: "set_weights",
    })),
    chainEventRows: Array.from({ length: events }, (_unused, i) => ({
      block_number: 8_790_494,
      event_index: i,
      pallet: "SubtensorModule",
      method: "StakeAdded",
      args: `["${HOTKEY}","${COLDKEY}",12345678901,7]`,
    })),
    accountEventRows: Array.from({ length: events }, (_unused, i) => ({
      block_number: 8_790_494,
      event_index: i,
      event_kind: "StakeAdded",
      hotkey: HOTKEY,
      coldkey: COLDKEY,
      netuid: 7,
    })),
  };
}

describe("compressSyncBatchMessage", () => {
  test("a chain-detail block fits compressed, and does not fit raw", async () => {
    // THE WHOLE REASON THIS EXISTS. Measured on the real rows of block
    // #8790494: 476.6 KiB of JSON against a 128 KiB per-message cap, 40.5 KiB
    // gzipped. This is the same shape at a size that reproduces the gap.
    const message = packMultiFamilyMessage({
      lane: "chain-detail",
      capturedAt: 1_780_000_000_000,
      families: chainDetailFamilies(694),
    });
    const raw = JSON.stringify(message).length;
    assert.equal(
      raw > SYNC_BATCH_MAX_BYTES,
      true,
      `raw ${raw} should exceed the budget`,
    );
    const packed = await compressSyncBatchMessage(
      message,
      SYNC_BATCH_MAX_BYTES,
    );
    assert.equal(packed.length < SYNC_BATCH_MAX_BYTES, true);
    // Not a token improvement: this payload class compresses by an order of
    // magnitude, which is what makes the change decisive rather than marginal.
    assert.equal(raw / packed.length > 5, true, `ratio ${raw / packed.length}`);
  });

  test("round-trips to exactly the message that went in", async () => {
    const message = packMultiFamilyMessage({
      lane: "chain-detail",
      capturedAt: 1_780_000_000_000,
      families: chainDetailFamilies(40),
    });
    const back = await decompressSyncBatchMessage(
      await compressSyncBatchMessage(message, SYNC_BATCH_MAX_BYTES),
    );
    assert.deepEqual(back, message);
    // And it is still a message the consumer will accept -- compression is a
    // wire encoding, not a schema change.
    assert.equal(validSyncBatchMessage(back), true);
  });

  test("an INCOMPRESSIBLE payload still fails, and says both sizes", async () => {
    // 11.8x is one block's ratio, not a guarantee. The failure has to stay
    // loud: the route answers 502, the producer retries a chunk that was never
    // accepted, and nothing is silently dropped. Random hex does not compress,
    // so this is the case that proves the budget is still enforced.
    const random = Array.from({ length: 200_000 }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join("");
    await assert.rejects(
      compressSyncBatchMessage(
        {
          lane: "chain-detail",
          captured_at: 1,
          families: { blockRows: [{ random }] },
        },
        SYNC_BATCH_MAX_BYTES,
      ),
      (err: Error) => {
        assert.match(err.message, /bytes compressed \(\d+ raw\)/);
        // The producer is told what to do, since it is the only side that can.
        assert.match(err.message, /PRODUCER must post a smaller batch/);
        // And never the one degradation this shape exists to prevent.
        assert.match(err.message, /splitting them here/);
        return true;
      },
    );
  });

  test("names the lane, or says so when there isn't one", async () => {
    // The error is read by whoever is looking at a 502 in the poller's log, so
    // naming the lane is most of its value -- and a message that somehow has no
    // lane must still produce a readable error rather than "undefined message".
    const random = Array.from({ length: 200_000 }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join("");
    await assert.rejects(
      compressSyncBatchMessage({ families: { blockRows: [{ random }] } }, 1024),
      /sync-batches: unknown message is \d+ bytes/,
    );
  });

  test("gzip, and self-describing", async () => {
    assert.equal(SYNC_BATCH_COMPRESSION, "gzip");
    const packed = await compressSyncBatchMessage({ lane: "x" }, 1024);
    assert.equal(packed[0], 0x1f);
    assert.equal(packed[1], 0x8b);
  });
});

describe("decompressSyncBatchMessage", () => {
  test("returns NULL rather than throwing on anything unreadable", async () => {
    // Null, not a throw, because of what the consumer does with each: it ACKS
    // an unparseable message (retrying something that can never parse burns the
    // whole budget and dead-letters anyway) and RETRIES a throw. That decision
    // is easier to keep right when "not a message" is a value.
    for (const bad of [
      new Uint8Array([1, 2, 3]), // not gzip
      new Uint8Array([0x1f, 0x8b, 0x00]), // gzip magic, truncated stream
      new Uint8Array(0), // empty
    ]) {
      assert.equal(await decompressSyncBatchMessage(bad), null);
    }
  });

  test("gzip of something that is not JSON is null, not a crash", async () => {
    const notJson = await compressSyncBatchMessage({ lane: "x" }, 1024);
    // Corrupt the payload after the header so it inflates to garbage.
    const corrupted = notJson.slice();
    corrupted[corrupted.length - 5] ^= 0xff;
    assert.equal(await decompressSyncBatchMessage(corrupted), null);
  });

  test("accepts an ArrayBuffer, which is what the runtime actually delivers", async () => {
    // Queues hands `contentType: "bytes"` back as an ArrayBuffer, not a
    // Uint8Array. Testing only the latter would leave the shape production
    // uses uncovered -- and a view/buffer mix-up here reads every message as
    // unparseable, which this consumer ACKS.
    const message = { lane: "chain-detail", captured_at: 1, families: {} };
    const packed = await compressSyncBatchMessage(
      message,
      SYNC_BATCH_MAX_BYTES,
    );
    assert.equal(isCompressedSyncBatchBody(packed.buffer), true);
    assert.deepEqual(await decompressSyncBatchMessage(packed.buffer), message);
  });

  test("a JSON body is not mistaken for a compressed one", async () => {
    // The four lanes already on the queue send objects, and they must keep
    // taking the existing path untouched.
    for (const body of [{ lane: "hotkey-alpha", rows: [] }, null, "text", 7]) {
      assert.equal(
        isCompressedSyncBatchBody(body),
        false,
        JSON.stringify(body),
      );
      assert.equal(await decompressSyncBatchMessage(body), null);
    }
  });
});
