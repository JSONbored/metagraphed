// Private proof replay for additional phases. Every published field is rebuilt
// from bounded fixed-schema evidence; original baseline validators are unchanged.
import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { boundedFile } from "./receipt-files.ts";
import {
  RAW_LIMITS,
  processChildGuardEvidence,
  threadLifecycleEvidence,
  nativeUnobservedExitCount,
} from "./receipt-policy.ts";
import {
  OWNER_BUILD_LIMITS,
  boundedBuildFile,
  runnerRuntimeIdentity,
  validateOwnerBuild,
} from "./owner-build-evidence.ts";
import { readOwnerNativeEvidence } from "./owner-native-evidence.ts";
import { validateServiceReceipt } from "./owner-service.ts";
import { assertFailureReceipt } from "./failure-postgres-policy.ts";
import {
  FAILURE_PRIVATE_MAX_BYTES,
  validateFailurePrivateEvidence,
  assertFailureSupplementalSourceMaps,
} from "./failure-postgres-private.ts";
import { validateFailureTestEvidence } from "./failure-test-evidence.ts";
import { type FailurePhase } from "./failure-variants.ts";
const extraFiles = {
  "owner-service.json": 65536,
  "owner-queue-failure.json": 65536,
  "owner-queue-failure-private.json": FAILURE_PRIVATE_MAX_BYTES,
} as const;
export function validateFailureReceiptDirectory(run: string) {
  const stat = lstatSync(run);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  const canonical = realpathSync(run);
  const entries = readdirSync(run, { withFileTypes: true });
  assert.ok(entries.length <= Object.keys(RAW_LIMITS).length + 4);
  for (const entry of entries) {
    const full = path.join(run, entry.name);
    assert.ok(!entry.isSymbolicLink());
    assert.ok(realpathSync(full).startsWith(canonical + path.sep));
    if (entry.name === "owner-builds") {
      assert.ok(entry.isDirectory());
      const owners = readdirSync(full, { withFileTypes: true });
      assert.equal(owners.length, 1);
      assert.equal(owners[0]!.name, "queue");
      assert.ok(owners[0]!.isDirectory() && !owners[0]!.isSymbolicLink());
      const build = path.join(full, "queue"),
        files = readdirSync(build, { withFileTypes: true });
      assert.ok(files.length >= 2 && files.length <= OWNER_BUILD_LIMITS.files);
      let total = 0;
      for (const file of files) {
        assert.ok(file.isFile() && !file.isSymbolicLink());
        assert.ok(
          file.name === "manifest.json" ||
            file.name === "association.bin" ||
            /^module-\d{3}\.bin$/.test(file.name),
        );
        const limit =
          file.name === "manifest.json"
            ? OWNER_BUILD_LIMITS.manifestBytes
            : file.name === "association.bin"
              ? OWNER_BUILD_LIMITS.associationBytes
              : OWNER_BUILD_LIMITS.moduleBytes;
        const bytes = boundedBuildFile(path.join(build, file.name), limit);
        total += bytes.length;
        assert.ok(
          total <=
            OWNER_BUILD_LIMITS.totalBytes + OWNER_BUILD_LIMITS.manifestBytes,
        );
      }
    } else {
      assert.ok(entry.isFile());
      const limit = Object.hasOwn(extraFiles, entry.name)
        ? extraFiles[entry.name as keyof typeof extraFiles]
        : RAW_LIMITS[entry.name as keyof typeof RAW_LIMITS];
      assert.ok(Number.isSafeInteger(limit));
      assert.ok(!entry.name.includes("/"));
      boundedFile(full, limit);
    }
  }
}
export interface FailureGuardContext {
  vitest: string;
  worker: string;
  wranglerBin: string;
  wranglerCli: string;
}
export function validateFailureGuardEvidence(
  events: any[],
  context: FailureGuardContext,
) {
  assert.ok(
    Array.isArray(events) && events.length > 0 && events.length <= 100000,
  );
  assert.equal(events.filter((event) => event.kind === "denied").length, 0);
  assert.equal(processChildGuardEvidence(events), true);
  for (const kind of ["guard-start", "guard-exit"]) {
    const records = events.filter((event) => event.kind === kind);
    assert.equal(records.length, 4);
    assert.ok(records.every((event) => event.threadId === 0));
  }
  assert.equal(
    events.filter((event) => event.kind === "node-child-exit").length,
    3,
  );

  const children = events.filter((event) => event.kind === "node-child");
  assert.equal(children.length, 3);
  assert.equal(new Set(children.map((event) => event.launchId)).size, 3);
  assert.equal(new Set(children.map((event) => event.childPid)).size, 3);
  const roles = [
    [context.vitest, "coordinator"],
    [context.worker, "test-worker"],
    [context.wranglerBin, "wrangler-bin"],
    [context.wranglerCli, "wrangler-cli"],
  ] as const;
  assert.equal(new Set(roles.map(([entry]) => entry)).size, 4);
  for (const [entry, role] of roles) {
    assert.ok(path.isAbsolute(entry));
    const starts = events.filter(
      (event) =>
        event.kind === "guard-start" &&
        event.threadId === 0 &&
        event.realEntry === entry,
    );
    assert.equal(starts.length, 1);
    const start = starts[0];
    assert.equal(start.role, role);
    assert.ok(Number.isSafeInteger(start.pid) && start.pid > 0);
    const exits = events.filter(
      (event) =>
        event.kind === "guard-exit" &&
        event.threadId === 0 &&
        event.pid === start.pid &&
        event.realEntry === entry,
    );
    assert.equal(exits.length, 1);
    assert.ok(events.indexOf(start) < events.indexOf(exits[0]));
    assert.equal(exits[0].denied, 0);
    assert.equal(exits[0].threadFailed, false);
  }

  const startFor = (entry: string) =>
    events.find(
      (event) =>
        event.kind === "guard-start" &&
        event.threadId === 0 &&
        event.realEntry === entry,
    );
  for (const [parentEntry, childEntry, role] of [
    [context.vitest, context.worker, "test-worker"],
    [context.worker, context.wranglerBin, "wrangler-bin"],
    [context.wranglerBin, context.wranglerCli, "wrangler-cli"],
  ]) {
    const parent = startFor(parentEntry!),
      child = startFor(childEntry!);
    const launches = children.filter((event) => event.childPid === child.pid);
    assert.equal(launches.length, 1);
    const launch = launches[0];
    assert.equal(launch.pid, parent.pid);
    assert.equal(launch.threadId, 0);
    assert.equal(launch.role, role);
    assert.equal(launch.synchronous, false);
    assert.match(launch.launchId, new RegExp(`^${parent.pid}:\\d+$`));
    assert.ok(events.indexOf(parent) < events.indexOf(launch));
    const exits = events.filter(
      (event) =>
        event.kind === "node-child-exit" && event.launchId === launch.launchId,
    );
    assert.equal(exits.length, 1);
    const exit = exits[0];
    for (const key of ["pid", "threadId", "role", "childPid", "synchronous"])
      assert.equal(exit[key], launch[key]);
    assert.equal(exit.observation, "exit-event");
    assert.ok(events.indexOf(launch) < events.indexOf(exit));
    assert.ok(events.indexOf(child) < events.indexOf(exit));
    assert.equal(exit.signal, null);
    if (role === "test-worker" && exit.code === 143) {
      const signals = events.filter(
        (event) =>
          event.kind === "guard-signal" &&
          event.pid === child.pid &&
          event.threadId === 0 &&
          event.realEntry === childEntry,
      );
      assert.equal(signals.length, 1);
      assert.equal(signals[0].signal, "SIGTERM");
      assert.equal(signals[0].exitCode, 143);
      assert.ok(
        events.indexOf(child) < events.indexOf(signals[0]) &&
          events.indexOf(signals[0]) < events.indexOf(exit),
      );
    } else assert.equal(exit.code, 0);
  }

  const workerExit = events.find(
    (event) => event.kind === "node-child-exit" && event.role === "test-worker",
  );
  assert.equal(
    events.filter((event) => event.kind === "guard-signal").length,
    workerExit.code === 143 ? 1 : 0,
  );
  const threads = threadLifecycleEvidence(events);
  assert.equal(threads.everyThreadGuarded, true);
  assert.equal(
    events.filter(
      (event) =>
        event.kind === "wrangler-child-preload" && event.threadId === 0,
    ).length,
    1,
  );
  return {
    ...threads,
    unobservedNativeExits: nativeUnobservedExitCount(events),
  };
}
async function supplementalMaps(run: string, root: string) {
  const directory = path.join(run, "owner-builds/queue");
  const upload = boundedBuildFile(
    path.join(directory, "association.bin"),
    OWNER_BUILD_LIMITS.associationBytes,
  );
  const boundaryEnd = upload.indexOf("\r\n");
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
    if (typeof value !== "string" && value.type === "application/source-map")
      maps.push(JSON.parse(await value.text()));
  const sources: Record<string, string> = {};
  for (const logical of [
    "workers/data-api.ts",
    "src/pg-sql.ts",
    "src/lane-health-store.ts",
    "src/read-store.ts",
    "src/strict-gzip-reader.ts",
    "tests/qualification/strict-gzip/failure-lifecycle-observer.ts",
  ]) {
    const file = path.join(root, logical);
    assert.equal(realpathSync(file), file);
    sources[logical] = boundedFile(file, 1024 * 1024).toString();
  }
  assertFailureSupplementalSourceMaps(maps, sources);
}
export async function validateFailurePhaseEvidence(
  run: string,
  root: string,
  phase: FailurePhase,
) {
  validateFailureReceiptDirectory(run);
  validateServiceReceipt(
    JSON.parse(
      boundedFile(path.join(run, "owner-service.json"), 65536).toString(),
    ),
  );
  const tests = validateFailureTestEvidence(
    JSON.parse(
      boundedFile(
        path.join(run, "vitest-results.json"),
        RAW_LIMITS["vitest-results.json"],
      ).toString(),
    ),
    root,
    phase,
  );
  const events = boundedFile(
    path.join(run, "network-events.ndjson"),
    RAW_LIMITS["network-events.ndjson"],
  )
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(
    existsSync(path.join(run, "network-events.ndjson.failed")),
    false,
  );
  const guards = validateFailureGuardEvidence(events, {
    vitest: realpathSync(path.join(root, "node_modules/vitest/vitest.mjs")),
    worker: realpathSync(
      path.join(root, "node_modules/vitest/dist/workers/forks.js"),
    ),
    wranglerBin: realpathSync(
      path.join(root, "node_modules/wrangler/bin/wrangler.js"),
    ),
    wranglerCli: realpathSync(
      path.join(root, "node_modules/wrangler/wrangler-dist/cli.js"),
    ),
  });
  const runtime = runnerRuntimeIdentity(run, root);
  const build = await validateOwnerBuild(
    path.join(run, "owner-builds/queue"),
    "queue",
    root,
    runtime,
  );
  if (phase !== "uninstrumented") await supplementalMaps(run, root);
  const receipt: unknown = JSON.parse(
    boundedFile(path.join(run, "owner-queue-failure.json"), 65536).toString(),
  );
  assertFailureReceipt(receipt);
  assert.equal(receipt.phase, phase);
  const privateReceipt = JSON.parse(
    boundedFile(
      path.join(run, "owner-queue-failure-private.json"),
      FAILURE_PRIVATE_MAX_BYTES,
    ).toString(),
  );
  const observations = validateFailurePrivateEvidence(privateReceipt, receipt);
  for (const item of observations) {
    assert.equal(item.runtimeSha256, runtime);
    readOwnerNativeEvidence(run, item);
  }
  for (const item of receipt.cases) {
    assert.deepEqual(item.modules, build.modules);
    for (const owner of item.runtimes)
      assert.equal(owner.runtimeSha256, runtime);
  }
  return {
    phase,
    tests,
    guards,
    cases: receipt.cases,
    sourceAndBundleValidated: true,
    privateLifecycleRevalidated: true,
    observedOwnerExits: observations.length,
    productionMemory: "inconclusive",
    productionCpu: "inconclusive",
  };
}
