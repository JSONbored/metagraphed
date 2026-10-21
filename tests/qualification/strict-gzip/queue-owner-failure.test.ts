// Three fixed-source native assertions, or one unfixed auth negative control. Run only after the unchanged 490+2 phase.
// Each phase uses a separate root/guard context. No broker delivery claims.
import assert from "node:assert/strict";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { beforeAll, afterAll, test } from "vitest";
import {
  Miniflare,
  NoOpLog,
  Response as MiniflareResponse,
  HYPERDRIVE_PLUGIN,
} from "miniflare";
import { buildPgUpsert } from "../../../src/neon-write.ts";
import {
  CHAIN_DETAIL_CHAIN_EVENT_COLUMNS,
  CHAIN_DETAIL_CONFLICT_KEYS,
} from "../../../src/chain-detail-neon-write.ts";
import {
  validSyncBatchMessage,
  SYNC_BATCH_MAX_BYTES,
} from "../../../src/sync-batch-queue.ts";
import { SYNC_BATCH_MAX_DECODED_BYTES } from "../../../src/sync-batch-limits.ts";
import { resourceFirstVariants } from "../../helpers/sync-resource-first-fixtures.ts";
import { buildQueueOwner } from "./queue-owner-bundle.ts";
import { preserveOwnerBuild } from "./owner-build-evidence.ts";
import { boundedFile } from "./receipt-files.ts";
import { withinOwnerDeadline } from "./owner-deadline.ts";
import { observeOwner } from "./owner-resource-fixture.ts";
import { readOwnerNativeEvidence } from "./owner-native-evidence.ts";
import { OWNER_SCENARIOS } from "./owner-resource-policy.ts";
import {
  POSTGRES_OWNER,
  QUEUE_HYPERDRIVES,
  sha256,
  type QueueExpectedFamilies,
} from "./postgres-owner-fixture.ts";
import {
  FAILURE_HYPERDRIVES,
  FAILURE_CHAIN_QUERY,
  inspectFailureTransport,
  observeFailureTransport,
  assertFailureDisposition,
  assertFailureReceipt,
  type FailureAuth,
  type FailureCaseReceipt,
} from "./failure-postgres-policy.ts";
import {
  FAILURE_TIME,
  failureFamilies,
  partialFailureFamilies,
  combineFailureFamilies,
  emptyFailureFamilies,
  openFailurePostgresFixture,
  type FailurePostgresFixture,
} from "./failure-postgres-fixture.ts";
import {
  FAILURE_PRIVATE_MAX_BYTES,
  validateFailurePrivateEvidence,
  assertFailureSupplementalSourceMaps,
  type FailurePrivateCase,
  type FailurePrivateRuntime,
} from "./failure-postgres-private.ts";
import {
  assertFailureAuthLifecycle,
  assertFailureQueryLifecycle,
  assertFailureDecoderLifecycle,
  assertFailureUnfixedAuthControl,
  assertFailureSuccessfulLifecycle,
} from "./failure-lifecycle-assertions.ts";

type Scenario = "auth-rejection" | "query-cancellation" | "decoder-refusal";
const root = process.env.DECODER_QUALIFICATION_ROOT;
assert.ok(root && path.isAbsolute(root));
assert.ok(
  (globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for("decoder-qualification.host-guard")
  ],
);
assert.equal(process.version, "v22.23.2");
const phasePath = path.join(
  root,
  "tests/qualification/strict-gzip/failure-phase.json",
);
assert.ok(
  lstatSync(phasePath).isFile() && !lstatSync(phasePath).isSymbolicLink(),
);
assert.ok(realpathSync(phasePath).startsWith(realpathSync(root) + path.sep));
const phaseConfig = JSON.parse(
  new TextDecoder().decode(boundedFile(phasePath, 64)),
);
assert.ok(
  phaseConfig.phase === "uninstrumented" ||
    phaseConfig.phase === "instrumented" ||
    phaseConfig.phase === "unfixed-instrumented",
);
assert.deepEqual(Object.keys(phaseConfig), ["phase"]);
const phase: "uninstrumented" | "instrumented" | "unfixed-instrumented" =
  phaseConfig.phase;
const base =
  phase === "uninstrumented"
    ? 9_300_000
    : phase === "instrumented"
      ? 9_400_000
      : 9_450_000;
const receipts: FailureCaseReceipt[] = [];
const privateCases: FailurePrivateCase[] = [];
const runtimePrivate = new WeakMap<Miniflare, FailurePrivateRuntime>();
let activePrivate: FailurePrivateCase | undefined;
let phaseBuilt: Awaited<ReturnType<typeof buildQueueOwner>> | undefined;
let phaseModules: ReturnType<typeof preserveOwnerBuild> | undefined;
beforeAll(async () => {
  phaseBuilt = await buildQueueOwner();
  const supplemental =
    phase === "uninstrumented"
      ? []
      : [
          "workers/data-api.ts",
          "src/pg-sql.ts",
          "src/strict-gzip-reader.ts",
          "tests/qualification/strict-gzip/failure-lifecycle-observer.ts",
          "src/read-store.ts",
          "src/lane-health-store.ts",
        ];
  phaseModules = preserveOwnerBuild(
    "queue",
    "data-api.js",
    phaseBuilt.modules.map((module) => ({
      name: path.relative(phaseBuilt!.modulesRoot, module.path),
      type: module.type,
      bytes: readFileSync(module.path),
    })),
    supplemental,
    { kind: "wrangler-upload", bytes: phaseBuilt.upload },
  );
  if (supplemental.length) {
    const upload = phaseBuilt.upload,
      boundaryEnd = upload.findIndex(
        (byte, index) => byte === 13 && upload[index + 1] === 10,
      );
    assert.ok(boundaryEnd > 2 && boundaryEnd < 200);
    const first = upload.subarray(0, boundaryEnd).toString();
    assert.match(first, /^--[-A-Za-z0-9]+$/);
    const form = await new Response(new Uint8Array(upload).buffer, {
      headers: {
        "Content-Type": `multipart/form-data; boundary=${first.slice(2)}`,
      },
    }).formData();
    const maps: unknown[] = [];
    for (const [, value] of form)
      if (
        typeof value !== "string" &&
        value.type === "application/source-map"
      ) {
        maps.push(JSON.parse(await value.text()));
      }
    assertFailureSupplementalSourceMaps(
      maps,
      Object.fromEntries(
        supplemental.map((relative) => [
          relative,
          readFileSync(path.join(root!, relative), "utf8"),
        ]),
      ),
    );
  }
}, 90_000);
assert.equal(
  sha256(
    readFileSync(path.join(root, "node_modules/miniflare/dist/src/index.js")),
  ),
  POSTGRES_OWNER.miniflareSha256,
);
assert.equal(
  buildPgUpsert(
    "chain_detail_chain_events",
    CHAIN_DETAIL_CHAIN_EVENT_COLUMNS,
    CHAIN_DETAIL_CONFLICT_KEYS.chain_detail_chain_events,
    1,
  ),
  FAILURE_CHAIN_QUERY,
);
function message(id: string, block: number) {
  const body = {
    lane: "chain-detail",
    captured_at: FAILURE_TIME,
    families: failureFamilies(block),
  };
  assert.equal(validSyncBatchMessage(body), true);
  const bytes = Uint8Array.from(gzipSync(JSON.stringify(body)));
  assert.ok(bytes.byteLength <= SYNC_BATCH_MAX_BYTES);
  return {
    id,
    body: bytes.buffer,
    timestamp: new Date(FAILURE_TIME),
    attempts: 1,
  };
}
function bodyHash(value: { body: ArrayBuffer }) {
  return sha256(new Uint8Array(value.body));
}
async function lifecycle(runtime: Miniflare, checkpoint: string) {
  assert.ok(phase === "instrumented" || phase === "unfixed-instrumented");
  const response = await withinOwnerDeadline(
    runtime.dispatchFetch(
      "https://qualification.invalid/__qualification/failure-lifecycle",
    ),
    5000,
  );
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      assert.ok(bytes <= 1_048_576);
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const snapshot = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const record = runtimePrivate.get(runtime);
  assert.ok(record);
  record.lifecycleSnapshots.push({ checkpoint, snapshot });
  return snapshot;
}
async function usingRuntime(
  built: Awaited<ReturnType<typeof buildQueueOwner>>,
  auth: FailureAuth,
  scenario: Scenario,
  fixture: FailurePostgresFixture,
  operation: (
    runtime: Miniflare,
    target: Awaited<ReturnType<Miniflare["getWorker"]>>,
    checkpoint: () => Promise<void>,
  ) => Promise<void>,
) {
  assert.ok(activePrivate);
  const privateRuntime: FailurePrivateRuntime = {
    observation: null,
    lifecycleSnapshots: [],
  };
  activePrivate.runtimes.push(privateRuntime);
  const mapping = auth === "valid" ? QUEUE_HYPERDRIVES : FAILURE_HYPERDRIVES;
  const transport = await inspectFailureTransport(HYPERDRIVE_PLUGIN, auth);
  let native: Miniflare | undefined,
    observation: Awaited<ReturnType<typeof observeOwner>> | undefined;
  let actual: ReturnType<typeof observeFailureTransport> | undefined;
  let disposed = false,
    finished = false,
    restarts = 0,
    blockedOutbound = 0;
  let primary: unknown,
    result: FailureCaseReceipt["runtimes"][number] | undefined;
  try {
    actual = observeFailureTransport(HYPERDRIVE_PLUGIN, auth);
    native = new Miniflare({
      name: OWNER_SCENARIOS.queue.worker,
      modules: built.modules,
      modulesRoot: built.modulesRoot,
      compatibilityDate: built.compatibilityDate,
      compatibilityFlags: built.compatibilityFlags,
      host: "127.0.0.1",
      port: 0,
      inspectorPort: 0,
      cf: false,
      log: new NoOpLog(),
      handleStructuredLogs: () => {},
      unsafeHandleRuntimeRestart() {
        restarts++;
      },
      hyperdrives: { ...mapping },
      kvNamespaces: ["METAGRAPH_CONTROL"],
      bindings:
        phase !== "uninstrumented"
          ? { FAILURE_LIFECYCLE_SCENARIO: scenario }
          : {},
      outboundService() {
        blockedOutbound++;
        return new MiniflareResponse(null, { status: 502 });
      },
    });
    runtimePrivate.set(native, privateRuntime);
    await withinOwnerDeadline(native.ready, 20_000);
    actual.assertObserved();
    actual.restore();
    actual = undefined;
    const target = await withinOwnerDeadline(native.getWorker(), 10_000);
    observation = await observeOwner(
      native,
      OWNER_SCENARIOS.queue.worker,
      () => restarts,
    );
    await observation.sample("baseline");
    await operation(native, target, () => observation!.sample("overlap"));
    const drain = await fixture.drain();
    await fixture.healthy();
    await observation.sample("drained");
    await withinOwnerDeadline(observation.finish(), 10_000);
    finished = true;
    assert.equal(restarts, 0);
    assert.equal(blockedOutbound, 0);
    await withinOwnerDeadline(native.dispose(), 10_000);
    disposed = true;
    const observed = observation.receipt();
    privateRuntime.observation = observed;
    assert.equal(observed.sampleErrors, 0);
    assert.equal(observed.missedSamples, 0);
    assert.ok(observed.samples.length >= 2 && observed.samples.length <= 3);
    const resultFile = process.env.DECODER_QUALIFICATION_RESULT;
    assert.ok(resultFile && path.isAbsolute(resultFile));
    const custody = readOwnerNativeEvidence(path.dirname(resultFile), observed);
    result = {
      mappingSha256: transport.mappingSha256,
      serviceSha256: transport.serviceSha256,
      isolateSha256: sha256(observed.isolateId),
      runtimeSha256: observed.runtimeSha256,
      guardedNativeLaunches: custody.guardedNativeLaunches,
      observedNativeExits: custody.observedNativeExits,
      restarts: 0,
      blockedOutbound: 0,
      pending: 0,
      remainingWriterSessions: drain.remainingWriterSessions,
      stableZeroSamples: drain.stableZeroSamples,
    };
  } catch (error) {
    primary = error;
  }
  const cleanup: unknown[] = [];
  const attempt = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (error) {
      cleanup.push(error);
    }
  };
  if (actual) {
    try {
      actual.restore();
    } catch (error) {
      cleanup.push(error);
    }
  }
  await attempt(() => withinOwnerDeadline(fixture.rollback(), 10_000));
  if (observation && !finished)
    await attempt(() => withinOwnerDeadline(observation!.finish(), 10_000));
  if (native && !disposed)
    await attempt(() => withinOwnerDeadline(native!.dispose(), 10_000));
  if (primary || cleanup.length)
    throw new AggregateError(
      [...(primary ? [primary] : []), ...cleanup],
      "Native failure scenario or cleanup failed",
    );
  assert.ok(result);
  return result;
}
async function withFixture(
  blocks: number[],
  scenario: FailureCaseReceipt["scenario"],
  task: (
    fixture: FailurePostgresFixture,
    built: Awaited<ReturnType<typeof buildQueueOwner>>,
  ) => Promise<FailureCaseReceipt>,
) {
  let fixture: FailurePostgresFixture | undefined;
  let primary: unknown, receipt: FailureCaseReceipt | undefined;
  assert.equal(activePrivate, undefined);
  const privateCase: FailurePrivateCase = {
    scenario,
    runtimes: [],
    cancellation: null,
  };
  activePrivate = privateCase;
  try {
    assert.ok(phaseBuilt);
    fixture = await openFailurePostgresFixture(blocks, root!);
    receipt = await task(fixture, phaseBuilt);
    privateCase.cancellation = fixture.cancellationEvidence();
  } catch (error) {
    primary = error;
  }
  const failures: unknown[] = [];
  if (fixture)
    try {
      await withinOwnerDeadline(fixture.close(), 10_000);
    } catch (error) {
      failures.push(error);
    }
  activePrivate = undefined;
  if (primary || failures.length)
    throw new AggregateError(
      [...(primary ? [primary] : []), ...failures],
      "Failure owner assertion or cleanup failed",
    );
  assert.ok(receipt);
  assert.equal(receipt.scenario, scenario);
  receipts.push(receipt);
  privateCases.push(privateCase);
}
function common(
  scenario: FailureCaseReceipt["scenario"],
  _built: Awaited<ReturnType<typeof buildQueueOwner>>,
) {
  assert.ok(phaseModules);
  return {
    scenario,
    phase,
    modules: phaseModules,
    lifecycle:
      phase === "unfixed-instrumented"
        ? ("negative-control-passed" as const)
        : phase === "instrumented"
          ? ("supplemental-passed" as const)
          : ("not-instrumented" as const),
    productionMemory: "inconclusive" as const,
    productionCpu: "inconclusive" as const,
  };
}

if (phase !== "unfixed-instrumented") {
  test("the real queue rejects immutable wrong-password auth and independently ACKs the unchanged-valid control", async () => {
    await withFixture(
      [base + 1, base + 2],
      "auth-rejection",
      async (fixture, built) => {
        const failed = message("failure-auth", base + 1),
          control = message("control-auth", base + 2);
        const hashes = [bodyHash(failed), bodyHash(control)];
        const runtimes: FailureCaseReceipt["runtimes"] = [];
        runtimes.push(
          await usingRuntime(
            built,
            "wrong-password",
            "auth-rejection",
            fixture,
            async (native, target) => {
              const outcome = await withinOwnerDeadline(
                target.queue("sync-batches", [failed]),
                30_000,
              );
              assertFailureDisposition(outcome, [], [failed.id]);
              await fixture.verifyRows(emptyFailureFamilies());
              await fixture.drain();
              if (phase === "instrumented")
                assertFailureAuthLifecycle(
                  await lifecycle(native, "auth-rejection"),
                );
            },
          ),
        );
        assert.equal(bodyHash(failed), hashes[0]);
        let durable:
          Awaited<ReturnType<FailurePostgresFixture["verifyRows"]>> | undefined;
        runtimes.push(
          await usingRuntime(
            built,
            "valid",
            "auth-rejection",
            fixture,
            async (native, target) => {
              assertFailureDisposition(
                await withinOwnerDeadline(
                  target.queue("sync-batches", [control]),
                  30_000,
                ),
                [control.id],
                [],
              );
              durable = await fixture.verifyRows(failureFamilies(base + 2));
              await fixture.drain();
              if (phase === "instrumented")
                assertFailureSuccessfulLifecycle(
                  await lifecycle(native, "auth-valid-control"),
                  "auth-rejection",
                );
            },
          ),
        );
        assert.equal(bodyHash(control), hashes[1]);
        assert.ok(durable);
        assert.notEqual(runtimes[0]!.isolateSha256, runtimes[1]!.isolateSha256);
        return {
          ...common("auth-rejection", built),
          bodySha256: hashes,
          dispositions: [
            { ack: [], retry: [failed.id] },
            { ack: [control.id], retry: [] },
          ],
          partialCounts: [0, 0, 0, 0],
          partialSha256: sha256(JSON.stringify(emptyFailureFamilies())),
          finalCounts: durable.rowCounts,
          finalSha256: durable.contentSha256,
          runtimes,
          replay: "separate-valid-runtime",
        };
      },
    );
  }, 120_000);

  test("the real queue exposes cancelled second-family partial durability and byte-identical same-isolate manual recovery", async () => {
    await withFixture(
      [base + 11, base + 12],
      "query-cancellation",
      async (fixture, built) => {
        const selected = message("failure-query", base + 11),
          neighbor = message("neighbor-query", base + 12);
        const hashes = [bodyHash(selected), bodyHash(neighbor)];
        let partial:
            | Awaited<ReturnType<FailurePostgresFixture["verifyRows"]>>
            | undefined,
          complete: typeof partial;
        const runtime = await usingRuntime(
          built,
          "valid",
          "query-cancellation",
          fixture,
          async (native, target, checkpoint) => {
            await fixture.arm(base + 11);
            let settled = false,
              completionError: unknown;
            const completion = target
              .queue("sync-batches", [selected, neighbor])
              .then(
                (value) => {
                  settled = true;
                  return value;
                },
                (error) => {
                  settled = true;
                  completionError = error;
                  return undefined;
                },
              );
            try {
              const witness = await fixture.waitForSelected(() => !settled);
              await checkpoint();
              await fixture.cancelSelected(witness, () => !settled);
              const outcome = await withinOwnerDeadline(completion, 30_000);
              assert.equal(completionError, undefined);
              assertFailureDisposition(outcome, [neighbor.id], [selected.id]);
              await fixture.drain();
              if (phase === "instrumented")
                assertFailureQueryLifecycle(
                  await lifecycle(native, "query-failure"),
                  { querySha256: witness.querySha256, backendPid: witness.pid },
                );
              await fixture.rollback();
              partial = await fixture.verifyRows(
                combineFailureFamilies(
                  partialFailureFamilies(base + 11),
                  failureFamilies(base + 12),
                ),
              );
              assert.deepEqual(partial.rowCounts, [1, 2, 1, 2]);
              await fixture.drain();
              assert.equal(bodyHash(selected), hashes[0]);
              assert.equal(bodyHash(neighbor), hashes[1]);
              const replay = { ...selected, attempts: 2 };
              assert.equal(bodyHash(replay), hashes[0]);
              assert.equal(replay.body, selected.body);
              assertFailureDisposition(
                await withinOwnerDeadline(
                  target.queue("sync-batches", [replay]),
                  30_000,
                ),
                [selected.id],
                [],
              );
              complete = await fixture.verifyRows(
                combineFailureFamilies(
                  failureFamilies(base + 11),
                  failureFamilies(base + 12),
                ),
              );
              assert.deepEqual(complete.rowCounts, [2, 2, 2, 2]);
              await fixture.drain();
              if (phase === "instrumented")
                assertFailureQueryLifecycle(
                  await lifecycle(native, "query-replay"),
                  { querySha256: witness.querySha256, backendPid: witness.pid },
                );
            } finally {
              await fixture.rollback();
              // A deadline remains a failure. Lock release/disposal never relabels it cancellation.
              await withinOwnerDeadline(completion, 10_000);
            }
          },
        );
        assert.ok(partial && complete);
        assert.equal(bodyHash(selected), hashes[0]);
        return {
          ...common("query-cancellation", built),
          bodySha256: hashes,
          dispositions: [
            { ack: [neighbor.id], retry: [selected.id] },
            { ack: [selected.id], retry: [] },
          ],
          partialCounts: partial.rowCounts,
          partialSha256: partial.contentSha256,
          finalCounts: complete.rowCounts,
          finalSha256: complete.contentSha256,
          runtimes: [runtime],
          replay: "byte-identical-same-isolate",
        };
      },
    );
  }, 120_000);

  test("the real queue refuses the over-budget bad-tail input while good neighbors and same-isolate later work commit", async () => {
    await withFixture(
      [base + 21, base + 22, base + 23, base + 24],
      "decoder-refusal",
      async (fixture, built) => {
        const first = message("neighbor-before", base + 21),
          last = message("neighbor-after", base + 23),
          later = message("neighbor-later", base + 24);
        const refusedJson = JSON.stringify({
          lane: "chain-detail",
          captured_at: FAILURE_TIME,
          families: failureFamilies(base + 22),
        });
        const bytes = resourceFirstVariants(
          refusedJson,
          SYNC_BATCH_MAX_DECODED_BYTES,
        ).get("bad-crc")!;
        assert.ok(bytes.byteLength <= SYNC_BATCH_MAX_BYTES);
        const refused = {
          id: "failure-decoder",
          body: Uint8Array.from(bytes).buffer,
          timestamp: new Date(FAILURE_TIME),
          attempts: 1,
        };
        const originals = [first, refused, last, later],
          hashes = originals.map(bodyHash);
        let partial:
            | Awaited<ReturnType<FailurePostgresFixture["verifyRows"]>>
            | undefined,
          complete: typeof partial;
        const runtime = await usingRuntime(
          built,
          "valid",
          "decoder-refusal",
          fixture,
          async (native, target) => {
            assertFailureDisposition(
              await withinOwnerDeadline(
                target.queue("sync-batches", [first, refused, last]),
                60_000,
              ),
              [first.id, last.id],
              [refused.id],
            );
            partial = await fixture.verifyRows(
              combineFailureFamilies(
                failureFamilies(base + 21),
                failureFamilies(base + 23),
              ),
            );
            assert.deepEqual(partial.rowCounts, [2, 2, 2, 2]);
            await fixture.drain();
            if (phase === "instrumented")
              assertFailureDecoderLifecycle(
                await lifecycle(native, "decoder-refusal"),
              );
            assert.deepEqual(originals.map(bodyHash), hashes);
            assertFailureDisposition(
              await withinOwnerDeadline(
                target.queue("sync-batches", [later]),
                30_000,
              ),
              [later.id],
              [],
            );
            complete = await fixture.verifyRows(
              combineFailureFamilies(
                failureFamilies(base + 21),
                failureFamilies(base + 23),
                failureFamilies(base + 24),
              ),
            );
            assert.deepEqual(complete.rowCounts, [3, 3, 3, 3]);
            await fixture.drain();
            if (phase === "instrumented")
              assertFailureDecoderLifecycle(
                await lifecycle(native, "decoder-subsequent"),
              );
          },
        );
        assert.ok(partial && complete);
        assert.deepEqual(originals.map(bodyHash), hashes);
        return {
          ...common("decoder-refusal", built),
          bodySha256: hashes,
          dispositions: [
            { ack: [first.id, last.id], retry: [refused.id] },
            { ack: [later.id], retry: [] },
          ],
          partialCounts: partial.rowCounts,
          partialSha256: partial.contentSha256,
          finalCounts: complete.rowCounts,
          finalSha256: complete.contentSha256,
          runtimes: [runtime],
          replay: "same-isolate-subsequent-success",
        };
      },
    );
  }, 120_000);
} else {
  test("the genuine unfixed queue auth control witnesses real rejection and specifically fails the client-end oracle", async () => {
    await withFixture(
      [base + 1],
      "auth-unfixed-control",
      async (fixture, built) => {
        const failed = message("failure-auth-unfixed", base + 1),
          originalHash = bodyHash(failed);
        let control: FailureCaseReceipt["negativeControl"] | undefined;
        let durable:
          Awaited<ReturnType<FailurePostgresFixture["verifyRows"]>> | undefined;
        const runtime = await usingRuntime(
          built,
          "wrong-password",
          "auth-rejection",
          fixture,
          async (native, target) => {
            assertFailureDisposition(
              await withinOwnerDeadline(
                target.queue("sync-batches", [failed]),
                30_000,
              ),
              [],
              [failed.id],
            );
            await fixture.drain();
            durable = await fixture.verifyRows(emptyFailureFamilies());
            control = assertFailureUnfixedAuthControl(
              await lifecycle(native, "auth-unfixed-control"),
            );
          },
        );
        assert.ok(control && durable);
        assert.equal(bodyHash(failed), originalHash);
        return {
          ...common("auth-unfixed-control", built),
          negativeControl: control,
          bodySha256: [originalHash],
          dispositions: [{ ack: [], retry: [failed.id] }],
          partialCounts: durable.rowCounts,
          partialSha256: durable.contentSha256,
          finalCounts: durable.rowCounts,
          finalSha256: durable.contentSha256,
          runtimes: [runtime],
          replay: "no-replay",
        };
      },
    );
  }, 120_000);
}

afterAll(async () => {
  if (phaseBuilt) await phaseBuilt.cleanup();
  const receipt = { version: 1 as const, phase, cases: receipts };
  assertFailureReceipt(receipt);
  const privateReceipt = { version: 1 as const, phase, cases: privateCases };
  validateFailurePrivateEvidence(privateReceipt, receipt);
  const result = process.env.DECODER_QUALIFICATION_RESULT;
  assert.ok(result && path.isAbsolute(result));
  const bytes = JSON.stringify(receipt) + "\n";
  assert.ok(Buffer.byteLength(bytes) <= 32768);
  const privateBytes = JSON.stringify(privateReceipt) + "\n";
  assert.ok(Buffer.byteLength(privateBytes) <= FAILURE_PRIVATE_MAX_BYTES);
  writeFileSync(
    path.join(path.dirname(result), "owner-queue-failure-private.json"),
    privateBytes,
    { flag: "wx", mode: 0o600 },
  );
  writeFileSync(
    path.join(path.dirname(result), "owner-queue-failure.json"),
    bytes,
    { flag: "wx", mode: 0o600 },
  );
});
