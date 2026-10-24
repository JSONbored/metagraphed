// Pure thread decisions, wrapper generation and injected lifecycle adapters.
// No filesystem, process, native Worker, socket or network APIs are imported.
import {
  PolicyViolation,
  REVIEWED_WORKER_SOURCES,
  workerDenialCode,
  type WorkerDiagnosticContext,
  type PolicyCode,
} from "./launch-policy.ts";

export const THREAD_ROLE = "miniflare-sync-fetch";
export const THREAD_SOURCE_IDENTITIES = Object.freeze({
  miniflareSha256:
    "0e9b02a8f3707b1b9a04a2eb7caea93e8d759c0dcffd84b12a8f1bf26a6830d5",
  undiciSha256:
    "dca95e2bbf4bae18325a4e5d9c887427a8a63a1345ed92a46f1067360dec0ffa",
  suppressSha256:
    "a5012da3d2027007781baecda154d343d8c7ad2327b79bec65b1b60a41f42dd1",
});
export const SUPPRESS_WARNINGS_SHA256 = THREAD_SOURCE_IDENTITIES.suppressSha256;
export function requireHostProcessScope(
  writerThreadId: number,
  deny: () => never,
): void {
  if (writerThreadId !== 0) deny();
}
export function refuseEnvironmentData(deny: () => never): never {
  return deny();
}
export function classifyThreadTarget(
  context: WorkerDiagnosticContext,
  target: unknown,
  options: unknown,
  isProxy: (value: unknown) => boolean,
  deny: (code: string) => never,
): PolicyCode {
  if (isProxy(options)) return deny("thread-options");
  return workerDenialCode(context, target, options);
}
const ENV_KEYS = [
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "CI",
  "NODE_ENV",
  "CLOUDFLARE_CF_FETCH_ENABLED",
  "CLOUDFLARE_AUTH_USE_KEYRING",
  "WRANGLER_SEND_METRICS",
  "DECODER_QUALIFICATION_ROOT",
  "DECODER_QUALIFICATION_PRELOAD",
  "DECODER_QUALIFICATION_RESULT",
] as const;
function need(value: unknown, code: string): asserts value {
  if (!value) throw new PolicyViolation(code);
}
export function exactThreadRecord(
  value: unknown,
  names: readonly string[],
  isProxy: (value: unknown) => boolean,
): Record<string, unknown> {
  need(
    value !== null && typeof value === "object" && !isProxy(value),
    "thread-options",
  );
  const prototype = Object.getPrototypeOf(value);
  need(prototype === Object.prototype || prototype === null, "thread-options");
  const keys = Reflect.ownKeys(value);
  need(
    keys.length === names.length &&
      keys.every((key) => typeof key === "string" && names.includes(key)),
    "thread-options",
  );
  const result: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    need(
      descriptor && "value" in descriptor && descriptor.enumerable,
      "thread-options",
    );
    result[name] = descriptor.value;
  }
  return result;
}
function exactTransferList(
  value: unknown,
  port: unknown,
  isProxy: (value: unknown) => boolean,
): void {
  need(
    !isProxy(value) &&
      Array.isArray(value) &&
      Object.getPrototypeOf(value) === Array.prototype,
    "thread-transfer",
  );
  const keys = Reflect.ownKeys(value);
  need(
    keys.length === 2 && keys.includes("length") && keys.includes("0"),
    "thread-transfer",
  );
  const length = Object.getOwnPropertyDescriptor(value, "length");
  const first = Object.getOwnPropertyDescriptor(value, "0");
  need(
    length &&
      "value" in length &&
      length.value === 1 &&
      first &&
      "value" in first &&
      first.value === port &&
      first.enumerable,
    "thread-transfer",
  );
}
export interface ThreadBrands {
  isProxy(value: unknown): boolean;
  isPort(value: unknown): boolean;
  isNotify(value: unknown): boolean;
  isStartup(value: unknown): boolean;
}
export interface ThreadContext extends ThreadBrands {
  role: string;
  writerThreadId: number;
  ownerPid: number;
  miniflareFile: string | null;
  preload: string;
  baseEnv: Record<string, string>;
  digest(source: string): string;
  verifyFile(file: string): boolean;
}
export interface ThreadData {
  notifyHandle: unknown;
  port: unknown;
  filename: string;
}
export interface ThreadMetadata {
  role: typeof THREAD_ROLE;
  threadLaunchId: string;
  ownerPid: number;
  startup: unknown;
}
export function validateThreadData(
  context: ThreadContext,
  raw: unknown,
  augmented = false,
): ThreadData {
  const data = exactThreadRecord(
    raw,
    augmented
      ? ["notifyHandle", "port", "filename", "__qualification"]
      : ["notifyHandle", "port", "filename"],
    context.isProxy,
  );
  need(
    typeof data.filename === "string" &&
      data.filename === context.miniflareFile &&
      context.verifyFile(data.filename),
    "thread-identity",
  );
  need(context.isPort(data.port), "thread-port");
  need(context.isNotify(data.notifyHandle), "thread-notify");
  return {
    notifyHandle: data.notifyHandle,
    port: data.port,
    filename: data.filename,
  };
}
export function validateThreadEnvelope(
  context: ThreadContext,
  target: unknown,
  raw: unknown,
): ThreadData {
  need(
    context.role === "test-worker" && context.writerThreadId === 0,
    "thread-owner",
  );
  need(
    typeof target === "string" &&
      target.length === REVIEWED_WORKER_SOURCES.miniflareScriptJsLength &&
      context.digest(target) === REVIEWED_WORKER_SOURCES.miniflareScriptSha256,
    "thread-source",
  );
  const options = exactThreadRecord(
    raw,
    ["eval", "workerData", "transferList"],
    context.isProxy,
  );
  need(options.eval === true, "thread-options");
  const data = validateThreadData(context, options.workerData);
  exactTransferList(options.transferList, data.port, context.isProxy);
  return data;
}
export function threadEnvironment(
  context: ThreadContext,
): Record<string, string> {
  const env = exactThreadRecord(context.baseEnv, ENV_KEYS, context.isProxy);
  for (const key of ENV_KEYS)
    need(typeof env[key] === "string", "thread-environment");
  need(
    env.DECODER_QUALIFICATION_PRELOAD === context.preload &&
      env.CI === "true" &&
      env.NODE_ENV === "test" &&
      env.CLOUDFLARE_CF_FETCH_ENABLED === "false" &&
      env.CLOUDFLARE_AUTH_USE_KEYRING === "false" &&
      env.WRANGLER_SEND_METRICS === "false",
    "thread-environment",
  );
  return { ...env } as Record<string, string>;
}
export function validateThreadMetadata(
  context: ThreadContext,
  raw: unknown,
): ThreadMetadata {
  const value = exactThreadRecord(
    raw,
    ["role", "threadLaunchId", "ownerPid", "startup"],
    context.isProxy,
  );
  need(
    value.role === THREAD_ROLE &&
      value.ownerPid === context.ownerPid &&
      Number.isSafeInteger(value.ownerPid) &&
      (value.ownerPid as number) > 0 &&
      typeof value.threadLaunchId === "string" &&
      new RegExp(`^${context.ownerPid}:thread:[1-9][0-9]{0,5}$`).test(
        value.threadLaunchId,
      ),
    "thread-metadata",
  );
  need(context.isStartup(value.startup), "thread-startup");
  return value as unknown as ThreadMetadata;
}
export interface PreparedThread {
  source: string;
  options: {
    eval: true;
    workerData: ThreadData & { __qualification: ThreadMetadata };
    transferList: unknown[];
    execArgv: string[];
    env: Record<string, string>;
  };
  metadata: ThreadMetadata;
}
export function prepareThread(
  context: ThreadContext,
  target: unknown,
  raw: unknown,
  threadLaunchId: string,
  makeStartup: () => unknown,
): PreparedThread {
  const data = validateThreadEnvelope(context, target, raw);
  const env = threadEnvironment(context);
  const metadata = validateThreadMetadata(context, {
    role: THREAD_ROLE,
    threadLaunchId,
    ownerPid: context.ownerPid,
    startup: makeStartup(),
  });
  return {
    source: buildThreadWrapper(context.preload, target as string),
    options: {
      eval: true,
      workerData: { ...data, __qualification: { ...metadata } },
      transferList: [data.port],
      execArgv: [],
      env,
    },
    metadata,
  };
}
export function buildThreadWrapper(preload: string, source: string): string {
  // Both values have already been checked against trusted context/source.
  // Capture capabilities before importing the guard or application modules.
  return `const __qRequire = require;
const __qExit = process.exit.bind(process);
const __qExchange = Atomics.exchange.bind(Atomics);
const __qNotify = Atomics.notify.bind(Atomics);
const __qStartup = new Int32Array(__qRequire("node:worker_threads").workerData.__qualification.startup);
let __qGuard;
(async function(require) {
  __qGuard = await import(${JSON.stringify(preload)});
${source}
  __qGuard.completeThreadBootstrap();
})(__qRequire).catch(() => {
  try {
    if (__qGuard) __qGuard.failThreadBootstrap();
  } finally {
    try {
      __qExchange(__qStartup, 0, -1);
      __qNotify(__qStartup, 0);
    } finally {
      __qExit(1);
    }
  }
});
`;
}
export interface StartupOperations {
  load(): number;
  compareExchange(expected: number, replacement: number): number;
  notify(): void;
}
export function advanceThreadStartup(
  operations: StartupOperations,
  from: 0 | 1,
  to: 1 | 2,
  record: () => void,
): void {
  need(
    (from === 0 && to === 1) || (from === 1 && to === 2),
    "thread-transition",
  );
  need(operations.load() === from, "thread-transition");
  record();
  need(operations.compareExchange(from, to) === from, "thread-transition");
  operations.notify();
}
export function awaitThreadStartup(
  operations: {
    now(): number;
    load(): number;
    wait(expected: number, milliseconds: number): void;
  },
  timeoutMs = 5000,
): void {
  const start = operations.now();
  need(Number.isFinite(start) && timeoutMs === 5000, "thread-startup");
  const deadline = start + timeoutMs;
  let previous = start;
  let previousState = 0;
  for (let iteration = 0; iteration < 10000; iteration += 1) {
    const now = operations.now();
    need(
      Number.isFinite(now) && now >= previous && now < deadline,
      "thread-startup-timeout",
    );
    previous = now;
    const state = operations.load();
    need(
      (state === 0 || state === 1 || state === 2) && state >= previousState,
      "thread-startup",
    );
    if (state === 2) return;
    previousState = state;
    operations.wait(state, deadline - now);
  }
  throw new PolicyViolation("thread-startup-timeout");
}
export interface ThreadIdentity {
  threadLaunchId: string;
  ownerPid: number;
  targetThreadId: number;
}
export interface ThreadLifecycle {
  fail(code: string): void;
  error(): void;
  exited(code: unknown): void;
  terminate(reason: "requested" | "startup-failure"): unknown;
  readonly failed: boolean;
  readonly hasExited: boolean;
}
export function createThreadLifecycle(
  identity: ThreadIdentity,
  record: (kind: string, detail: Record<string, unknown>) => void,
  terminate: () => unknown,
): ThreadLifecycle {
  let failed = false;
  let exited = false;
  let requested = false;
  const emit = (kind: string, detail: Record<string, unknown> = {}) => {
    try {
      record(kind, { ...identity, ...detail });
    } catch {
      failed = true;
      throw new PolicyViolation("thread-receipt");
    }
  };
  const lifecycle: ThreadLifecycle = {
    get failed() {
      return failed;
    },
    get hasExited() {
      return exited;
    },
    fail(code) {
      failed = true;
      const approved = new PolicyViolation(code).code;
      emit("thread-failure", { policyCode: approved });
    },
    error() {
      failed = true;
      emit("thread-error", { policyCode: "thread-worker-error" });
    },
    exited(code) {
      if (
        exited ||
        !Number.isSafeInteger(code) ||
        (code !== 0 && !(code === 1 && requested))
      ) {
        lifecycle.fail("thread-lifecycle");
      }
      exited = true;
      emit("thread-exit", {
        code: Number.isSafeInteger(code) ? code : null,
        failed,
      });
    },
    terminate(reason) {
      let receiptFailed = false;
      try {
        if (reason === "startup-failure") lifecycle.fail("thread-startup");
        if (!requested && !exited) {
          requested = true;
          emit("thread-terminate-request", { reason });
        }
      } catch {
        failed = true;
        receiptFailed = true;
      }
      let result: unknown;
      try {
        result = terminate();
      } catch {
        lifecycle.fail("thread-lifecycle");
        throw new PolicyViolation("thread-lifecycle");
      }
      if (receiptFailed) throw new PolicyViolation("thread-receipt");
      return result;
    },
  };
  return lifecycle;
}
export interface ConstructorAdapterHooks {
  reject(code: string): never;
  launch(
    call: unknown[],
    construct: (source: string, options: unknown) => object,
  ): object;
  terminate(
    instance: object,
    call: unknown[],
    original: () => unknown,
  ): unknown;
}
export function observeThreadExit(
  lifecycle: ThreadLifecycle,
  code: unknown,
  loadStartup: () => number,
): void {
  let ready = false;
  try {
    ready = loadStartup() === 2;
  } catch {
    /* Fixed failure below. */
  }
  try {
    if (!ready) lifecycle.fail("thread-lifecycle");
  } finally {
    // This function is called only by the actual parent Worker exit listener.
    lifecycle.exited(code);
  }
}
export function cleanupFailedThread(
  constructed: object | undefined,
  lifecycle: ThreadLifecycle | undefined,
  terminateUntracked: (worker: object) => unknown,
): void {
  if (lifecycle) lifecycle.terminate("startup-failure");
  else if (constructed) terminateUntracked(constructed);
}
export function createThreadConstructorAdapter(
  original: { new (...args: never[]): object; prototype: object },
  hooks: ConstructorAdapterHooks,
): { new (...args: unknown[]): object; prototype: object } {
  const prototype = original.prototype;
  const terminate = Object.getOwnPropertyDescriptor(prototype, "terminate")
    ?.value as unknown;
  need(typeof terminate === "function", "thread-constructor");
  function GuardedWorker(this: unknown, ...call: unknown[]): object {
    if (!new.target || call.length !== 2) return hooks.reject("thread-options");
    return hooks.launch(
      call,
      (source, options) =>
        Reflect.construct(original, [source, options]) as object,
    );
  }
  Object.defineProperty(GuardedWorker, "prototype", { value: prototype });
  Object.defineProperty(prototype, "constructor", {
    value: GuardedWorker,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(prototype, "terminate", {
    value(this: object, ...call: unknown[]) {
      return hooks.terminate(this, call, () =>
        Reflect.apply(terminate, this, call),
      );
    },
    writable: false,
    configurable: false,
  });
  return GuardedWorker as unknown as {
    new (...args: unknown[]): object;
    prototype: object;
  };
}
