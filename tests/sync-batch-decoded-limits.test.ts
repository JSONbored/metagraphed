import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  compressSyncBatchMessage,
  decompressSyncBatchMessage,
  readSyncBatchJson,
  SyncBatchExpansionError,
} from "../src/sync-batch-compress.ts";
import {
  CHAIN_DETAIL_SYNC_MAX_BLOCKS,
  CHAIN_DETAIL_SYNC_MAX_BODY_BYTES,
  CHAIN_DETAIL_SYNC_MAX_ROWS,
  SYNC_BATCH_MAX_DECODED_BYTES,
} from "../src/sync-batch-limits.ts";
import { parseChainDetailSync } from "../src/chain-detail-sync-payload.ts";
import {
  packMultiFamilyMessage,
  SYNC_BATCH_MAX_BYTES,
  SYNC_BATCH_MAX_ROWS,
  validSyncBatchMessage,
} from "../src/sync-batch-queue.ts";

const encoder = new TextEncoder();
const HASH = `0x${"ab".repeat(32)}`;
const NOW = 1_780_000_000_000;

function block(overrides: Record<string, unknown> = {}) {
  return {
    block_number: 1,
    block_hash: HASH,
    spec_version: 479,
    observed_at: NOW,
    extrinsics: [],
    chain_events: [],
    account_events: [],
    ...overrides,
  };
}

async function roundTrip(body: unknown, wire = JSON.stringify(body)) {
  const sourceBytes = encoder.encode(wire).byteLength;
  assert.ok(sourceBytes <= CHAIN_DETAIL_SYNC_MAX_BODY_BYTES);
  const parsed = parseChainDetailSync(JSON.parse(wire), NOW);
  assert.ok(parsed.ok);
  const { blockRows, extrinsicRows, chainEventRows, accountEventRows } =
    parsed.rows;
  const message = packMultiFamilyMessage({
    lane: "chain-detail",
    capturedAt: NOW,
    families: { blockRows, extrinsicRows, chainEventRows, accountEventRows },
  });
  const decodedBytes = encoder.encode(JSON.stringify(message)).byteLength;
  assert.ok(decodedBytes <= SYNC_BATCH_MAX_DECODED_BYTES);
  const compressed = await compressSyncBatchMessage(
    message,
    SYNC_BATCH_MAX_BYTES,
  );
  assert.ok(compressed.byteLength <= SYNC_BATCH_MAX_BYTES);
  const restored = await decompressSyncBatchMessage(compressed);
  assert.deepEqual(restored, message);
  return { sourceBytes, decodedBytes, message };
}

describe("the derived sync-batch envelope", () => {
  test("shares the unchanged HTTP inputs without replacing the queue row rule", () => {
    assert.equal(CHAIN_DETAIL_SYNC_MAX_BODY_BYTES, 16_000_000);
    assert.equal(CHAIN_DETAIL_SYNC_MAX_ROWS, 80_000);
    assert.equal(CHAIN_DETAIL_SYNC_MAX_BLOCKS, 16);
    assert.equal(SYNC_BATCH_MAX_ROWS, 5_000);
    assert.equal(SYNC_BATCH_MAX_DECODED_BYTES, 79_393_024);
  });

  test("round-trips an exactly admitted HTTP body with a large payload string", async () => {
    const event = {
      block_number: 1,
      event_index: 0,
      pallet: "System",
      method: "Remarked",
      args: "",
      phase: "Initialization",
      extrinsic_index: null,
      observed_at: NOW,
    };
    const body = { blocks: [block({ chain_events: [event] })] };
    event.args = "x".repeat(
      CHAIN_DETAIL_SYNC_MAX_BODY_BYTES -
        encoder.encode(JSON.stringify(body)).byteLength,
    );
    const result = await roundTrip(body);
    assert.equal(result.sourceBytes, CHAIN_DETAIL_SYNC_MAX_BODY_BYTES);
    assert.equal(validSyncBatchMessage(result.message), true);
  });

  test("retains every block at the admitted block-count ceiling", async () => {
    const result = await roundTrip({
      blocks: Array.from(
        { length: CHAIN_DETAIL_SYNC_MAX_BLOCKS },
        (_value, index) => block({ block_number: index }),
      ),
    });
    assert.equal(result.message.families!.blockRows!.length, 16);
  });

  test("covers decimal duplication, named attribution, escapes and numeric normalization", async () => {
    const amount = "9".repeat(10_000);
    const body = {
      blocks: [
        block({
          block_number: 1e20,
          extrinsics: [
            {
              block_number: 1e20,
              extrinsic_index: 1e20,
              extrinsic_hash: null,
              signer: null,
              call_module: null,
              call_function: null,
              success: null,
              fee_tao: null,
              tip_tao: null,
              call_args: JSON.stringify({
                netuid: 1e20,
                children: [{ name: "netuid", value: "19" }],
                text: "界\u0000\ud800",
              }),
              observed_at: NOW,
            },
          ],
          account_events: [
            {
              block_number: 1e20,
              event_index: 0,
              extrinsic_index: null,
              event_kind: "Transfer",
              hotkey: null,
              coldkey: null,
              netuid: 19,
              uid: null,
              amount_tao: amount,
              alpha_amount: null,
              observed_at: NOW,
            },
          ],
        }),
      ],
    };
    const result = await roundTrip(
      body,
      JSON.stringify(body).replaceAll("100000000000000000000", "1e20"),
    );
    const row = result.message.families!.blockRows![0]!;
    assert.equal(row.native_transfer_tao, amount);
    assert.equal(row.economic_activity_tao, amount);
    assert.equal(row.subnet_ids, "[19,100000000000000000000]");
    assert.ok(result.decodedBytes > result.sourceBytes * 2);
  });

  test("keeps 80,000-row parser admission and the separate 5,000-row consumer refusal", async () => {
    const event = {
      block_number: 1,
      event_index: 0,
      pallet: "System",
      method: "Remarked",
      args: null,
      phase: "Initialization",
      extrinsic_index: null,
      observed_at: 1,
    };
    const result = await roundTrip({
      blocks: [
        block({
          chain_events: Array.from(
            { length: CHAIN_DETAIL_SYNC_MAX_ROWS },
            () => event,
          ),
        }),
      ],
    });
    assert.equal(
      result.message.families!.chainEventRows!.length,
      1,
      "normal deduplication remains",
    );
    const oversized = packMultiFamilyMessage({
      lane: "chain-detail",
      capturedAt: NOW,
      families: {
        chainEventRows: Array.from(
          { length: SYNC_BATCH_MAX_ROWS + 1 },
          () => event,
        ),
      },
    });
    assert.equal(oversized.families!.chainEventRows!.length, 5_001);
    assert.equal(validSyncBatchMessage(oversized), false);
  });
});

describe("bounded expanded stream reads", () => {
  test("accepts exactly the decoded byte ceiling", async () => {
    let remaining = SYNC_BATCH_MAX_DECODED_BYTES - 2;
    let opened = false;
    const value = await readSyncBatchJson(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!opened) {
            opened = true;
            controller.enqueue(encoder.encode('"'));
            return;
          }
          if (remaining > 0) {
            const size = Math.min(65_536, remaining);
            controller.enqueue(new Uint8Array(size).fill(32));
            remaining -= size;
            return;
          }
          controller.enqueue(encoder.encode('"'));
          controller.close();
        },
      }),
    );
    assert.equal(typeof value, "string");
    assert.equal((value as string).length, SYNC_BATCH_MAX_DECODED_BYTES - 2);
  });

  test("rejects before decoding an excessive chunk, without awaiting cancellation", async () => {
    const tooLarge = new Uint8Array(SYNC_BATCH_MAX_DECODED_BYTES + 1);
    for (const cancellation of ["reject", "pending"] as const) {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(tooLarge);
        },
        cancel() {
          cancelled = true;
          return cancellation === "reject"
            ? Promise.reject(new Error("cancel refused"))
            : new Promise<void>(() => undefined);
        },
      });
      await assert.rejects(readSyncBatchJson(stream), SyncBatchExpansionError);
      assert.equal(cancelled, true);
      assert.equal(stream.locked, false);
    }
  });

  test("preserves split UTF-8 and releases a failed stream", async () => {
    const bytes = encoder.encode('{"value":"界"}');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    assert.deepEqual(await readSyncBatchJson(stream), { value: "界" });
    assert.equal(stream.locked, false);
    const failure = new Error("source failed");
    const failed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      },
    });
    await assert.rejects(
      readSyncBatchJson(failed),
      (error) => error === failure,
    );
    assert.equal(failed.locked, false);
  });

  test("the producer enforces both character and actual UTF-8 expansion limits", async () => {
    await assert.rejects(
      compressSyncBatchMessage(
        { text: "x".repeat(SYNC_BATCH_MAX_DECODED_BYTES) },
        SYNC_BATCH_MAX_BYTES,
      ),
      SyncBatchExpansionError,
    );
    await assert.rejects(
      compressSyncBatchMessage(
        { text: "界".repeat(Math.floor(SYNC_BATCH_MAX_DECODED_BYTES / 3) + 1) },
        SYNC_BATCH_MAX_BYTES,
      ),
      SyncBatchExpansionError,
    );
  });
});
