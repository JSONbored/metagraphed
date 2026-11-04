import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { selectedNeuronCaptureStore } from "../src/neuron-capture-store.ts";
import {
  mirrorNeuronSnapshotToNeon,
  neuronSnapshotWrite,
  type NeuronMirrorInput,
} from "../src/neurons-neon-write.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
import { mockEnv } from "./row-type.ts";
import worker, { neonOwnsNeuronsSnapshot } from "../workers/data-api.ts";

const row = {
  netuid: 1,
  uid: 0,
  hotkey: "5Example",
  coldkey: "5Owner",
  captured_at: 1_790_090_000_000,
};
const input = () => neuronSnapshotWrite([row], row.captured_at + 100);

test("native capture selection distinguishes absence from malformed selection", () => {
  for (const value of [
    null,
    undefined,
    3,
    "x",
    {},
    { NEURON_CAPTURE_STORE: undefined },
  ])
    assert.equal(selectedNeuronCaptureStore(value), undefined);
  for (const value of [null, false, {}, { write: true }])
    assert.throws(
      () => selectedNeuronCaptureStore({ NEURON_CAPTURE_STORE: value }),
      /invalid/,
    );
  const selected = { write: async () => 1 };
  assert.equal(
    selectedNeuronCaptureStore({ NEURON_CAPTURE_STORE: selected }),
    selected,
  );
});

test("native selection owns the whole family and propagates failure without fallback", async () => {
  const signal = new AbortController().signal;
  const write = vi.fn(
    async (_input: NeuronMirrorInput, _signal?: AbortSignal) => 12,
  );
  const overrides = {
    NEURON_CAPTURE_STORE: { write },
    NEURONS_SYNC_SECRET: "fixture-secret",
  };
  const env = mockEnv(overrides);
  assert.equal(neonOwnsNeuronsSnapshot(dataApiEnv(overrides)), true);
  const capture = input();
  const result = await mirrorNeuronSnapshotToNeon(
    env,
    { waitUntil() {}, signal },
    capture,
  );
  assert.deepEqual(write.mock.calls, [[capture, signal]]);
  assert.equal(result.writePath, "postgres-native");
  assert.equal(result.results.neurons.ok, true);
  assert.equal(result.results.neurons.statements, 12);
  write.mockRejectedValueOnce(new Error("native storage unavailable"));
  const failed = await mirrorNeuronSnapshotToNeon(env, null, capture, {
    sql: {
      unsafe: async () => {
        throw new Error("legacy SQL must not run");
      },
    },
  });
  assert.equal(failed.results.neurons.ok, false);
  assert.equal(failed.results.neuron_daily.ok, false);
  assert.equal(failed.results.account_position_daily.ok, false);
});

test("normal forward and backfill HTTP callers reach the selected native transaction", async () => {
  const write = vi.fn(
    async (_input: NeuronMirrorInput, _signal?: AbortSignal) => 9,
  );
  const overrides = {
    NEURON_CAPTURE_STORE: { write },
    NEURONS_SYNC_SECRET: "fixture-secret",
    NEURON_DAILY_BACKFILL_SECRET: "fixture-secret",
  };
  const env = dataApiEnv(overrides);
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  for (const [path, header, forward] of [
    ["neurons-sync", "x-neurons-sync-token", true],
    ["backfill-neuron-daily", "x-neuron-daily-backfill-token", false],
  ] as const) {
    const response = await worker.fetch(
      new Request(`https://example.test/api/v1/internal/${path}`, {
        method: "POST",
        headers: {
          [header]: "fixture-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify([row]),
      }),
      env,
      ctx,
    );
    assert.equal(response.status, 200);
    const call = write.mock.calls.at(-1)![0];
    assert.equal(call.rows.length, forward ? 1 : 0);
    assert.equal(call.dailyRows.length, 1);
    assert.equal(call.positionRows.length, 1);
  }
  write.mockRejectedValueOnce(new Error("failed commit"));
  const failure = await worker.fetch(
    new Request("https://example.test/api/v1/internal/neurons-sync", {
      method: "POST",
      headers: { "x-neurons-sync-token": "fixture-secret" },
      body: JSON.stringify([row]),
    }),
    env,
    ctx,
  );
  assert.equal(failure.status, 502);
});

test("queued neuron delivery acknowledges native success and retries a failed commit", async () => {
  const write = vi.fn(
    async (_input: NeuronMirrorInput, _signal?: AbortSignal) => 9,
  );
  const overrides = {
    NEURON_CAPTURE_STORE: { write },
    NEURONS_SYNC_SECRET: "fixture-secret",
  };
  const calls: string[] = [];
  const message = {
    id: "native-capture",
    timestamp: new Date(row.captured_at),
    attempts: 1,
    body: {
      lane: "neurons",
      captured_at: row.captured_at,
      key_complete: true,
      pass_total: 1,
      rows: [row],
    },
    ack() {
      calls.push("ack");
    },
    retry() {
      calls.push("retry");
    },
  };
  const batch = {
    queue: "sync-batches",
    metadata: { metrics: { backlogCount: 1, backlogBytes: 100 } },
    messages: [message],
    ackAll() {},
    retryAll() {},
  };
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  await worker.queue!(batch, dataApiEnv(overrides), ctx);
  assert.deepEqual(calls, ["ack"]);
  assert.equal(write.mock.calls[0]![0].pass?.expectedRows, 1);
  calls.length = 0;
  write.mockRejectedValueOnce(new Error("uncertain native commit"));
  await worker.queue!(batch, dataApiEnv(overrides), ctx);
  assert.deepEqual(calls, ["retry"]);
});
