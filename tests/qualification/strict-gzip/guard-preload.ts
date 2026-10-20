// Validation-only qualification harness. This is a Node API guard, not a firewall:
// native children, native addons, and direct system calls are outside its scope.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import dgram from "node:dgram";
import {
  appendFileSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { promisify, types } from "node:util";
import workerThreads from "node:worker_threads";
import {
  authorizeSocketConnect,
  createLaunchGate,
  installWorkerTerminationReceipt,
  invokeAuthorized,
  observeChildLifecycle,
  PolicyViolation,
  refusalTargetCategory,
  REVIEWED_WORKER_SOURCES,
  sanitizeDenial,
  validateBaseEnvironment,
  type AuthorizedLaunch,
  type ChildLifecycle,
  type HostRole,
  type LaunchApi,
  type NativeExecutable,
  type PolicyContext,
  type WorkerDiagnosticContext,
} from "./launch-policy.ts";

import {
  advanceThreadStartup,
  awaitThreadStartup,
  createThreadConstructorAdapter,
  cleanupFailedThread,
  classifyThreadTarget,
  createThreadLifecycle,
  exactThreadRecord,
  prepareThread,
  observeThreadExit,
  requireHostProcessScope,
  refuseEnvironmentData,
  threadEnvironment,
  validateThreadData,
  validateThreadMetadata,
  THREAD_ROLE,
  THREAD_SOURCE_IDENTITIES,
  SUPPRESS_WARNINGS_SHA256,
  type ThreadContext,
  type ThreadLifecycle,
  type ThreadMetadata,
} from "./thread-policy.ts";

assert.equal(process.version, "v22.23.2", "Unreviewed Node runtime");

// Capture before Vitest or fixture imports can replace process.exit.
const originalProcessExit = process.exit.bind(process);
const NativeSharedArrayBuffer = SharedArrayBuffer;
const NativeInt32Array = Int32Array;
const writerThreadId = workerThreads.threadId;
const mainThread = workerThreads.isMainThread;
const monotonicNow = performance.now.bind(performance);
const atomicLoad = Atomics.load.bind(Atomics);
const atomicExchange = Atomics.exchange.bind(Atomics);
const atomicCompareExchange = Atomics.compareExchange.bind(Atomics);
const atomicNotify = Atomics.notify.bind(Atomics);
const atomicWait = Atomics.wait.bind(Atomics);
const isProxy = types.isProxy;
const originalWorker = workerThreads.Worker;
const originalWorkerTerminate = originalWorker.prototype.terminate;
const workerThreadIdGetter = Object.getOwnPropertyDescriptor(
  originalWorker.prototype,
  "threadId",
)!.get!;
const emitterOnce = EventEmitter.prototype.once;
let threadMetadata: ThreadMetadata | undefined;
let threadFailed = false;
const preloadUrl = new URL(import.meta.url);
const configPath = preloadUrl.searchParams.get("config");
assert.ok(configPath && path.isAbsolute(configPath), "Missing guard config");
interface GuardConfig {
  version: number;
  root: string;
  home: string;
  events: string;
  wranglerBin: string;
  wranglerCli: string;
  allowedNativeExecutables: NativeExecutable[];
  baseEnv: Record<string, string>;
}
const config = JSON.parse(readFileSync(configPath, "utf8")) as GuardConfig;
assert.equal(config.version, 1);
for (const key of ["root", "home", "events"] as const)
  assert.ok(path.isAbsolute(config[key]), `Invalid guard ${key}`);
assert.equal(process.env.HOME, config.home, "Guard requires isolated HOME");

const marker = Symbol.for("decoder-qualification.host-guard");
const globals = globalThis as unknown as Record<symbol, unknown>;
assert.ok(!globals[marker], "Host guard installed twice");
const state = { denied: 0 };
globals[marker] = state;
const entry = process.argv[1] ?? "";
const realEntry = mainThread && entry ? realpathSync(entry) : "";
let eventCount = 0;
const lockWait = new NativeInt32Array(new NativeSharedArrayBuffer(4));
function record(kind: string, detail: Record<string, unknown> = {}): void {
  let lock: number | undefined;
  try {
    const line =
      JSON.stringify({
        kind,
        pid: process.pid,
        ppid: process.ppid,
        threadId: writerThreadId,
        entry,
        realEntry,
        ...detail,
      }) + "\n";
    const bytes = Buffer.byteLength(line);
    if (++eventCount > 4096 || bytes > 2048)
      throw new Error("guard-event-budget");
    for (let attempt = 0; attempt < 100 && lock === undefined; attempt += 1) {
      try {
        lock = openSync(`${config.events}.lock`, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        Atomics.wait(lockWait, 0, 0, 1);
      }
    }
    if (
      lock === undefined ||
      statSync(config.events).size + bytes > 1024 * 1024
    )
      throw new Error("guard-event-budget");
    appendFileSync(config.events, line, { encoding: "utf8", mode: 0o600 });
  } catch {
    latchThreadFailure();
    process.exitCode = 1;
    try {
      writeFileSync(`${config.events}.failed`, "1", { mode: 0o600 });
    } catch {
      /* Process failure remains mandatory. */
    }
    throw new Error(
      "Qualification guard receipt failed or exceeded its budget",
    );
  } finally {
    if (lock !== undefined) {
      closeSync(lock);
      unlinkSync(`${config.events}.lock`);
    }
  }
}
function refuse(
  operation: unknown,
  target: unknown,
  policyCode?: unknown,
): never {
  state.denied += 1;
  if (!mainThread) latchThreadFailure();
  const category = refusalTargetCategory(target);
  const diagnostic = sanitizeDenial(operation, policyCode);
  record("denied", { ...diagnostic, target: category });
  process.exitCode = 1;
  throw new Error(
    `Qualification forbids ${diagnostic.operation}: ${diagnostic.policyCode} (${category})`,
  );
}
function requireLoopback(host: unknown, operation: string): void {
  if (host !== "127.0.0.1" && host !== "::1")
    refuse(operation, host, "dns-name");
}

// The same pure decision function is regression-tested with fake connections.
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  try {
    authorizeSocketConnect(args);
  } catch (error) {
    return refuse(
      "socket-policy",
      undefined,
      error instanceof PolicyViolation
        ? error.code
        : "socket-policy-internal-error",
    );
  }
  return Reflect.apply(originalConnect, this, args) as net.Socket;
} as typeof originalConnect;
tls.connect = function () {
  return refuse("TLS", undefined, "tls-denied");
};

// Numeric loopback lookup is a local libc shortcut. Names, including
// "localhost", are refused so lookup cannot create an external DNS request.
for (const originalApi of [dns, dnsPromises]) {
  const api = originalApi as unknown as Record<string, unknown>;
  const lookup = api.lookup;
  assert.ok(typeof lookup === "function");
  api.lookup = function (hostname: unknown, ...args: unknown[]) {
    requireLoopback(hostname, "DNS lookup");
    return Reflect.apply(lookup, this, [hostname, ...args]);
  };
  for (const name of Object.keys(api)) {
    if (
      name.startsWith("resolve") ||
      ["reverse", "lookupService", "setServers"].includes(name)
    ) {
      if (typeof api[name] === "function")
        api[name] = (...args: unknown[]) =>
          refuse("DNS query", args[0], "dns-query");
    }
  }
  if (typeof api.Resolver === "function") {
    for (
      let proto: object | null = api.Resolver.prototype as object;
      proto && proto !== Object.prototype;
      proto = Object.getPrototypeOf(proto)
    ) {
      const methods = proto as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (
          (name.startsWith("resolve") ||
            ["reverse", "setServers", "setLocalAddress"].includes(name)) &&
          typeof methods[name] === "function"
        ) {
          methods[name] = (...args: unknown[]) =>
            refuse("DNS resolver", args[0], "dns-query");
        }
      }
    }
  }
}
// No fixture needs UDP, including local UDP.
dgram.createSocket = () => refuse("UDP socket", undefined, "udp-denied");
dgram.Socket.prototype.connect = () =>
  refuse("UDP connect", undefined, "udp-denied");
dgram.Socket.prototype.send = () => refuse("UDP send", undefined, "udp-denied");

const vitestRoot = realpathSync(path.join(config.root, "node_modules/vitest"));
assert.equal(
  JSON.parse(readFileSync(path.join(vitestRoot, "package.json"), "utf8"))
    .version,
  "4.1.11",
);
const vitestEntry = realpathSync(path.join(vitestRoot, "vitest.mjs"));
const vitestWorker = realpathSync(
  path.join(vitestRoot, "dist/workers/forks.js"),
);
const vitestSuppress = realpathSync(
  path.join(vitestRoot, "suppress-warnings.cjs"),
);
const roles = new Map<string, HostRole>([
  [vitestEntry, "coordinator"],
  [vitestWorker, "test-worker"],
  [config.wranglerBin, "wrangler-bin"],
  [config.wranglerCli, "wrangler-cli"],
]);
const role = mainThread ? roles.get(realEntry) : THREAD_ROLE;
assert.ok(role, "Unreviewed guarded host entrypoint");
const context: PolicyContext = {
  root: config.root,
  home: config.home,
  preload: preloadUrl.href,
  node: realpathSync(process.execPath),
  vitestEntry,
  vitestWorker,
  vitestSuppress,
  wranglerBin: config.wranglerBin,
  wranglerCli: config.wranglerCli,
  role: role === THREAD_ROLE ? "test-worker" : role,
  baseEnv: config.baseEnv,
  inheritedEnv: process.env,
  processArgs: process.argv.slice(2),
  native: config.allowedNativeExecutables,
  resolve(file) {
    try {
      return realpathSync(file);
    } catch {
      return null;
    }
  },
  digest(file) {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  },
  isEmptyFile(file) {
    try {
      return readFileSync(file).length === 0;
    } catch {
      return false;
    }
  },
};
validateBaseEnvironment(context);
assert.equal(
  createHash("sha256").update(readFileSync(vitestSuppress)).digest("hex"),
  SUPPRESS_WARNINGS_SHA256,
);
Object.defineProperty(workerThreads, "setEnvironmentData", {
  value: () =>
    refuseEnvironmentData(() =>
      refuse("worker-environment-data", undefined, "worker-environment-data"),
    ),
  writable: false,
  configurable: false,
});
let launchSequence = 0;
const launchGate = createLaunchGate(() =>
  refuse("direct-child-spawn", undefined, "direct-child-spawn"),
);
const childPrototype = childProcess.ChildProcess.prototype as unknown as {
  spawn: (...args: unknown[]) => unknown;
};
const prototypeSpawn = childPrototype.spawn;
assert.equal(typeof prototypeSpawn, "function");
childPrototype.spawn = function (...args: unknown[]) {
  launchGate.consume();
  return Reflect.apply(prototypeSpawn, this, args);
};
// This qualification explicitly uses guarded forks. A new JS isolate would
// otherwise obtain fresh unguarded builtins. Threaded esbuild sync is refused.
function reviewedWorkerFile(file: string, sha256: string): string | null {
  try {
    const canonical = realpathSync(file);
    return createHash("sha256")
      .update(readFileSync(canonical))
      .digest("hex") === sha256
      ? canonical
      : null;
  } catch {
    return null;
  }
}
const workerDiagnostics: WorkerDiagnosticContext = {
  esbuildFile: reviewedWorkerFile(
    path.join(config.root, "node_modules/esbuild/lib/main.js"),
    REVIEWED_WORKER_SOURCES.esbuildFileSha256,
  ),
  vitestThreadsFile: reviewedWorkerFile(
    path.join(vitestRoot, "dist/workers/threads.js"),
    REVIEWED_WORKER_SOURCES.vitestThreadsFileSha256,
  ),
  digest(source) {
    return createHash("sha256").update(source).digest("hex");
  },
};
// Captured native brands: no caller properties, coercion, hasInstance or
// MessagePort.hasRef (which accepts other HandleWrap subclasses) are used.
const reflectApply = Reflect.apply;
const isInt32Array = types.isInt32Array;
const isSharedArrayBuffer = types.isSharedArrayBuffer;
const typedArrayPrototype = Object.getPrototypeOf(Int32Array.prototype);
function intrinsicGetter(
  prototype: object,
  key: string,
): (this: unknown) => unknown {
  const getter = Object.getOwnPropertyDescriptor(prototype, key)?.get;
  assert.equal(typeof getter, "function", "Missing reviewed native intrinsic");
  return getter!;
}
const getTypedBuffer = intrinsicGetter(typedArrayPrototype, "buffer");
const getTypedOffset = intrinsicGetter(typedArrayPrototype, "byteOffset");
const getTypedLength = intrinsicGetter(typedArrayPrototype, "length");
const getTypedBytes = intrinsicGetter(typedArrayPrototype, "byteLength");
const getSharedBytes = intrinsicGetter(
  SharedArrayBuffer.prototype,
  "byteLength",
);
const getSharedMaxBytes = intrinsicGetter(
  SharedArrayBuffer.prototype,
  "maxByteLength",
);
const getSharedGrowable = intrinsicGetter(
  SharedArrayBuffer.prototype,
  "growable",
);
const noArguments = Object.freeze([]);
function fixedStartupBuffer(value: unknown): boolean {
  try {
    return (
      isSharedArrayBuffer(value) &&
      reflectApply(getSharedBytes, value, noArguments) === 4 &&
      reflectApply(getSharedMaxBytes, value, noArguments) === 4 &&
      reflectApply(getSharedGrowable, value, noArguments) === false
    );
  } catch {
    return false;
  }
}
function notificationHandle(value: unknown): boolean {
  try {
    return (
      isInt32Array(value) &&
      fixedStartupBuffer(reflectApply(getTypedBuffer, value, noArguments)) &&
      reflectApply(getTypedOffset, value, noArguments) === 0 &&
      reflectApply(getTypedLength, value, noArguments) === 1 &&
      reflectApply(getTypedBytes, value, noArguments) === 4 &&
      atomicLoad(value, 0) === 0
    );
  } catch {
    return false;
  }
}
const portPostMessage = Object.getOwnPropertyDescriptor(
  workerThreads.MessagePort.prototype,
  "postMessage",
)?.value as unknown;
assert.equal(
  typeof portPostMessage,
  "function",
  "Missing reviewed MessagePort intrinsic",
);
// Node's MessagePort-specific receiver check precedes transfer-list reading.
// Our own getter aborts there, before serialization/posting/transfer. This
// probes brand only, not liveness; native construction can still fail closed.
const portProbeReached = Object.freeze(Object.create(null)) as object;
const portProbeList: unknown[] = [];
Object.setPrototypeOf(portProbeList, null);
Object.defineProperty(portProbeList, "0", {
  get() {
    throw portProbeReached;
  },
  enumerable: false,
  configurable: false,
});
Object.freeze(portProbeList);
const portProbeArguments = Object.freeze([undefined, portProbeList]);
function messagePort(value: unknown): boolean {
  if (value === null || typeof value !== "object" || isProxy(value))
    return false;
  try {
    reflectApply(
      portPostMessage as (...args: unknown[]) => unknown,
      value,
      portProbeArguments,
    );
    return false;
  } catch (error) {
    return error === portProbeReached;
  }
}
function canonicalMiniflare(): string | null {
  try {
    return realpathSync(
      path.join(config.root, "node_modules/miniflare/dist/src/index.js"),
    );
  } catch {
    return null;
  }
}
const miniflareFile = canonicalMiniflare();
function verifyThreadFile(file: string): boolean {
  try {
    if (
      file !== miniflareFile ||
      realpathSync(file) !== file ||
      createHash("sha256").update(readFileSync(file)).digest("hex") !==
        THREAD_SOURCE_IDENTITIES.miniflareSha256
    )
      return false;
    const miniflarePackage = JSON.parse(
      readFileSync(path.join(path.dirname(file), "../../package.json"), "utf8"),
    );
    if (miniflarePackage.version !== "5.20260730.0-alpha") return false;
    const undici = realpathSync(
      path.join(config.root, "node_modules/undici/index.js"),
    );
    return (
      createRequire(file).resolve("undici") === undici &&
      JSON.parse(
        readFileSync(path.join(path.dirname(undici), "package.json"), "utf8"),
      ).version === "7.30.1" &&
      createHash("sha256").update(readFileSync(undici)).digest("hex") ===
        THREAD_SOURCE_IDENTITIES.undiciSha256
    );
  } catch {
    return false;
  }
}
const threadContext: ThreadContext = {
  role,
  writerThreadId,
  ownerPid: process.pid,
  miniflareFile,
  preload: preloadUrl.href,
  baseEnv: config.baseEnv,
  digest(source) {
    return createHash("sha256").update(source).digest("hex");
  },
  verifyFile: verifyThreadFile,
  isProxy,
  isPort: messagePort,
  isNotify: notificationHandle,
  isStartup: fixedStartupBuffer,
};
if (!mainThread) {
  assert.ok(
    writerThreadId > 0 && process.execArgv.length === 0,
    "Unreviewed thread entry",
  );
  const data = exactThreadRecord(
    workerThreads.workerData,
    ["notifyHandle", "port", "filename", "__qualification"],
    isProxy,
  );
  validateThreadData(threadContext, workerThreads.workerData, true);
  threadMetadata = validateThreadMetadata(threadContext, data.__qualification);
  const expected = threadEnvironment(threadContext);
  const actual = Object.fromEntries(Object.entries(process.env));
  const values = exactThreadRecord(actual, Object.keys(expected), isProxy);
  for (const key of Object.keys(expected))
    assert.equal(values[key], expected[key], "Unreviewed thread environment");
}
function threadDetail(): Record<string, unknown> {
  assert.ok(!mainThread && threadMetadata, "Missing thread bootstrap metadata");
  return {
    threadLaunchId: threadMetadata.threadLaunchId,
    ownerPid: threadMetadata.ownerPid,
    targetThreadId: writerThreadId,
  };
}
function startupOperations() {
  assert.ok(!mainThread && threadMetadata, "Missing thread bootstrap metadata");
  const view = new NativeInt32Array(
    threadMetadata.startup as SharedArrayBuffer,
  );
  return {
    load: () => atomicLoad(view, 0),
    compareExchange: (from: number, to: number) =>
      atomicCompareExchange(view, 0, from, to),
    notify: () => {
      atomicNotify(view, 0);
    },
  };
}
function latchThreadFailure(): void {
  threadFailed = true;
  if (threadMetadata) {
    const view = new NativeInt32Array(
      threadMetadata.startup as SharedArrayBuffer,
    );
    atomicExchange(view, 0, -1);
    atomicNotify(view, 0);
  }
}
export function failThreadBootstrap(): void {
  latchThreadFailure();
  try {
    record("thread-failure", {
      ...threadDetail(),
      policyCode: "thread-startup",
    });
  } finally {
    if (threadMetadata) {
      const view = new NativeInt32Array(
        threadMetadata.startup as SharedArrayBuffer,
      );
      atomicExchange(view, 0, -1);
      atomicNotify(view, 0);
    }
  }
}
export function completeThreadBootstrap(): void {
  if (mainThread || threadFailed) {
    failThreadBootstrap();
    throw new PolicyViolation("thread-startup");
  }
  try {
    advanceThreadStartup(startupOperations(), 1, 2, () =>
      record("thread-ready", threadDetail()),
    );
  } catch {
    failThreadBootstrap();
    throw new PolicyViolation("thread-startup");
  }
}
let threadSequence = 0;
const threadInstances = new WeakMap<object, ThreadLifecycle>();
const guardedWorker = createThreadConstructorAdapter(
  originalWorker as unknown as {
    new (...args: never[]): object;
    prototype: object;
  },
  {
    reject: (code) => refuse("worker-thread", undefined, code),
    launch(call, construct) {
      const [target, options] = call;
      const classification = classifyThreadTarget(
        workerDiagnostics,
        target,
        options,
        isProxy,
        (code) => refuse("worker-thread", undefined, code),
      );
      if (classification !== "worker-thread-miniflare-script")
        return refuse("worker-thread", undefined, classification);
      const threadLaunchId = `${process.pid}:thread:${++threadSequence}`;
      let identity: {
        threadLaunchId: string;
        ownerPid: number;
        targetThreadId: number | null;
      } = {
        threadLaunchId,
        ownerPid: process.pid,
        targetThreadId: null,
      };
      let lifecycle: ThreadLifecycle | undefined;
      let constructed: object | undefined;
      try {
        const prepared = prepareThread(
          threadContext,
          target,
          options,
          threadLaunchId,
          () => new NativeSharedArrayBuffer(4),
        );
        const startup = new NativeInt32Array(
          prepared.metadata.startup as SharedArrayBuffer,
        );
        const worker = construct(prepared.source, prepared.options);
        constructed = worker;
        const targetThreadId = reflectApply(
          workerThreadIdGetter,
          worker,
          [],
        ) as number;
        assert.ok(
          Number.isSafeInteger(targetThreadId) && targetThreadId > 0,
          "Missing native thread identity",
        );
        identity = { threadLaunchId, ownerPid: process.pid, targetThreadId };
        lifecycle = createThreadLifecycle(
          { threadLaunchId, ownerPid: process.pid, targetThreadId },
          record,
          () => reflectApply(originalWorkerTerminate, worker, []),
        );
        threadInstances.set(worker, lifecycle);
        const observed = lifecycle;
        reflectApply(emitterOnce, worker, ["error", () => observed.error()]);
        reflectApply(emitterOnce, worker, [
          "exit",
          (code: unknown) =>
            observeThreadExit(observed, code, () => atomicLoad(startup, 0)),
        ]);
        record("thread-launch", identity);
        awaitThreadStartup({
          now: monotonicNow,
          load: () => atomicLoad(startup, 0),
          wait: (expected, timeout) => {
            atomicWait(startup, 0, expected, timeout);
          },
        });
        if (observed.failed) throw new PolicyViolation("thread-startup");
        record("thread-handshake", identity);
        return worker;
      } catch (error) {
        const code =
          error instanceof PolicyViolation ? error.code : "thread-constructor";
        try {
          if (lifecycle) lifecycle.fail(code);
          else record("thread-failure", { ...identity, policyCode: code });
        } finally {
          try {
            cleanupFailedThread(constructed, lifecycle, (worker) =>
              reflectApply(originalWorkerTerminate, worker, []),
            );
          } finally {
            refuse("worker-thread", undefined, code);
          }
        }
      }
    },
    terminate(instance, call) {
      const lifecycle = threadInstances.get(instance);
      if (!lifecycle || call.length !== 0)
        return refuse("worker-thread", undefined, "thread-lifecycle");
      try {
        return lifecycle.terminate("requested");
      } catch {
        return refuse("worker-thread", undefined, "thread-lifecycle");
      }
    },
  },
);
Object.defineProperty(workerThreads, "Worker", {
  value: guardedWorker,
  writable: false,
  configurable: false,
});
const unobservedNativeExits = new Set<string>();
function childRecord(
  decision: AuthorizedLaunch,
  child: ChildLifecycle | undefined,
  synchronous = false,
): void {
  const launchId = `${process.pid}:${++launchSequence}`;
  const detail = {
    launchId,
    childPid: child?.pid ?? null,
    role: decision.role,
    synchronous,
  };
  record(`${decision.kind}-child`, detail);
  if (decision.amended) record("wrangler-child-preload");
  if (context.role.startsWith("wrangler") && decision.kind === "node")
    record("wrangler-node-child", detail);
  if (synchronous)
    record(`${decision.kind}-child-exit`, {
      ...detail,
      code: 0,
      signal: null,
      observation: "synchronous-return",
    });
  else {
    if (decision.kind === "native") unobservedNativeExits.add(launchId);
    observeChildLifecycle(
      child,
      (code, signal) => {
        unobservedNativeExits.delete(launchId);
        record(`${decision.kind}-child-exit`, {
          ...detail,
          code,
          signal,
          observation: "exit-event",
        });
      },
      (code, signal) => {
        record(`${decision.kind}-child-close`, {
          ...detail,
          code,
          signal,
          observation: "close-event",
        });
      },
      () =>
        refuse(
          "missing-child-lifecycle",
          decision.role,
          "missing-child-lifecycle",
        ),
    );
  }
}
function protect(
  api: LaunchApi,
  original: (...args: never[]) => unknown,
): (...args: unknown[]) => unknown {
  return function (this: unknown, ...call: unknown[]): unknown {
    requireHostProcessScope(writerThreadId, () =>
      refuse(`process-${api}`, undefined, "thread-subprocess"),
    );
    record("process-child-request", { api, role });
    return invokeAuthorized(
      context,
      api,
      call,
      (decision) => {
        const result = launchGate.run(() =>
          Reflect.apply(original, this, decision.call),
        ) as { pid?: number } | undefined;
        childRecord(
          decision,
          api.endsWith("Sync") ? undefined : result,
          api.endsWith("Sync"),
        );
        return result;
      },
      (code) => refuse(`process-${api}`, undefined, code),
    );
  };
}
for (const api of [
  "spawn",
  "spawnSync",
  "fork",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
] as const) {
  const original = childProcess[api];
  const guarded = protect(api, original as (...args: never[]) => unknown);
  const custom = Object.getOwnPropertyDescriptor(original, promisify.custom)
    ?.value as unknown;
  if (typeof custom === "function") {
    Object.defineProperty(guarded, promisify.custom, {
      value(this: unknown, ...call: unknown[]) {
        requireHostProcessScope(writerThreadId, () =>
          refuse(`process-${api}`, undefined, "thread-subprocess"),
        );
        record("process-child-request", { api, role, promisified: true });
        return invokeAuthorized(
          context,
          api,
          call,
          (decision) => {
            const result = launchGate.run(() =>
              Reflect.apply(custom, this, decision.call),
            ) as {
              child?: childProcess.ChildProcess;
            };
            childRecord(decision, result.child);
            return result;
          },
          (code) => refuse(`process-${api}`, undefined, code),
        );
      },
    });
  }
  Object.defineProperty(childProcess, api, { value: guarded });
}
// Every host context receives every process adapter; named imports stay guarded.
syncBuiltinESMExports();
process.once("exit", () => {
  try {
    record("guard-exit", {
      denied: state.denied,
      threadFailed,
      unobservedNativeExits: unobservedNativeExits.size,
    });
  } catch {
    process.exitCode = 1;
  }
  if (state.denied) process.exitCode = 1;
});
// Pinned Vitest stops ordinary fork workers with SIGTERM. Node's default
// signal termination does not emit the JS exit event. Preserve prompt
// termination while allowing the existing exit listener to record real state.
// The parent may observe exit code 143 / signal null; guard-signal retains the
// actual SIGTERM observation. No child-exit receipt is synthesized here.
installWorkerTerminationReceipt(
  role === THREAD_ROLE ? "coordinator" : role,
  (signal, listener) => process.once(signal, listener),
  (detail) => record("guard-signal", detail),
  (code) => originalProcessExit(code),
);

if (mainThread) record("guard-start", { node: process.version, role });
else {
  try {
    advanceThreadStartup(startupOperations(), 0, 1, () =>
      record("thread-guard-start", threadDetail()),
    );
  } catch {
    failThreadBootstrap();
    throw new PolicyViolation("thread-startup");
  }
}
