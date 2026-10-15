import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createNeuronWriteReporter } from "../src/neuron-write-diagnostics.ts";
import type { NeuronMirrorOutcome } from "../src/neurons-neon-write.ts";

afterEach(() => vi.restoreAllMocks());
const input = { neurons: 396, neuron_daily: 396, account_position_daily: 396 };

test("the failure sample keeps fixed paths/classes and input counts, never commit claims or payloads", () => {
  let clock = 0;
  const events: unknown[] = [];
  const report = createNeuronWriteReporter(
    () => clock,
    (event) => events.push(event),
  );
  const outcome: NeuronMirrorOutcome = {
    attempted: true,
    writePath: "d1",
    results: {
      neurons: {
        ok: false,
        rows: 396,
        statements: 0,
        reason: "insert_capacity",
      },
      neuron_daily: {
        ok: false,
        rows: 396,
        statements: 0,
        reason: "D1_ERROR: Exceeded maximum DB size. password=hidden",
      },
      account_position_daily: { ok: false, rows: 396, statements: 0 },
      neurons_passes: { ok: true, rows: 0, statements: 0 },
      "arbitrary-private-table": {
        ok: false,
        rows: 9,
        statements: 0,
        reason: "token=hidden",
      },
    },
  };
  report(outcome, { ...input, secret: "hidden" } as typeof input);
  for (let index = 0; index < 1000; index++) report(outcome, input);
  assert.deepEqual(events, [
    {
      write_path: "d1",
      attempted: true,
      input_rows: input,
      confirmed_rows: null,
      failures: {
        neurons: "insert_capacity",
        neuron_daily: "insert_capacity",
        account_position_daily: "insert_error",
        neurons_passes: null,
      },
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(events),
    /hidden|password|arbitrary|secret/,
  );
  clock = 60_000;
  report({ attempted: false, writePath: "unbound", results: {} }, input);
  assert.equal(events.length, 2);
  assert.equal((events[1] as { attempted: boolean }).attempted, false);
  clock = 120_000;
  report({ attempted: true, writePath: "postgres-direct", results: {} }, input);
  assert.equal(
    events.length,
    2,
    "successful outcomes do not consume the sampling bucket",
  );
  report({ ...outcome, writePath: "postgres-buffered" }, input);
  assert.equal(events.length, 3);
  assert.ok(JSON.stringify(events).length < 2048);
});

test("the fixed default sink and a failed logger cannot change the write outcome", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(Date, "now").mockReturnValue(1);
  const failure: NeuronMirrorOutcome = {
    attempted: false,
    writePath: "unbound",
    results: {},
  };
  createNeuronWriteReporter()(failure, input);
  assert.equal(warn.mock.calls.length, 1);
  assert.equal(warn.mock.calls[0][0], "neuron_snapshot_write_failure");
  assert.doesNotThrow(() =>
    createNeuronWriteReporter(
      () => 1,
      () => {
        throw new Error("logger unavailable");
      },
    )(failure, input),
  );
});
