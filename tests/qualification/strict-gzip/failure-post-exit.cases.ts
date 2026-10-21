// Pure host-ordering regressions. The native test is read, never imported.
// Execute only its inert post-exit JavaScript with synthetic adapters: no pg,
// Miniflare, sockets, services, subprocesses, or native runtime are started.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { withinOwnerDeadline } from "./owner-deadline.ts";

const source = readFileSync(
  new URL("./queue-owner-failure.test.ts", import.meta.url),
  "utf8",
);
const startText =
  '      const custody = withFailureNativeReason("qnf-operation-036", () =>';
const endText = "      result = {";
const start = source.indexOf(startText);
assert.ok(start >= 0, "The real native-exit boundary must exist");
assert.equal(source.indexOf(startText, start + 1), -1);
const end = source.indexOf(endText, start);
assert.ok(end > start, "The runtime receipt must follow the exit boundary");
const block = source.slice(start, end);
assert.equal(block.match(/privateRuntime\.postExitDrain\s*=/g)?.length, 1);

// Do not transcribe, replace, or otherwise rewrite the source under test.
const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as new (
  ...argumentsAndBody: string[]
) => (...args: unknown[]) => Promise<void>;
const execute = new AsyncFunction(
  "withFailureNativeReason",
  "readOwnerNativeEvidence",
  "path",
  "resultFile",
  "observed",
  "phase",
  "withFailureNativeReasonAsync",
  "withinOwnerDeadline",
  "fixture",
  "privateRuntime",
  "publishSyntheticReceipt",
  block + "\nawait publishSyntheticReceipt(custody);\n",
);

type Phase = "uninstrumented" | "instrumented" | "unfixed-instrumented";
type Drain = { remainingWriterSessions: 0; stableZeroSamples: 2 };
const zeroDrain: Drain = Object.freeze({
  remainingWriterSessions: 0,
  stableZeroSamples: 2,
});
const expectedMarker = {
  boundary: "after-observed-native-exit",
  remainingWriterSessions: 0,
  stableZeroSamples: 2,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function harness(
  options: {
    phase?: Phase;
    exitError?: Error;
    drain?: () => Promise<Drain>;
    healthy?: () => Promise<void>;
    deadlineMilliseconds?: number;
  } = {},
) {
  const events: string[] = [];
  const reasons: string[] = [];
  const runtime: Record<string, unknown> = {};
  const observed = Object.freeze({ syntheticObservedRuntime: true });
  const custody = Object.freeze({
    guardedNativeLaunches: 1,
    observedNativeExits: 1,
  });
  const healthStarted = deferred<void>();
  let innerSettled: Promise<void> | undefined;
  let publications = 0;
  let markerWrites = 0;
  const run = () =>
    execute(
      (reason: string, operation: () => unknown) => {
        assert.equal(reason, "qnf-operation-036");
        reasons.push(reason);
        return operation();
      },
      (directory: string, actualObserved: unknown) => {
        assert.equal(directory, "/synthetic-receipts");
        assert.equal(actualObserved, observed);
        events.push("observed-exit");
        if (options.exitError) throw options.exitError;
        return custody;
      },
      path,
      "/synthetic-receipts/result.json",
      observed,
      options.phase ?? "unfixed-instrumented",
      (reason: string, operation: () => Promise<unknown>) => {
        assert.ok(
          [
            "qnf-operation-085",
            "qnf-operation-086",
            "qnf-operation-087",
          ].includes(reason),
        );
        reasons.push(reason);
        return operation();
      },
      (promise: Promise<Drain>, milliseconds: number) => {
        assert.equal(
          milliseconds,
          10_000,
          "Keep the real host deadline unchanged",
        );
        events.push("deadline-start");
        // Observe eventual completion without detaching a rejected Promise. This
        // does not cancel the raced work, just as the real deadline does not.
        innerSettled = promise.then(
          () => undefined,
          () => undefined,
        );
        return withinOwnerDeadline(
          promise,
          options.deadlineMilliseconds ?? 1_000,
        ).then((value) => {
          events.push("deadline-success");
          return value;
        });
      },
      {
        async drain() {
          events.push("drain-start");
          assert.ok(events.includes("observed-exit"));
          const value = await (options.drain?.() ?? Promise.resolve(zeroDrain));
          events.push("drain-success");
          return value;
        },
        async healthy() {
          events.push("health-start");
          assert.ok(events.includes("drain-success"));
          healthStarted.resolve();
          await (options.healthy?.() ?? Promise.resolve());
          events.push("health-success");
        },
      },
      new Proxy(runtime, {
        set(target, key, value) {
          assert.equal(key, "postExitDrain");
          events.push("marker");
          markerWrites++;
          return Reflect.set(target, key, value);
        },
      }),
      (actualCustody: unknown) => {
        assert.equal(actualCustody, custody);
        events.push("synthetic-publication");
        publications++;
      },
    );
  return {
    run,
    events,
    reasons,
    runtime,
    healthStarted: healthStarted.promise,
    innerSettled: () => {
      assert.ok(
        innerSettled,
        "The real outer deadline must have observed its work",
      );
      return innerSettled;
    },
    noCompletedEvidence() {
      assert.equal(Object.hasOwn(runtime, "postExitDrain"), false);
      assert.equal(markerWrites, 0);
      assert.equal(publications, 0);
      assert.equal(events.includes("marker"), false);
      assert.equal(events.includes("synthetic-publication"), false);
    },
    counts: () => ({ markerWrites, publications }),
  };
}

test("the existing awaited bounded native disposal precedes actual exit validation", () => {
  const disposeStart = source.indexOf(
    '      await withFailureNativeReasonAsync("qnf-operation-033", () =>',
  );
  const disposeEnd = source.indexOf(
    '      const observed = withFailureNativeReason("qnf-operation-035", () =>',
    disposeStart,
  );
  assert.ok(
    disposeStart >= 0 && disposeEnd > disposeStart && disposeEnd < start,
  );
  const disposal = source
    .slice(disposeStart, disposeEnd)
    .replace(/\/\*[^]*?\*\//g, "")
    .replace(/\s/g, "");
  assert.equal(
    disposal,
    'awaitwithFailureNativeReasonAsync("qnf-operation-033",()=>withinOwnerDeadline(' +
      'withFailureNativeReasonAsync("qnf-operation-034",()=>native!.dispose(),),10_000,),);' +
      "disposed=true;",
  );
  assert.equal(
    source.slice(0, start).includes("privateRuntime.postExitDrain"),
    false,
  );
  assert.ok(
    block.indexOf("readOwnerNativeEvidence(") <
      block.indexOf("fixture.drain()"),
  );
});

test("actual unfixed block waits for exit, fresh drain, health and outer deadline before its exact marker and receipt", async () => {
  const drain = deferred<Drain>();
  const health = deferred<void>();
  // Extra adapter data must not leak into the closed private evidence shape.
  const drained = Object.freeze({ ...zeroDrain, syntheticAdapterOnly: true });
  const h = harness({
    drain: () => drain.promise,
    healthy: () => health.promise,
  });
  const pending = h.run();
  assert.deepEqual(h.events, [
    "observed-exit",
    "drain-start",
    "deadline-start",
  ]);
  h.noCompletedEvidence();
  drain.resolve(drained);
  await h.healthStarted;
  assert.deepEqual(h.events, [
    "observed-exit",
    "drain-start",
    "deadline-start",
    "drain-success",
    "health-start",
  ]);
  h.noCompletedEvidence();
  health.resolve();
  await pending;
  assert.deepEqual(h.events, [
    "observed-exit",
    "drain-start",
    "deadline-start",
    "drain-success",
    "health-start",
    "health-success",
    "deadline-success",
    "marker",
    "synthetic-publication",
  ]);
  assert.deepEqual(h.reasons, [
    "qnf-operation-036",
    "qnf-operation-085",
    "qnf-operation-086",
    "qnf-operation-087",
  ]);
  assert.deepEqual(h.runtime, { postExitDrain: expectedMarker });
  assert.deepEqual(Reflect.ownKeys(h.runtime.postExitDrain as object).sort(), [
    "boundary",
    "remainingWriterSessions",
    "stableZeroSamples",
  ]);
  assert.notEqual(h.runtime.postExitDrain, drained);
  assert.deepEqual(h.counts(), { markerWrites: 1, publications: 1 });
});

for (const phase of ["uninstrumented", "instrumented"] as const) {
  test(`${phase} does no post-exit drain, health, deadline or marker write`, async () => {
    const h = harness({
      phase,
      drain: async () => {
        throw new Error("Unexpected fixed-phase drain");
      },
      healthy: async () => {
        throw new Error("Unexpected fixed-phase health check");
      },
    });
    await h.run();
    assert.deepEqual(h.events, ["observed-exit", "synthetic-publication"]);
    assert.deepEqual(h.reasons, ["qnf-operation-036"]);
    assert.deepEqual(h.runtime, {});
    assert.deepEqual(h.counts(), { markerWrites: 0, publications: 1 });
  });
}

for (const phase of [
  "uninstrumented",
  "instrumented",
  "unfixed-instrumented",
] as const) {
  test(`${phase} rejected native exit evidence prevents drain, health, marker and receipt`, async () => {
    const error = new Error("Synthetic rejected native exit evidence");
    const h = harness({ phase, exitError: error });
    await assert.rejects(h.run(), (caught) => caught === error);
    assert.deepEqual(h.events, ["observed-exit"]);
    assert.deepEqual(h.reasons, ["qnf-operation-036"]);
    h.noCompletedEvidence();
  });
}

test("fresh drain failure preserves its rejection and reaches no health, marker or receipt", async () => {
  const error = new Error("Synthetic nonzero post-exit writer sessions");
  const h = harness({
    drain: async () => {
      throw error;
    },
  });
  await assert.rejects(h.run(), (caught) => caught === error);
  await h.innerSettled();
  assert.deepEqual(h.events, [
    "observed-exit",
    "drain-start",
    "deadline-start",
  ]);
  assert.deepEqual(h.reasons, [
    "qnf-operation-036",
    "qnf-operation-085",
    "qnf-operation-086",
  ]);
  h.noCompletedEvidence();
});

test("post-exit health failure preserves its rejection and reaches no marker or receipt", async () => {
  const error = new Error("Synthetic unhealthy observer");
  const h = harness({
    healthy: async () => {
      throw error;
    },
  });
  await assert.rejects(h.run(), (caught) => caught === error);
  await h.innerSettled();
  assert.deepEqual(h.events, [
    "observed-exit",
    "drain-start",
    "deadline-start",
    "drain-success",
    "health-start",
  ]);
  h.noCompletedEvidence();
});

test("a drain timeout and its later successful drain and health cannot create a marker or receipt", async () => {
  const drain = deferred<Drain>();
  const h = harness({ drain: () => drain.promise, deadlineMilliseconds: 10 });
  await assert.rejects(h.run(), /^Error: Owner operation deadline exceeded$/);
  assert.deepEqual(h.events, [
    "observed-exit",
    "drain-start",
    "deadline-start",
  ]);
  h.noCompletedEvidence();
  drain.resolve(zeroDrain);
  await h.innerSettled();
  assert.deepEqual(h.events, [
    "observed-exit",
    "drain-start",
    "deadline-start",
    "drain-success",
    "health-start",
    "health-success",
  ]);
  h.noCompletedEvidence();
});

test("a health timeout and its later successful health settlement cannot create a marker or receipt", async () => {
  const health = deferred<void>();
  const h = harness({
    healthy: () => health.promise,
    deadlineMilliseconds: 10,
  });
  await assert.rejects(h.run(), /^Error: Owner operation deadline exceeded$/);
  assert.deepEqual(h.events, [
    "observed-exit",
    "drain-start",
    "deadline-start",
    "drain-success",
    "health-start",
  ]);
  h.noCompletedEvidence();
  health.resolve();
  await h.innerSettled();
  assert.deepEqual(h.events, [
    "observed-exit",
    "drain-start",
    "deadline-start",
    "drain-success",
    "health-start",
    "health-success",
  ]);
  h.noCompletedEvidence();
});
