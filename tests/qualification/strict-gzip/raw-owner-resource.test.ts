// Real scheduled API entry, real native D1, and host-held two-lane RPC reads.
// This deliberately establishes neither simultaneous writer buffers nor a
// production memory/CPU bound. Run only inside the existing reviewed guard.
import assert from "node:assert/strict";
import { Miniflare, NoOpLog, Response as MiniflareResponse } from "miniflare";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { stripJsonComments } from "../../../scripts/lib.ts";
import { RAW_CAPTURE_CRON } from "../../../workers/config.ts";
import {
  RAW_CAPTURE_GENESIS_FLOOR,
  TESTNET_RAW_CAPTURE_GENESIS_FLOOR,
} from "../../../src/raw-capture-floors.ts";
import { SYSTEM_EVENTS_STORAGE_KEY } from "../../../src/twox-storage-key.ts";
import { observeOwner, writeOwnerReceipt } from "./owner-resource-fixture.ts";
import { preserveOwnerBuild } from "./owner-build-evidence.ts";
import { withinOwnerDeadline } from "./owner-deadline.ts";
import { PRIMITIVE_SHA256 } from "./verify-candidate.ts";
import type { OwnerProof } from "./owner-resource-policy.ts";
import {
  RAW_NETWORKS,
  RAW_OWNER_NAME,
  RAW_RPC_URLS,
  RAW_SCENARIO,
  RAW_SOURCE_BASE,
  boundedRawRequest,
  buildRawOwner,
  cleanupRawOwner,
  rawDigest,
  rawLane,
  rawPairBarrier,
  rawRpcPayload,
  seedRawDatabase,
  verifyRawDatabase,
} from "./raw-owner-fixture.ts";

test("the complete API scheduled owner commits both 25-block lanes with native D1 and overlapping RPC reads", async () => {
  const root = process.env.DECODER_QUALIFICATION_ROOT;
  assert.ok(root && path.isAbsolute(root));
  assert.ok(
    (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for("decoder-qualification.host-guard")
    ],
  );
  assert.equal(process.version, "v22.23.2");
  assert.equal(Object.hasOwn(process.env, "NODE_PG_FORCE_NATIVE"), false);
  const scratch = await mkdtemp(
    path.join(tmpdir(), "raw-owner-qualification-"),
  );
  let runtime: Miniflare | undefined;
  let observer: Awaited<ReturnType<typeof observeOwner>> | undefined;
  let observerFinished = false;
  let runtimeDisposed = false;
  let completion: Promise<unknown> | undefined;
  let runtimeRestarts = 0;
  let active = 0;
  let openBodies = 0;
  let cancelledBodies = 0;
  let blocked = 0;
  let fixtureFailures = 0;
  let phase: "warm" | "capture" = "warm";
  const counts = { mainnet: 0, testnet: 0 };
  const responseReceipts: {
    network: string;
    method: string;
    calls: number;
    requestBytes: number;
    requestSha256: string;
    responseBytes: number;
    responseSha256: string;
  }[] = [];
  const lanes = [
    rawLane("mainnet", RAW_CAPTURE_GENESIS_FLOOR),
    rawLane("testnet", TESTNET_RAW_CAPTURE_GENESIS_FLOOR),
  ];
  const barrier = rawPairBarrier(async () => {
    assert.ok(observer);
    await observer.sample("overlap");
  });
  let proof: (OwnerProof & { rawDetails: unknown }) | undefined;
  try {
    const built = await buildRawOwner(root, path.join(scratch, "modules"));
    const moduleEvidence = preserveOwnerBuild(
      "raw",
      "api.entry.js",
      await Promise.all(
        built.modules.map(async (module) => ({
          name: path.relative(path.join(scratch, "modules"), module.path),
          type: module.type,
          bytes: await readFile(module.path),
        })),
      ),
      built.sourcePaths,
      { kind: "api-builder", bytes: built.association },
    );
    const config = JSON.parse(
      stripJsonComments(
        await readFile(path.join(root, "wrangler.jsonc"), "utf8"),
      ),
    );
    assert.equal(config.main, "dist/api-modules/api.entry.js");
    assert.equal(config.no_bundle, true);
    assert.equal(config.find_additional_modules, true);
    assert.equal(config.compatibility_date, "2026-06-06");
    assert.deepEqual(config.compatibility_flags, [
      "nodejs_compat",
      "global_fetch_strictly_public",
    ]);
    assert.ok(config.triggers.crons.includes(RAW_CAPTURE_CRON));
    assert.equal(config.limits?.cpu_ms, undefined);
    assert.equal(config.usage_model, undefined);
    const bindings = {
      RAW_CAPTURE_ENABLED: "true",
      RAW_CAPTURE_STORAGE: "d1",
      D1_STATE_TABLES: "raw_capture_state",
      CHAIN_HEAD_RPC_URL: RAW_RPC_URLS.mainnet,
      TESTNET_CHAIN_HEAD_RPC_URL: RAW_RPC_URLS.testnet,
    };
    assert.equal(Object.hasOwn(bindings, "NODE_PG_FORCE_NATIVE"), false);
    runtime = new Miniflare({
      name: RAW_OWNER_NAME,
      modules: built.modules,
      modulesRoot: path.join(scratch, "modules"),
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags,
      host: "127.0.0.1",
      port: 0,
      inspectorPort: 0,
      cf: false,
      log: new NoOpLog(),
      // Native logs are not receipt data; assertions provide bounded failures.
      handleStructuredLogs: () => {},
      unsafeHandleRuntimeRestart: () => {
        runtimeRestarts++;
      },
      d1Databases: ["D1_STATE"],
      r2Buckets: ["METAGRAPH_ARCHIVE"],
      bindings,
      async outboundService(request) {
        const lane = lanes.find(
          (lane) => request.url === RAW_RPC_URLS[lane.network],
        );
        if (!lane || request.method !== "POST") {
          blocked++;
          await request.body?.cancel();
          return new MiniflareResponse(null, { status: 502 });
        }
        active++;
        try {
          assert.ok(active <= 2);
          const input = await boundedRawRequest(request.body);
          const payload = rawRpcPayload(
            lane,
            JSON.parse(input.toString("utf8")),
            SYSTEM_EVENTS_STORAGE_KEY,
          );
          const index = counts[lane.network]++;
          if (phase === "warm") {
            assert.equal(index, 0);
            assert.equal(payload.method, "chain_getHeader");
          } else {
            assert.equal(
              payload.method,
              ["chain_getHeader", "chain_getBlockHash", "batch"][index],
            );
          }
          const receipt = {
            network: lane.network,
            method: payload.method,
            calls: payload.calls,
            requestBytes: input.length,
            requestSha256: rawDigest(input),
            responseBytes: payload.bytes.length,
            responseSha256: rawDigest(payload.bytes),
          };
          assert.ok(responseReceipts.length < 8);
          responseReceipts.push(receipt);
          if (payload.calls === 50)
            await barrier.arrive(
              lane.network,
              receipt.requestSha256,
              receipt.responseSha256,
            );
          let offset = 0;
          let finished = false;
          openBodies++;
          const finish = () => {
            if (!finished) {
              finished = true;
              openBodies--;
            }
          };
          // Generated and chunked on the host. No provider socket or DNS exists.
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (offset === payload.bytes.length) {
                finish();
                controller.close();
                return;
              }
              const end = Math.min(offset + 4096, payload.bytes.length);
              controller.enqueue(payload.bytes.subarray(offset, end));
              offset = end;
            },
            cancel() {
              cancelledBodies++;
              finish();
            },
          });
          return new MiniflareResponse(stream, {
            headers: {
              "content-type": "application/json",
              "content-length": String(payload.bytes.length),
            },
          });
        } catch {
          fixtureFailures++;
          return new MiniflareResponse(null, { status: 500 });
        } finally {
          active--;
        }
      },
    });
    await withinOwnerDeadline(runtime.ready, 20_000);
    const db = (await withinOwnerDeadline(
      runtime.getD1Database("D1_STATE", RAW_OWNER_NAME),
      10_000,
    )) as unknown as D1Database;
    const schema = await withinOwnerDeadline(
      seedRawDatabase(root, db, lanes),
      20_000,
    );
    // The real endpoint-discovery reader finds only this empty local artifact.
    const artifacts = await withinOwnerDeadline(
      runtime.getR2Bucket("METAGRAPH_ARCHIVE", RAW_OWNER_NAME),
      10_000,
    );
    await withinOwnerDeadline(
      artifacts.put("latest/rpc/pools.json", JSON.stringify({ pools: [] })),
      10_000,
    );
    const target = await withinOwnerDeadline(
      runtime.getWorker(RAW_OWNER_NAME),
      10_000,
    );
    // Warm the complete lazy API graph through its real scheduled path. Head
    // equals seeded watermark, so this setup event produces no capture objects.
    for (const lane of lanes)
      await withinOwnerDeadline(
        db
          .prepare(
            "UPDATE raw_capture_state SET last_contiguous_block=? WHERE network=?",
          )
          .bind(lane.last, lane.network)
          .run(),
        10_000,
      );
    const warmPending = target.scheduled({
      cron: RAW_CAPTURE_CRON,
      scheduledTime: new Date(),
    });
    completion = warmPending;
    const warm = await withinOwnerDeadline(warmPending, 20_000);
    completion = undefined;
    assert.equal(warm.outcome, "ok");
    assert.deepEqual(counts, { mainnet: 1, testnet: 1 });
    assert.equal(
      active + openBodies + cancelledBodies + blocked + fixtureFailures,
      0,
    );
    assert.equal(
      await withinOwnerDeadline(
        db.prepare("SELECT count(*) n FROM raw_capture_batches").first("n"),
        10_000,
      ),
      0,
    );
    for (const lane of lanes) {
      assert.equal(
        await withinOwnerDeadline(
          db
            .prepare(
              "SELECT last_contiguous_block FROM raw_capture_state WHERE network=?",
            )
            .bind(lane.network)
            .first("last_contiguous_block"),
          10_000,
        ),
        lane.last,
      );
      await withinOwnerDeadline(
        db
          .prepare(
            "UPDATE raw_capture_state SET last_contiguous_block=? WHERE network=?",
          )
          .bind(lane.first - 1, lane.network)
          .run(),
        10_000,
      );
    }
    observer = await observeOwner(
      runtime,
      RAW_OWNER_NAME,
      () => runtimeRestarts,
    );
    await observer.sample("baseline");
    phase = "capture";
    counts.mainnet = 0;
    counts.testnet = 0;
    const startedAt = Date.now();
    const capturePending = target.scheduled({
      cron: RAW_CAPTURE_CRON,
      scheduledTime: new Date(startedAt),
    });
    completion = capturePending;
    const outcome = await withinOwnerDeadline(capturePending, 30_000);
    completion = undefined;
    const endedAt = Date.now();
    assert.equal(outcome.outcome, "ok");
    await observer.sample("drained");
    assert.equal(runtimeRestarts, 0);
    assert.equal(
      active + openBodies + cancelledBodies + blocked + fixtureFailures,
      0,
    );
    assert.deepEqual(counts, { mainnet: 3, testnet: 3 });
    const overlap = barrier.receipt();
    assert.equal(overlap.failed, false);
    assert.equal(overlap.released, true);
    assert.equal(overlap.maximumPending, 2);
    assert.equal(overlap.pendingAtRelease, 2);
    assert.equal(overlap.settledBeforeRelease, 0);
    assert.equal(overlap.pending, 0);
    assert.ok(overlap.openedAtMs !== null);
    assert.deepEqual(
      overlap.arrivals.map((row) => row.network),
      [...RAW_NETWORKS],
    );
    assert.ok(overlap.arrivals.every((row) => row.atMs < overlap.openedAtMs!));
    const durable = await withinOwnerDeadline(
      verifyRawDatabase(db, lanes, startedAt, endedAt),
      20_000,
    );
    await withinOwnerDeadline(observer.finish(), 10_000);
    observerFinished = true;
    await withinOwnerDeadline(runtime.dispose(), 10_000);
    runtimeDisposed = true;
    proof = {
      owner: "raw",
      scenario: RAW_SCENARIO,
      baseCommit: RAW_SOURCE_BASE,
      primitiveSha256: PRIMITIVE_SHA256,
      modules: moduleEvidence,
      nativeEvents: { kind: "scheduled", completed: 1, outcomesOk: 1 },
      overlap: {
        ids: overlap.arrivals.map((row) => row.network),
        arrivalsMs: overlap.arrivals.map((row) => row.atMs),
        releaseMs: overlap.openedAtMs,
        pendingAtRelease: overlap.pendingAtRelease,
        settledBeforeRelease: overlap.settledBeforeRelease,
      },
      durable: {
        expected: 50,
        verified: durable.reduce((sum, row) => sum + row.records, 0),
        mismatches: 0,
      },
      cleanup: {
        pending: active + openBodies + overlap.pending,
        unexplainedSessions: 0,
        runtimeDisposed,
      },
      observations: observer.receipt(),
      productionIsolateMemory: "inconclusive",
      productionCpu: "inconclusive",
      productionCpuBudgetMs: null,
      runtimeResourceLimitEnforced: false,
      rawDetails: {
        build: {
          sourceBase: built.proof.sourceBase,
          sources: built.proof.sources,
          identityKind: built.proof.identityKind,
          exactWranglerUpload: built.proof.exactWranglerUpload,
          entryUnmodified: built.proof.entryUnmodified,
          instrumentation: built.proof.instrumentation,
          entryIndex: built.proof.entryIndex,
          moduleManifestSha256: rawDigest(JSON.stringify(built.proof)),
          executableModules: built.modules.length,
          contributions: built.proof.contributions,
          totalBytes: built.proof.totalBytes,
          metafileSha256: built.proof.metafileSha256,
        },
        schema,
        cron: RAW_CAPTURE_CRON,
        warmEvent: { outcome: warm.outcome, noRetry: warm.noRetry },
        captureEvent: { outcome: outcome.outcome, noRetry: outcome.noRetry },
        overlap,
        durable,
        rpc: responseReceipts,
        cancelledBodies,
        blockedOutbound: blocked,
        fixtureFailures,
        scope: "unwrapped-owner-host-rpc-overlap-native-d1",
      },
    };
  } finally {
    const failures = await cleanupRawOwner({
      barrier: () => barrier.close(),
      ...(completion ? { completion: () => completion! } : {}),
      ...(observer && !observerFinished
        ? { observer: () => observer!.finish() }
        : {}),
      ...(runtime && !runtimeDisposed
        ? { runtime: () => runtime!.dispose() }
        : {}),
      files: () => rm(scratch, { recursive: true, force: true }),
    });
    assert.deepEqual(failures, [], "Raw owner cleanup failed");
  }
  assert.ok(proof);
  await writeOwnerReceipt("raw", proof);
}, 120_000);
