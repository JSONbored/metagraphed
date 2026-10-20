// Direct valid native queue inputs. Real pg serialization and native TCP remain
// in the unchanged Data API owner. This first scenario is positive-path only.
import assert from "node:assert/strict";
import { withinOwnerDeadline } from "./owner-deadline.ts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  Miniflare,
  NoOpLog,
  Response as MiniflareResponse,
  HYPERDRIVE_PLUGIN,
} from "miniflare";
import { test } from "vitest";
import { buildPgUpsert } from "../../../src/neon-write.ts";
import {
  CHAIN_DETAIL_EXTRINSIC_COLUMNS,
  CHAIN_DETAIL_CONFLICT_KEYS,
} from "../../../src/chain-detail-neon-write.ts";
import {
  validSyncBatchMessage,
  SYNC_BATCH_MAX_BYTES,
} from "../../../src/sync-batch-queue.ts";
import { buildQueueOwner } from "./queue-owner-bundle.ts";
import { observeOwner, writeOwnerReceipt } from "./owner-resource-fixture.ts";
import { OWNER_SCENARIOS, type OwnerProof } from "./owner-resource-policy.ts";
import { preserveOwnerBuild } from "./owner-build-evidence.ts";
import { BASE_COMMIT, PRIMITIVE_SHA256 } from "./verify-candidate.ts";
import {
  armQueueBarrier,
  inspectQueueHyperdriveTransport,
  observeActualQueueTransport,
  POSTGRES_OWNER,
  QUEUE_HYPERDRIVES,
  QUEUE_FIRST_QUERY,
  sha256,
  type QueueBarrier,
  type QueueExpectedFamilies,
} from "./postgres-owner-fixture.ts";

const TIME = 1_780_000_000_000;
const FIRST = [9_100_001, 9_200_001] as const;
function families(block: number): QueueExpectedFamilies {
  return {
    blockRows: [
      {
        block_number: block,
        block_hash: `0x${block.toString(16).padStart(64, "0")}`,
        spec_version: 441,
        extrinsic_count: 1,
        chain_event_count: 1,
        account_event_count: 1,
        observed_at: TIME,
        synced_at: TIME,
        native_transfer_tao: "1.0",
        stake_flow_tao: "0",
        economic_activity_tao: "1.0",
        fee_tao: "0.1",
        tip_tao: "0.01",
        issuance_tao: "0",
        subnet_ids: "[]",
        economics_complete: false,
      },
    ],
    extrinsicRows: [
      {
        block_number: block,
        extrinsic_index: 0,
        extrinsic_hash: `0x${(block + 1).toString(16).padStart(64, "0")}`,
        signer: null,
        call_module: "System",
        call_function: `remark-${block}`,
        success: true,
        fee_tao: "0.1",
        tip_tao: "0.01",
        call_args: JSON.stringify([
          { name: "memo", type: "Bytes", value: `synthetic-${block}` },
        ]),
        observed_at: TIME,
      },
    ],
    chainEventRows: [
      {
        block_number: block,
        event_index: 0,
        pallet: "System",
        method: "ExtrinsicSuccess",
        args: "[]",
        phase: "ApplyExtrinsic",
        extrinsic_index: 0,
        observed_at: TIME,
      },
    ],
    accountEventRows: [
      {
        block_number: block,
        event_index: 1,
        extrinsic_index: 0,
        event_kind: "Transfer",
        hotkey: null,
        coldkey: null,
        netuid: null,
        uid: null,
        amount_tao: "1.0",
        alpha_amount: null,
        observed_at: TIME,
      },
    ],
  };
}

test("the complete Data API owner overlaps two native ten-message events through real pg and drains every writer connection", async () => {
  const root = process.env.DECODER_QUALIFICATION_ROOT;
  assert.ok(root && path.isAbsolute(root));
  assert.ok(
    (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for("decoder-qualification.host-guard")
    ],
  );
  assert.equal(process.version, "v22.23.2");
  assert.equal(
    sha256(
      readFileSync(path.join(root, "node_modules/miniflare/dist/src/index.js")),
    ),
    POSTGRES_OWNER.miniflareSha256,
  );
  // Pure pinned-plugin construction before any native owner launch. This native
  // TCP service bypasses Node wrappers, so exact mapping is a separate boundary.
  assert.equal(
    buildPgUpsert(
      "chain_detail_extrinsics",
      CHAIN_DETAIL_EXTRINSIC_COLUMNS,
      CHAIN_DETAIL_CONFLICT_KEYS.chain_detail_extrinsics,
      1,
    ),
    QUEUE_FIRST_QUERY,
  );
  const transport = await inspectQueueHyperdriveTransport(
    HYPERDRIVE_PLUGIN as Parameters<typeof inspectQueueHyperdriveTransport>[0],
  );
  let built: Awaited<ReturnType<typeof buildQueueOwner>> | undefined;
  let runtime: Miniflare | undefined, barrier: QueueBarrier | undefined;
  let observer: Awaited<ReturnType<typeof observeOwner>> | undefined;
  let observerFinished = false,
    runtimeDisposed = false,
    restarts = 0,
    blockedOutbound = 0;
  let completed = 0,
    releasedAt = 0,
    proof: OwnerProof | undefined;
  let actualTransport:
    ReturnType<typeof observeActualQueueTransport> | undefined;
  let completion: Promise<unknown> | undefined, completionFailure: unknown;
  const expected: QueueExpectedFamilies = {
    blockRows: [],
    extrinsicRows: [],
    chainEventRows: [],
    accountEventRows: [],
  };
  try {
    built = await buildQueueOwner();
    const modules = preserveOwnerBuild(
      "queue",
      "data-api.js",
      built.modules.map((module) => ({
        name: path.relative(built!.modulesRoot, module.path),
        type: module.type,
        bytes: readFileSync(module.path),
      })),
      [],
      { kind: "wrangler-upload", bytes: built.upload },
    );
    barrier = await armQueueBarrier(FIRST[0], FIRST[1], root);
    actualTransport = observeActualQueueTransport(
      HYPERDRIVE_PLUGIN as Parameters<typeof observeActualQueueTransport>[0],
    );
    runtime = new Miniflare({
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
      unsafeHandleRuntimeRestart: () => {
        restarts++;
      },
      hyperdrives: { ...QUEUE_HYPERDRIVES },
      kvNamespaces: ["METAGRAPH_CONTROL"],
      outboundService() {
        blockedOutbound++;
        return new MiniflareResponse(null, { status: 502 });
      },
    });
    await withinOwnerDeadline(runtime.ready, 20_000);
    actualTransport.assertObserved();
    actualTransport.restore();
    actualTransport = undefined;
    const target = await withinOwnerDeadline(runtime.getWorker(), 10_000);
    observer = await observeOwner(
      runtime,
      OWNER_SCENARIOS.queue.worker,
      () => restarts,
    );
    await observer.sample("baseline");
    const events = FIRST.map((first, event) =>
      Array.from({ length: 10 }, (_, index) => {
        const rows = families(first + index);
        for (const family of Object.keys(
          expected,
        ) as (keyof QueueExpectedFamilies)[])
          expected[family].push(...rows[family]);
        const body = {
          lane: "chain-detail",
          captured_at: TIME,
          families: rows,
        };
        assert.equal(validSyncBatchMessage(body), true);
        const compressed = Uint8Array.from(gzipSync(JSON.stringify(body)));
        assert.ok(compressed.byteLength <= SYNC_BATCH_MAX_BYTES);
        return {
          id: `owner-${event}-${index}`,
          body: compressed.buffer,
          timestamp: new Date(TIME),
          attempts: 1,
        };
      }),
    );
    const pending = events.map((messages) =>
      target.queue("sync-batches", messages).then(
        (result) => {
          completed++;
          return result;
        },
        () => {
          completed++;
          throw new Error("Native queue event failed");
        },
      ),
    );
    const outcomesPromise = Promise.all(pending).catch((error) => {
      completionFailure = error;
      return undefined;
    });
    completion = outcomesPromise;
    const waiting = await barrier.waitForTwo(() => completed === 0);
    assert.equal(waiting.operations.length, 2);
    await observer.sample("overlap");
    assert.equal(completed, 0);
    releasedAt = performance.now();
    await withinOwnerDeadline(barrier.release(), 10_000);
    const outcomes = await withinOwnerDeadline(outcomesPromise, 60_000);
    assert.equal(completionFailure, undefined);
    assert.ok(outcomes);
    outcomes.forEach((outcome, index) =>
      assert.deepEqual(outcome, {
        outcome: "ok",
        ackAll: false,
        retryBatch: { retry: false },
        explicitAcks: events[index]!.map((row) => row.id),
        retryMessages: [],
      }),
    );
    const durable = await withinOwnerDeadline(
      barrier.verifyRows(expected),
      20_000,
    );
    assert.deepEqual(durable.rowCounts, [20, 20, 20, 20]);
    const drain = await barrier.drain();
    assert.equal(drain.remainingWriterSessions, 0);
    await observer.sample("drained");
    await withinOwnerDeadline(observer.finish(), 10_000);
    observerFinished = true;
    assert.equal(blockedOutbound, 0);
    assert.equal(restarts, 0);
    await withinOwnerDeadline(runtime.dispose(), 10_000);
    runtimeDisposed = true;
    await withinOwnerDeadline(barrier.close(), 10_000);
    barrier = undefined;
    proof = {
      owner: "queue",
      scenario: OWNER_SCENARIOS.queue.scenario,
      baseCommit: BASE_COMMIT,
      primitiveSha256: PRIMITIVE_SHA256,
      modules,
      nativeEvents: { kind: "queue", completed, outcomesOk: outcomes.length },
      overlap: {
        ids: waiting.operations.map((row) => row.owner),
        arrivalsMs: waiting.operations.map(() => waiting.observedMonotonicMs),
        releaseMs: releasedAt,
        pendingAtRelease: 2,
        settledBeforeRelease: 0,
      },
      durable: {
        expected: 80,
        verified: durable.rowCounts.reduce((sum, n) => sum + n, 0),
        mismatches: 0,
      },
      cleanup: {
        pending: 0,
        unexplainedSessions: drain.remainingWriterSessions,
        runtimeDisposed,
      },
      observations: observer.receipt(),
      productionIsolateMemory: "inconclusive",
      productionCpu: "inconclusive",
      productionCpuBudgetMs: null,
      runtimeResourceLimitEnforced: false,
    };
    // Bounded additional source/transport facts remain available for review;
    // the publication allowlist emits only separately validated fields.
    Object.assign(proof, {
      queueDetails: {
        transportSha256: transport.serviceSha256,
        pgSources: built.pgSources,
        contentSha256: durable.contentSha256,
        counts: durable.rowCounts,
        stableZeroSamples: drain.stableZeroSamples,
        scope: "direct-valid-queue-inputs",
      },
    });
  } finally {
    const failures: unknown[] = [];
    const attempt = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    };
    if (actualTransport) {
      try {
        actualTransport.restore();
      } catch (error) {
        failures.push(error);
      }
    }
    if (barrier)
      await attempt(() => withinOwnerDeadline(barrier!.release(), 10_000));
    if (completion)
      await attempt(() => withinOwnerDeadline(completion!, 10_000));
    if (observer && !observerFinished)
      await attempt(() => withinOwnerDeadline(observer!.finish(), 10_000));
    if (runtime && !runtimeDisposed)
      await attempt(() => withinOwnerDeadline(runtime!.dispose(), 10_000));
    if (barrier)
      await attempt(() => withinOwnerDeadline(barrier!.close(), 10_000));
    if (built) await attempt(() => built!.cleanup());
    assert.equal(failures.length, 0, "Queue owner cleanup failed");
  }
  assert.ok(proof);
  await writeOwnerReceipt("queue", proof);
}, 120_000);
