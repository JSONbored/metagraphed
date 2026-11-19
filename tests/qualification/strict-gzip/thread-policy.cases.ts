// Pure regression cases: run with `node --experimental-strip-types thread-policy.cases.ts`.
// All worker/port/shared-memory/atomic/lifecycle capabilities below are fakes.
// The reviewed application source and generated wrapper are inert strings only.
// This file never imports worker_threads, child_process, net, tls or dgram,
// never evaluates generated code, and never creates native threads or channels.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PolicyViolation, REVIEWED_WORKER_SOURCES } from "./launch-policy.ts";
import {
  THREAD_ROLE,
  THREAD_SOURCE_IDENTITIES,
  advanceThreadStartup,
  awaitThreadStartup,
  buildThreadWrapper,
  classifyThreadTarget,
  createThreadConstructorAdapter,
  cleanupFailedThread,
  createThreadLifecycle,
  exactThreadRecord,
  prepareThread,
  observeThreadExit,
  requireHostProcessScope,
  refuseEnvironmentData,
  threadEnvironment,
  validateThreadData,
  validateThreadEnvelope,
  validateThreadMetadata,
  type ThreadContext,
  type ThreadIdentity,
} from "./thread-policy.ts";

export const MINIFLARE_SYNC_SCRIPT =
  '\nconst { createRequire } = require("module");\nconst { workerData } = require("worker_threads");\n\n// Not using parentPort here so we can call receiveMessageOnPort() in host\nconst { notifyHandle, port, filename } = workerData;\n\n// When running Miniflare from Jest, regular \'require("undici")\' will fail here\n// with "Error: Cannot find module \'undici\'". Instead we need to create a\n// \'require\' using the \'__filename\' of the host... :(\nconst actualRequire = createRequire(filename);\nconst { Pool, fetch } = actualRequire("undici");\n\nlet dispatcherUrl;\nlet dispatcher;\n\nport.addEventListener("message", async (event) => {\n  const { id, method, url, headers, body } = event.data;\n  try {\n    if (dispatcherUrl !== url) {\n      dispatcherUrl = url;\n      dispatcher = new Pool(new URL(url).origin, {\n        connect: { rejectUnauthorized: false },\n              // Disable timeouts for local dev — long-running responses (streaming,\n      // slow uploads, long-polling) should not be killed by undici defaults.\n      headersTimeout: 0,\n      bodyTimeout: 0,\n      });\n    }\n    headers["MF-Op-Sync"] = "true";\n    // body cannot be a ReadableStream, so no need to specify duplex\n    const response = await fetch(url, { method, headers, body, dispatcher });\n    const responseBody = response.headers.get("MF-Op-Result-Type") === "ReadableStream"\n      ? response.body\n      : await response.arrayBuffer();\n    const transferList = responseBody === null ? undefined : [responseBody];\n    port.postMessage(\n      {\n        id,\n        response: {\n          status: response.status,\n          headers: Object.fromEntries(response.headers),\n          body: responseBody,\n        }\n      },\n      transferList\n    );\n  } catch (error) {\n    try {\n      port.postMessage({ id, error });\n    } catch {\n      // If error failed to serialise, post simplified version\n      port.postMessage({ id, error: new Error(String(error)) });\n    }\n  } finally {\n    Atomics.store(notifyHandle, /* index */ 0, /* value */ 1);\n    Atomics.notify(notifyHandle, /* index */ 0);\n  }\n});\n\nport.start();\n';

const SECRET = "DO_NOT_COPY_THIS_SECRET_INTO_DIAGNOSTICS";
const cases: Array<{ name: string; run(): void }> = [];
function test(name: string, run: () => void): void {
  cases.push({ name, run });
}
function denied(run: () => unknown, code: string): PolicyViolation {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof PolicyViolation,
    `Expected PolicyViolation(${code})`,
  );
  assert.equal(caught.code, code);
  assert.equal(caught.message, code);
  assert.equal(caught.message.includes(SECRET), false);
  return caught;
}
function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

// These private maps model injected brand predicates. They intentionally do
// not use native MessagePort, ArrayBuffer, SharedArrayBuffer or typed arrays.
const fakePorts = new WeakSet<object>();
const fakeProxies = new WeakSet<object>();
type SharedShape = { shared: boolean; bytes: number; growable: boolean };
type NotifyShape = {
  buffer: object;
  offset: number;
  length: number;
  int32: boolean;
};
const fakeBuffers = new WeakMap<object, SharedShape>();
const fakeViews = new WeakMap<object, NotifyShape>();
function objectLike(value: unknown): value is object {
  return (
    value !== null && (typeof value === "object" || typeof value === "function")
  );
}
function fakePort(): object {
  const port = Object.freeze({});
  fakePorts.add(port);
  return port;
}
function fakeBuffer(shape: Partial<SharedShape> = {}): object {
  const buffer = Object.freeze({});
  fakeBuffers.set(buffer, {
    shared: true,
    bytes: 4,
    growable: false,
    ...shape,
  });
  return buffer;
}
function fakeNotify(shape: Partial<NotifyShape> = {}): object {
  const view = Object.freeze({});
  fakeViews.set(view, {
    buffer: fakeBuffer(),
    offset: 0,
    length: 1,
    int32: true,
    ...shape,
  });
  return view;
}
function isFixedShared(value: unknown): boolean {
  const shape = objectLike(value) && fakeBuffers.get(value);
  return !!shape && shape.shared && shape.bytes === 4 && !shape.growable;
}
function context(changes: Partial<ThreadContext> = {}): ThreadContext {
  const preload = "file:///trusted/guard.ts?config=reviewed";
  return {
    role: "test-worker",
    writerThreadId: 0,
    ownerPid: 431,
    miniflareFile: "/installed/miniflare/dist/src/index.js",
    preload,
    baseEnv: {
      PATH: "/usr/bin",
      HOME: "/temporary/home",
      XDG_CONFIG_HOME: "/temporary/home/config",
      XDG_CACHE_HOME: "/temporary/home/cache",
      CI: "true",
      NODE_ENV: "test",
      CLOUDFLARE_CF_FETCH_ENABLED: "false",
      CLOUDFLARE_AUTH_USE_KEYRING: "false",
      WRANGLER_SEND_METRICS: "false",
      DECODER_QUALIFICATION_ROOT: "/candidate",
      DECODER_QUALIFICATION_PRELOAD: preload,
      DECODER_QUALIFICATION_RESULT: "/receipts/result.json",
    },
    digest: sha256,
    verifyFile: (file) => file === "/installed/miniflare/dist/src/index.js",
    isProxy: (value) => objectLike(value) && fakeProxies.has(value),
    isPort: (value) => objectLike(value) && fakePorts.has(value),
    isNotify: (value) => {
      const shape = objectLike(value) && fakeViews.get(value);
      return (
        !!shape &&
        shape.int32 &&
        shape.offset === 0 &&
        shape.length === 1 &&
        isFixedShared(shape.buffer)
      );
    },
    isStartup: isFixedShared,
    ...changes,
  };
}
function data(ctx = context()) {
  return {
    notifyHandle: fakeNotify(),
    port: fakePort(),
    filename: ctx.miniflareFile!,
  };
}
function envelope(ctx = context()) {
  const workerData = data(ctx);
  return { eval: true, workerData, transferList: [workerData.port] };
}
function metadata(ctx = context()) {
  return {
    role: THREAD_ROLE,
    threadLaunchId: `${ctx.ownerPid}:thread:1`,
    ownerPid: ctx.ownerPid,
    startup: fakeBuffer(),
  };
}
function nullRecord<T extends object>(value: T): T {
  return Object.assign(Object.create(null), value) as T;
}
function nonenumerable<T extends object>(value: T, key: string): T {
  Object.defineProperty(value, key, {
    ...Object.getOwnPropertyDescriptor(value, key),
    enumerable: false,
  });
  return value;
}
function accessor<T extends object>(
  value: T,
  key: string,
  onRead: () => never,
): T {
  Object.defineProperty(value, key, {
    enumerable: true,
    configurable: true,
    get: onRead,
  });
  return value;
}
function markedProxy<T extends object>(value: T, calls: string[]): T {
  const proxy = new Proxy(value, {
    getPrototypeOf() {
      calls.push("getPrototypeOf");
      throw new Error(SECRET);
    },
    ownKeys() {
      calls.push("ownKeys");
      throw new Error(SECRET);
    },
    getOwnPropertyDescriptor() {
      calls.push("getOwnPropertyDescriptor");
      throw new Error(SECRET);
    },
    get() {
      calls.push("get");
      throw new Error(SECRET);
    },
  });
  fakeProxies.add(proxy);
  return proxy;
}

test("target classification rejects marked proxy options before diagnostic reflection or coercion", () => {
  const traps: string[] = [];
  const codes: string[] = [];
  let digests = 0;
  let coercions = 0;
  const ctx = context();
  const diagnostic = {
    esbuildFile: "/installed/esbuild/lib/main.js",
    vitestThreadsFile: "/installed/vitest/dist/workers/threads.js",
    digest(source: string) {
      digests += 1;
      return sha256(source);
    },
  };
  const hostileTarget = {
    toString() {
      coercions += 1;
      throw new Error(SECRET);
    },
    valueOf() {
      coercions += 1;
      throw new Error(SECRET);
    },
    [Symbol.toPrimitive]() {
      coercions += 1;
      throw new Error(SECRET);
    },
  };
  for (const target of [MINIFLARE_SYNC_SCRIPT, SECRET, hostileTarget]) {
    const options = markedProxy({ eval: true, secret: SECRET }, traps);
    denied(
      () =>
        classifyThreadTarget(
          diagnostic,
          target,
          options,
          ctx.isProxy,
          (code) => {
            codes.push(code);
            throw new PolicyViolation(code);
          },
        ),
      "thread-options",
    );
  }
  assert.deepEqual(traps, []);
  assert.equal(digests, 0);
  assert.equal(coercions, 0);
  assert.deepEqual(codes, [
    "thread-options",
    "thread-options",
    "thread-options",
  ]);
  assert.equal(JSON.stringify(codes).includes(SECRET), false);
});
test("normal diagnostic classification recognizes exact inert source and reviewed file targets", () => {
  const ctx = context();
  const diagnostic = {
    esbuildFile: "/installed/esbuild/lib/main.js",
    vitestThreadsFile: "/installed/vitest/dist/workers/threads.js",
    digest: sha256,
  };
  const deny = (): never => {
    throw new Error(
      "normal diagnostic classification should not call proxy denial",
    );
  };
  assert.equal(
    classifyThreadTarget(
      diagnostic,
      MINIFLARE_SYNC_SCRIPT,
      { eval: true },
      ctx.isProxy,
      deny,
    ),
    "worker-thread-miniflare-script",
  );
  assert.equal(
    classifyThreadTarget(
      diagnostic,
      diagnostic.esbuildFile,
      undefined,
      ctx.isProxy,
      deny,
    ),
    "worker-thread-esbuild-file",
  );
  assert.equal(
    classifyThreadTarget(
      diagnostic,
      diagnostic.vitestThreadsFile,
      { eval: false },
      ctx.isProxy,
      deny,
    ),
    "worker-thread-vitest-file",
  );
});
test("generic diagnostic classification remains inert for unknown source and hostile values", () => {
  const ctx = context();
  let reads = 0;
  const diagnostic = {
    esbuildFile: "/installed/esbuild/lib/main.js",
    vitestThreadsFile: "/installed/vitest/dist/workers/threads.js",
    digest: sha256,
  };
  const deny = (): never => {
    throw new Error(
      "normal diagnostic classification should not call proxy denial",
    );
  };
  const hostile = {
    toString() {
      reads += 1;
      throw new Error(SECRET);
    },
    [Symbol.toPrimitive]() {
      reads += 1;
      throw new Error(SECRET);
    },
  };
  const getterOptions = accessor({ eval: true }, "eval", () => {
    reads += 1;
    throw new Error(SECRET);
  });
  for (const [target, options] of [
    ["/unknown/worker.js", undefined],
    [MINIFLARE_SYNC_SCRIPT + " ", { eval: true }],
    [MINIFLARE_SYNC_SCRIPT.replace("const", "let  "), { eval: true }],
    [MINIFLARE_SYNC_SCRIPT, getterOptions],
    [MINIFLARE_SYNC_SCRIPT, { eval: hostile }],
    [hostile, { eval: true }],
    [SECRET, null],
  ]) {
    assert.equal(
      classifyThreadTarget(diagnostic, target, options, ctx.isProxy, deny),
      "worker-thread",
    );
  }
  assert.equal(reads, 0);
});

test("pins the inert reviewed source by real SHA-256 and JavaScript length", () => {
  assert.equal(MINIFLARE_SYNC_SCRIPT.length, 2072);
  assert.equal(
    MINIFLARE_SYNC_SCRIPT.length,
    REVIEWED_WORKER_SOURCES.miniflareScriptJsLength,
  );
  assert.equal(
    sha256(MINIFLARE_SYNC_SCRIPT),
    "4d25b5d205de6b409af1c5138b4b6f8277b532f70eea92767b2b85f821e735ad",
  );
  assert.equal(
    sha256(MINIFLARE_SYNC_SCRIPT),
    REVIEWED_WORKER_SOURCES.miniflareScriptSha256,
  );
  assert.deepEqual(THREAD_SOURCE_IDENTITIES, {
    miniflareSha256:
      "0e9b02a8f3707b1b9a04a2eb7caea93e8d759c0dcffd84b12a8f1bf26a6830d5",
    undiciSha256:
      "dca95e2bbf4bae18325a4e5d9c887427a8a63a1345ed92a46f1067360dec0ffa",
    suppressSha256:
      "a5012da3d2027007781baecda154d343d8c7ad2327b79bec65b1b60a41f42dd1",
  });
  assert.ok(Object.isFrozen(THREAD_SOURCE_IDENTITIES));
});
test("accepts only the reviewed source and exact approved envelope", () => {
  const ctx = context();
  const options = envelope(ctx);
  assert.deepEqual(
    validateThreadEnvelope(ctx, MINIFLARE_SYNC_SCRIPT, options),
    options.workerData,
  );
  const nullOptions = nullRecord({
    ...options,
    workerData: nullRecord({ ...options.workerData }),
  });
  assert.deepEqual(
    validateThreadEnvelope(ctx, MINIFLARE_SYNC_SCRIPT, nullOptions),
    options.workerData,
  );
  assert.equal(
    Object.getPrototypeOf(exactThreadRecord({ a: 1 }, ["a"], ctx.isProxy)),
    null,
  );
});
for (const role of [
  "coordinator",
  "wrangler-bin",
  "wrangler-cli",
  "miniflare-sync-fetch",
  "unknown",
  "",
]) {
  test(`rejects unapproved owner role ${JSON.stringify(role)}`, () => {
    let digestCalls = 0;
    const ctx = context({
      role,
      digest() {
        digestCalls += 1;
        return "";
      },
    });
    denied(
      () => validateThreadEnvelope(ctx, MINIFLARE_SYNC_SCRIPT, envelope(ctx)),
      "thread-owner",
    );
    assert.equal(digestCalls, 0);
  });
}
for (const writerThreadId of [
  1,
  -1,
  0.5,
  NaN,
  Infinity,
  "0" as unknown as number,
]) {
  test(`rejects non-main owner thread ${String(writerThreadId)}`, () => {
    const ctx = context({ writerThreadId });
    denied(
      () => validateThreadEnvelope(ctx, MINIFLARE_SYNC_SCRIPT, envelope(ctx)),
      "thread-owner",
    );
  });
}
test("rejects stale, same-length changed, missing and boxed source without coercion", () => {
  const ctx = context();
  let coercions = 0;
  const hostile = {
    toString() {
      coercions += 1;
      throw new Error(SECRET);
    },
    [Symbol.toPrimitive]() {
      coercions += 1;
      throw new Error(SECRET);
    },
  };
  for (const source of [
    MINIFLARE_SYNC_SCRIPT + " ",
    MINIFLARE_SYNC_SCRIPT.slice(1),
    MINIFLARE_SYNC_SCRIPT.replace("const", "let  "),
    "",
    null,
    undefined,
    1,
    new String(MINIFLARE_SYNC_SCRIPT),
    hostile,
  ]) {
    denied(
      () => validateThreadEnvelope(ctx, source, envelope(ctx)),
      "thread-source",
    );
  }
  assert.equal(coercions, 0);
});
test("checks actual source digest rather than shape alone", () => {
  const ctx = context({ digest: () => "0".repeat(64) });
  denied(
    () => validateThreadEnvelope(ctx, MINIFLARE_SYNC_SCRIPT, envelope(ctx)),
    "thread-source",
  );
});
for (const key of [
  "env",
  "execArgv",
  "argv",
  "stdin",
  "stdout",
  "stderr",
  "name",
  "resourceLimits",
  "__qualification",
  "SECRET_TOKEN",
]) {
  test(`rejects caller-supplied extra option ${key}`, () => {
    const ctx = context();
    denied(
      () =>
        validateThreadEnvelope(ctx, MINIFLARE_SYNC_SCRIPT, {
          ...envelope(ctx),
          [key]: SECRET,
        }),
      "thread-options",
    );
  });
}
test("rejects missing, hidden, symbol, accessor and custom-prototype envelope fields", () => {
  const ctx = context();
  let reads = 0;
  const trap = () => {
    reads += 1;
    throw new Error(SECRET);
  };
  for (const bad of [
    null,
    undefined,
    [],
    "options",
    1,
    { workerData: data(ctx), transferList: [] },
    nonenumerable(envelope(ctx), "eval"),
    Object.assign(envelope(ctx), { [Symbol("secret")]: SECRET }),
    Object.create(envelope(ctx)),
    Object.assign(Object.create({ harmless: true }), envelope(ctx)),
    accessor(envelope(ctx), "eval", trap),
    accessor(envelope(ctx), "workerData", trap),
    accessor(envelope(ctx), "transferList", trap),
    Object.defineProperty(envelope(ctx), "hidden", { value: SECRET }),
  ])
    denied(
      () => validateThreadEnvelope(ctx, MINIFLARE_SYNC_SCRIPT, bad),
      "thread-options",
    );
  assert.equal(reads, 0);
});
test("requires primitive true for eval without coercing caller values", () => {
  const ctx = context();
  let reads = 0;
  for (const evalValue of [
    false,
    1,
    "true",
    new Boolean(true),
    {
      valueOf() {
        reads += 1;
        throw new Error(SECRET);
      },
    },
  ]) {
    denied(
      () =>
        validateThreadEnvelope(ctx, MINIFLARE_SYNC_SCRIPT, {
          ...envelope(ctx),
          eval: evalValue,
        }),
      "thread-options",
    );
  }
  assert.equal(reads, 0);
});
test("denies fake proxy brands before any envelope, data, transfer, env or metadata trap", () => {
  const calls: string[] = [];
  const ctx = context();
  const options = envelope(ctx);
  denied(
    () =>
      validateThreadEnvelope(
        ctx,
        MINIFLARE_SYNC_SCRIPT,
        markedProxy(options, calls),
      ),
    "thread-options",
  );
  denied(
    () => validateThreadData(ctx, markedProxy(data(ctx), calls)),
    "thread-options",
  );
  denied(
    () =>
      validateThreadEnvelope(ctx, MINIFLARE_SYNC_SCRIPT, {
        ...options,
        transferList: markedProxy(options.transferList, calls),
      }),
    "thread-transfer",
  );
  denied(
    () =>
      threadEnvironment(context({ baseEnv: markedProxy(ctx.baseEnv, calls) })),
    "thread-options",
  );
  denied(
    () => validateThreadMetadata(ctx, markedProxy(metadata(ctx), calls)),
    "thread-options",
  );
  assert.deepEqual(calls, []);
});

test("workerData rejects missing, extra, hidden, symbol, accessor and custom-prototype fields", () => {
  const ctx = context();
  let reads = 0;
  const trap = () => {
    reads += 1;
    throw new Error(SECRET);
  };
  for (const bad of [
    null,
    [],
    { ...data(ctx), __qualification: metadata(ctx) },
    { ...data(ctx), env: { SECRET } },
    { port: fakePort(), filename: ctx.miniflareFile },
    nonenumerable(data(ctx), "filename"),
    Object.assign(data(ctx), { [Symbol("data")]: SECRET }),
    Object.create(data(ctx)),
    Object.assign(Object.create({ inherited: 1 }), data(ctx)),
    accessor(data(ctx), "filename", trap),
    accessor(data(ctx), "port", trap),
    accessor(data(ctx), "notifyHandle", trap),
    Object.defineProperty(data(ctx), "hidden", { value: SECRET }),
  ])
    denied(() => validateThreadData(ctx, bad), "thread-options");
  assert.equal(reads, 0);
});
test("requires exact verified Miniflare filename without resolving or coercing caller data", () => {
  const ctx = context();
  let verifies = 0;
  let coercions = 0;
  const check = context({
    verifyFile() {
      verifies += 1;
      return true;
    },
  });
  for (const filename of [
    "/installed/miniflare/dist/src/../src/index.js",
    "/stale/miniflare.js",
    SECRET,
    null,
    new String(ctx.miniflareFile),
    {
      toString() {
        coercions += 1;
        throw new Error(SECRET);
      },
    },
  ]) {
    denied(
      () => validateThreadData(check, { ...data(ctx), filename }),
      "thread-identity",
    );
  }
  assert.equal(verifies, 0);
  assert.equal(coercions, 0);
  denied(
    () => validateThreadData(context({ verifyFile: () => false }), data(ctx)),
    "thread-identity",
  );
  denied(
    () => validateThreadData(context({ miniflareFile: null }), data(ctx)),
    "thread-identity",
  );
});
test("port acceptance is delegated to the injected exact brand", () => {
  const ctx = context();
  for (const port of [
    null,
    {},
    [],
    { postMessage() {}, start() {} },
    fakeBuffer(),
    fakeNotify(),
  ]) {
    denied(
      () => validateThreadData(ctx, { ...data(ctx), port }),
      "thread-port",
    );
  }
  const options = envelope(ctx);
  assert.strictEqual(
    validateThreadEnvelope(ctx, MINIFLARE_SYNC_SCRIPT, options).port,
    options.workerData.port,
  );
});
test("notify acceptance requires the injected exact fixed shared Int32 shape", () => {
  const ctx = context();
  for (const notifyHandle of [
    null,
    {},
    { length: 1, byteOffset: 0, buffer: { byteLength: 4 } },
    fakeBuffer(),
    fakeNotify({ int32: false }),
    fakeNotify({ offset: 4 }),
    fakeNotify({ length: 0 }),
    fakeNotify({ length: 2 }),
    fakeNotify({ buffer: fakeBuffer({ shared: false }) }),
    fakeNotify({ buffer: fakeBuffer({ bytes: 8 }) }),
    fakeNotify({ buffer: fakeBuffer({ growable: true }) }),
    fakeNotify({ buffer: {} }),
  ])
    denied(
      () => validateThreadData(ctx, { ...data(ctx), notifyHandle }),
      "thread-notify",
    );
});
test("augmented data permits exactly the private metadata slot and still checks brands", () => {
  const ctx = context();
  const original = data(ctx);
  assert.deepEqual(
    validateThreadData(
      ctx,
      { ...original, __qualification: metadata(ctx) },
      true,
    ),
    original,
  );
  denied(() => validateThreadData(ctx, original, true), "thread-options");
  denied(
    () =>
      validateThreadData(
        ctx,
        { ...original, __qualification: metadata(ctx), extra: SECRET },
        true,
      ),
    "thread-options",
  );
  denied(
    () =>
      validateThreadData(
        ctx,
        { ...original, port: {}, __qualification: metadata(ctx) },
        true,
      ),
    "thread-port",
  );
});
test("requires a singleton plain transfer array containing the exact data port", () => {
  const ctx = context();
  const options = envelope(ctx);
  let reads = 0;
  const hidden = nonenumerable([options.workerData.port], "0");
  const getter = accessor([options.workerData.port], "0", () => {
    reads += 1;
    throw new Error(SECRET);
  });
  const inherited = Object.setPrototypeOf(
    [options.workerData.port],
    Object.create(Array.prototype),
  );
  for (const transferList of [
    null,
    {},
    { 0: options.workerData.port, length: 1 },
    [],
    [fakePort()],
    [options.workerData.port, options.workerData.port],
    new Array(1),
    hidden,
    getter,
    inherited,
    Object.assign([options.workerData.port], { secret: SECRET }),
    Object.assign([options.workerData.port], { [Symbol("transfer")]: SECRET }),
    Object.defineProperty([options.workerData.port], "hidden", {
      value: SECRET,
    }),
  ])
    denied(
      () =>
        validateThreadEnvelope(ctx, MINIFLARE_SYNC_SCRIPT, {
          ...options,
          transferList,
        }),
      "thread-transfer",
    );
  assert.equal(reads, 0);
  assert.deepEqual(
    validateThreadEnvelope(ctx, MINIFLARE_SYNC_SCRIPT, {
      ...options,
      transferList: Object.freeze([options.workerData.port]),
    }),
    options.workerData,
  );
});

test("creates a fresh sanitized environment with exactly the approved keys", () => {
  const ctx = context();
  const env = threadEnvironment(ctx);
  assert.deepEqual(env, ctx.baseEnv);
  assert.notStrictEqual(env, ctx.baseEnv);
  env.PATH = "/changed";
  assert.equal(ctx.baseEnv.PATH, "/usr/bin");
  assert.deepEqual(
    threadEnvironment(context({ baseEnv: nullRecord(ctx.baseEnv) })),
    ctx.baseEnv,
  );
});
test("denies secret, loader, hidden, symbol, missing, accessor and inherited env fields", () => {
  const ctx = context();
  let reads = 0;
  const missing = { ...ctx.baseEnv };
  delete missing.HOME;
  for (const baseEnv of [
    { ...ctx.baseEnv, SECRET_TOKEN: SECRET },
    { ...ctx.baseEnv, NODE_OPTIONS: "--import=evil" },
    missing,
    nonenumerable({ ...ctx.baseEnv }, "PATH"),
    Object.assign({ ...ctx.baseEnv }, { [Symbol("env")]: SECRET }),
    Object.defineProperty({ ...ctx.baseEnv }, "hidden", { value: SECRET }),
    accessor({ ...ctx.baseEnv }, "HOME", () => {
      reads += 1;
      throw new Error(SECRET);
    }),
    Object.assign(Object.create({ inherited: SECRET }), ctx.baseEnv),
  ])
    denied(() => threadEnvironment(context({ baseEnv })), "thread-options");
  assert.equal(reads, 0);
});
for (const key of [
  "CI",
  "NODE_ENV",
  "CLOUDFLARE_CF_FETCH_ENABLED",
  "CLOUDFLARE_AUTH_USE_KEYRING",
  "WRANGLER_SEND_METRICS",
  "DECODER_QUALIFICATION_PRELOAD",
]) {
  test(`denies changed pinned environment ${key}`, () => {
    const ctx = context();
    denied(
      () =>
        threadEnvironment(
          context({ baseEnv: { ...ctx.baseEnv, [key]: SECRET } }),
        ),
      "thread-environment",
    );
  });
}
test("denies every non-string env value without coercion", () => {
  const ctx = context();
  let coercions = 0;
  for (const key of Object.keys(ctx.baseEnv)) {
    const bad = {
      toString() {
        coercions += 1;
        throw new Error(SECRET);
      },
    };
    denied(
      () =>
        threadEnvironment(
          context({
            baseEnv: { ...ctx.baseEnv, [key]: bad } as unknown as Record<
              string,
              string
            >,
          }),
        ),
      "thread-environment",
    );
  }
  assert.equal(coercions, 0);
});
test("requires exact owner-bound metadata and bounded nonzero launch sequence", () => {
  const ctx = context();
  const original = metadata(ctx);
  assert.deepEqual({ ...validateThreadMetadata(ctx, original) }, original);
  assert.equal(
    Object.getPrototypeOf(validateThreadMetadata(ctx, original)),
    null,
  );
  for (const threadLaunchId of [
    "431:thread:0",
    "431:thread:01",
    "431:thread:1000000",
    "432:thread:1",
    "431:thread:1\n",
    "431:thread:-1",
    "431:thread:1.0",
    SECRET,
    1,
    null,
  ]) {
    denied(
      () => validateThreadMetadata(ctx, { ...original, threadLaunchId }),
      "thread-metadata",
    );
  }
  for (const ownerPid of [432, 0, -1, 1.5, NaN, Infinity, "431"]) {
    denied(
      () => validateThreadMetadata(ctx, { ...original, ownerPid }),
      "thread-metadata",
    );
  }
  denied(
    () => validateThreadMetadata(ctx, { ...original, role: "test-worker" }),
    "thread-metadata",
  );
  for (const threadLaunchId of ["431:thread:1", "431:thread:999999"]) {
    assert.equal(
      validateThreadMetadata(ctx, { ...original, threadLaunchId })
        .threadLaunchId,
      threadLaunchId,
    );
  }
});
test("startup metadata requires the injected fixed one-word shared buffer brand", () => {
  const ctx = context();
  for (const startup of [
    null,
    {},
    { byteLength: 4 },
    fakeNotify(),
    fakeBuffer({ shared: false }),
    fakeBuffer({ bytes: 0 }),
    fakeBuffer({ bytes: 8 }),
    fakeBuffer({ growable: true }),
  ]) {
    denied(
      () => validateThreadMetadata(ctx, { ...metadata(ctx), startup }),
      "thread-startup",
    );
  }
});
test("metadata rejects extra, missing, hidden, symbol, accessor and custom prototype fields", () => {
  const ctx = context();
  let reads = 0;
  const missing = metadata(ctx) as Record<string, unknown>;
  delete missing.startup;
  for (const bad of [
    null,
    [],
    missing,
    { ...metadata(ctx), secret: SECRET },
    nonenumerable(metadata(ctx), "ownerPid"),
    Object.assign(metadata(ctx), { [Symbol("meta")]: SECRET }),
    Object.defineProperty(metadata(ctx), "hidden", { value: SECRET }),
    accessor(metadata(ctx), "ownerPid", () => {
      reads += 1;
      throw new Error(SECRET);
    }),
    accessor(metadata(ctx), "startup", () => {
      reads += 1;
      throw new Error(SECRET);
    }),
    Object.assign(Object.create({ inherited: SECRET }), metadata(ctx)),
  ])
    denied(() => validateThreadMetadata(ctx, bad), "thread-options");
  assert.equal(reads, 0);
});

test("prepare validates first, allocates once and builds a fresh canonical envelope", () => {
  const ctx = context();
  const options = envelope(ctx);
  const startup = fakeBuffer();
  let allocations = 0;
  const prepared = prepareThread(
    ctx,
    MINIFLARE_SYNC_SCRIPT,
    options,
    "431:thread:7",
    () => {
      allocations += 1;
      return startup;
    },
  );
  assert.equal(allocations, 1);
  assert.deepEqual(
    Reflect.ownKeys(prepared.options).sort(),
    ["eval", "workerData", "transferList", "execArgv", "env"].sort(),
  );
  assert.equal(prepared.options.eval, true);
  assert.deepEqual(prepared.options.execArgv, []);
  assert.deepEqual(prepared.options.env, ctx.baseEnv);
  assert.notStrictEqual(prepared.options.env, ctx.baseEnv);
  assert.notStrictEqual(prepared.options.workerData, options.workerData);
  assert.notStrictEqual(prepared.options.transferList, options.transferList);
  assert.strictEqual(prepared.options.workerData.port, options.workerData.port);
  assert.strictEqual(
    prepared.options.workerData.notifyHandle,
    options.workerData.notifyHandle,
  );
  assert.deepEqual(prepared.options.transferList, [options.workerData.port]);
  assert.deepEqual(
    { ...prepared.metadata },
    {
      role: THREAD_ROLE,
      ownerPid: 431,
      threadLaunchId: "431:thread:7",
      startup,
    },
  );
  assert.deepEqual(prepared.options.workerData.__qualification, {
    ...prepared.metadata,
  });
  assert.notStrictEqual(
    prepared.options.workerData.__qualification,
    prepared.metadata,
  );
  assert.equal(
    prepared.source,
    buildThreadWrapper(ctx.preload, MINIFLARE_SYNC_SCRIPT),
  );
  assert.deepEqual(Object.keys(options).sort(), [
    "eval",
    "transferList",
    "workerData",
  ]);
  assert.equal(Object.hasOwn(options.workerData, "__qualification"), false);
});
test("prepare denies unapproved source, env and brands before startup allocation", () => {
  let allocations = 0;
  const allocate = () => {
    allocations += 1;
    return fakeBuffer();
  };
  const ctx = context();
  denied(
    () =>
      prepareThread(ctx, "unreviewed", envelope(ctx), "431:thread:1", allocate),
    "thread-source",
  );
  denied(
    () =>
      prepareThread(
        context({ baseEnv: { ...ctx.baseEnv, SECRET } }),
        MINIFLARE_SYNC_SCRIPT,
        envelope(ctx),
        "431:thread:1",
        allocate,
      ),
    "thread-options",
  );
  const options = envelope(ctx);
  denied(
    () =>
      prepareThread(
        ctx,
        MINIFLARE_SYNC_SCRIPT,
        { ...options, workerData: { ...options.workerData, port: {} } },
        "431:thread:1",
        allocate,
      ),
    "thread-port",
  );
  assert.equal(allocations, 0);
  denied(
    () =>
      prepareThread(
        ctx,
        MINIFLARE_SYNC_SCRIPT,
        options,
        "431:thread:1",
        () => ({}),
      ),
    "thread-startup",
  );
  denied(
    () =>
      prepareThread(
        ctx,
        MINIFLARE_SYNC_SCRIPT,
        options,
        "432:thread:1",
        allocate,
      ),
    "thread-metadata",
  );
});
test("wrapper text captures capabilities and imports guard before the inert application", () => {
  const preload = 'file:///trusted/guard.ts?x="quote"\\path\nnext';
  const wrapper = buildThreadWrapper(preload, MINIFLARE_SYNC_SCRIPT);
  const guardImport = wrapper.indexOf(
    `__qGuard = await import(${JSON.stringify(preload)});`,
  );
  const app = wrapper.indexOf(MINIFLARE_SYNC_SCRIPT);
  const complete = wrapper.indexOf("__qGuard.completeThreadBootstrap();");
  assert.ok(
    guardImport > 0 &&
      app > guardImport &&
      complete > app + MINIFLARE_SYNC_SCRIPT.length - 1,
  );
  for (const capture of [
    "const __qRequire = require;",
    "const __qExit = process.exit.bind(process);",
    "const __qExchange = Atomics.exchange.bind(Atomics);",
    "const __qNotify = Atomics.notify.bind(Atomics);",
    'const __qStartup = new Int32Array(__qRequire("node:worker_threads").workerData.__qualification.startup);',
  ])
    assert.ok(
      wrapper.indexOf(capture) >= 0 && wrapper.indexOf(capture) < guardImport,
    );
  assert.ok(wrapper.includes("(async function(require) {"));
  assert.ok(wrapper.includes("})(__qRequire).catch(() => {"));
  assert.equal(wrapper.split(MINIFLARE_SYNC_SCRIPT).length, 2);
  assert.equal(wrapper.includes("eval("), false);
  assert.equal(wrapper.includes("new Function"), false);
});
test("wrapper failure text records failure, writes -1, notifies, then exits in finally", () => {
  const wrapper = buildThreadWrapper(context().preload, MINIFLARE_SYNC_SCRIPT);
  const failure = wrapper.slice(
    wrapper.indexOf("})(__qRequire).catch(() => {"),
  );
  const guardFailure = failure.indexOf(
    "if (__qGuard) __qGuard.failThreadBootstrap();",
  );
  const exchange = failure.indexOf("__qExchange(__qStartup, 0, -1);");
  const notify = failure.indexOf("__qNotify(__qStartup, 0);");
  const exit = failure.indexOf("__qExit(1);");
  assert.ok(
    guardFailure >= 0 &&
      exchange > guardFailure &&
      notify > exchange &&
      exit > notify,
  );
  assert.match(failure, /failThreadBootstrap\(\);\n  } finally {\n    try {/);
  assert.match(
    failure,
    /__qNotify\(__qStartup, 0\);\n    } finally {\n      __qExit\(1\);/,
  );
  assert.equal(failure.includes(SECRET), false);
});

function atomicFixture(initial = 0) {
  let state = initial;
  const trace: unknown[][] = [];
  return {
    get state() {
      return state;
    },
    set state(value: number) {
      state = value;
    },
    trace,
    ops: {
      load() {
        trace.push(["load", state]);
        return state;
      },
      compareExchange(expected: number, replacement: number) {
        trace.push(["compareExchange", expected, replacement]);
        const before = state;
        if (state === expected) state = replacement;
        return before;
      },
      notify() {
        trace.push(["notify"]);
      },
    },
  };
}
test("startup performs only exact 0→1→2 CAS transitions after successful receipts", () => {
  const atomics = atomicFixture();
  advanceThreadStartup(atomics.ops, 0, 1, () => {
    atomics.trace.push(["guard-receipt"]);
  });
  assert.equal(atomics.state, 1);
  advanceThreadStartup(atomics.ops, 1, 2, () => {
    atomics.trace.push(["module-receipt"]);
  });
  assert.equal(atomics.state, 2);
  assert.deepEqual(atomics.trace, [
    ["load", 0],
    ["guard-receipt"],
    ["compareExchange", 0, 1],
    ["notify"],
    ["load", 1],
    ["module-receipt"],
    ["compareExchange", 1, 2],
    ["notify"],
  ]);
});
test("startup rejects skipped, reversed and repeated transitions before receipts or CAS", () => {
  for (const [from, to] of [
    [0, 2],
    [1, 1],
    [2, 1],
    [2, 2],
    [0, 0],
    [-1, 1],
  ]) {
    const atomics = atomicFixture(from);
    denied(
      () =>
        advanceThreadStartup(atomics.ops, from as 0 | 1, to as 1 | 2, () => {
          atomics.trace.push(["receipt"]);
        }),
      "thread-transition",
    );
    assert.deepEqual(atomics.trace, []);
  }
  for (const [state, from, to] of [
    [1, 0, 1],
    [2, 1, 2],
    [-1, 0, 1],
  ]) {
    const atomics = atomicFixture(state);
    denied(
      () =>
        advanceThreadStartup(atomics.ops, from as 0 | 1, to as 1 | 2, () => {
          atomics.trace.push(["receipt"]);
        }),
      "thread-transition",
    );
    assert.deepEqual(atomics.trace, [["load", state]]);
  }
});
test("receipt failure prevents CAS and notification", () => {
  const atomics = atomicFixture();
  const failure = new Error("fake receipt failure");
  assert.throws(
    () =>
      advanceThreadStartup(atomics.ops, 0, 1, () => {
        atomics.trace.push(["receipt"]);
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.equal(atomics.state, 0);
  assert.deepEqual(atomics.trace, [["load", 0], ["receipt"]]);
});
test("lost CAS never notifies or overwrites a concurrent failure", () => {
  const atomics = atomicFixture();
  denied(
    () =>
      advanceThreadStartup(atomics.ops, 0, 1, () => {
        atomics.state = -1;
      }),
    "thread-transition",
  );
  assert.equal(atomics.state, -1);
  assert.deepEqual(atomics.trace, [
    ["load", 0],
    ["compareExchange", 0, 1],
  ]);
});
function waitFixture(states: number[], times: number[]) {
  let stateIndex = 0;
  let timeIndex = 0;
  const waits: number[][] = [];
  return {
    waits,
    get loads() {
      return stateIndex;
    },
    get clocks() {
      return timeIndex;
    },
    ops: {
      now() {
        const result = times[Math.min(timeIndex, times.length - 1)];
        timeIndex += 1;
        return result;
      },
      load() {
        const result = states[Math.min(stateIndex, states.length - 1)];
        stateIndex += 1;
        return result;
      },
      wait(expected: number, milliseconds: number) {
        waits.push([expected, milliseconds]);
      },
    },
  };
}
test("readiness requires state2 and tolerates spurious wakes with remaining 5s budget", () => {
  const fixture = waitFixture([0, 0, 1, 1, 2], [100, 100, 100, 250, 250, 5099]);
  awaitThreadStartup(fixture.ops);
  assert.deepEqual(fixture.waits, [
    [0, 5000],
    [0, 5000],
    [1, 4850],
    [1, 4850],
  ]);
  assert.equal(fixture.loads, 5);
});
test("already-complete startup returns only after checking monotonic time and state2", () => {
  const fixture = waitFixture([2], [50, 50]);
  awaitThreadStartup(fixture.ops);
  assert.equal(fixture.loads, 1);
  assert.deepEqual(fixture.waits, []);
});
test("state0 and state1 cannot satisfy readiness or extend the absolute deadline", () => {
  for (const state of [0, 1]) {
    const fixture = waitFixture([state, state], [300, 300, 5300]);
    denied(() => awaitThreadStartup(fixture.ops), "thread-startup-timeout");
    assert.deepEqual(fixture.waits, [[state, 5000]]);
    assert.equal(fixture.loads, 1);
  }
});
test("state2 at or beyond the deadline is still timeout", () => {
  for (const now of [5000, 5001, Infinity, NaN]) {
    const fixture = waitFixture([2], [0, now]);
    denied(() => awaitThreadStartup(fixture.ops), "thread-startup-timeout");
    assert.equal(fixture.loads, 0);
    assert.deepEqual(fixture.waits, []);
  }
});
test("startup rejects failed, invalid and regressing states immediately", () => {
  for (const states of [[-1], [3], [NaN], [Infinity], [0.5], [1, 0]]) {
    const fixture = waitFixture(states, [0, 0, 1]);
    denied(() => awaitThreadStartup(fixture.ops), "thread-startup");
    assert.equal(fixture.waits.length, states.length - 1);
  }
});
test("startup uses monotonic time and accepts only the exact 5000ms bound", () => {
  for (const times of [
    [0, -1],
    [0, 5, 4],
  ]) {
    const fixture = waitFixture([0, 1], times);
    denied(() => awaitThreadStartup(fixture.ops), "thread-startup-timeout");
  }
  for (const start of [NaN, Infinity, -Infinity]) {
    const fixture = waitFixture([2], [start]);
    denied(() => awaitThreadStartup(fixture.ops), "thread-startup");
    assert.equal(fixture.loads, 0);
  }
  for (const timeout of [0, 1, 4999, 5001, Infinity, NaN]) {
    const fixture = waitFixture([2], [0]);
    denied(() => awaitThreadStartup(fixture.ops, timeout), "thread-startup");
    assert.equal(fixture.loads, 0);
  }
});
test("unbounded spurious wakes are bounded even when injected clock is stuck", () => {
  const fixture = waitFixture([0], [0]);
  denied(() => awaitThreadStartup(fixture.ops), "thread-startup-timeout");
  assert.equal(fixture.loads, 10000);
  assert.equal(fixture.waits.length, 10000);
  assert.ok(
    fixture.waits.every(
      ([state, remaining]) => state === 0 && remaining === 5000,
    ),
  );
});

const identity: ThreadIdentity = {
  threadLaunchId: "431:thread:1",
  ownerPid: 431,
  targetThreadId: 7,
};
function lifecycleFixture(throwOn?: string) {
  const receipts: Array<{ kind: string; detail: Record<string, unknown> }> = [];
  let terminates = 0;
  let shouldThrow = !!throwOn;
  const receiptError = new Error("fake receipt failed");
  const lifecycle = createThreadLifecycle(
    identity,
    (kind, detail) => {
      receipts.push({ kind, detail });
      if (shouldThrow && kind === throwOn) {
        shouldThrow = false;
        throw receiptError;
      }
    },
    () => {
      terminates += 1;
      return 1;
    },
  );
  return {
    lifecycle,
    receipts,
    receiptError,
    get terminates() {
      return terminates;
    },
  };
}
for (const requested of [false, true]) {
  test(`actual exit with ready2 permits ${requested ? "requested code1" : "natural code0"} success`, () => {
    const fixture = lifecycleFixture();
    let loads = 0;
    if (requested) fixture.lifecycle.terminate("requested");
    assert.equal(fixture.lifecycle.hasExited, false);
    assert.equal(
      fixture.receipts.some((receipt) => receipt.kind === "thread-exit"),
      false,
    );
    observeThreadExit(fixture.lifecycle, requested ? 1 : 0, () => {
      loads += 1;
      return 2;
    });
    assert.equal(loads, 1);
    assert.equal(fixture.lifecycle.failed, false);
    assert.equal(fixture.lifecycle.hasExited, true);
    assert.deepEqual(fixture.receipts.at(-1), {
      kind: "thread-exit",
      detail: { ...identity, code: requested ? 1 : 0, failed: false },
    });
  });
  test(`actual ${requested ? "requested code1" : "natural code0"} exit propagates every non2 startup state`, () => {
    let coercions = 0;
    const hostile = {
      toString() {
        coercions += 1;
        throw new Error(SECRET);
      },
      [Symbol.toPrimitive]() {
        coercions += 1;
        throw new Error(SECRET);
      },
    };
    for (const state of [
      -1,
      0,
      1,
      3,
      NaN,
      Infinity,
      undefined,
      null,
      "2",
      hostile,
    ]) {
      const fixture = lifecycleFixture();
      let loads = 0;
      if (requested) fixture.lifecycle.terminate("requested");
      assert.equal(fixture.lifecycle.hasExited, false);
      observeThreadExit(fixture.lifecycle, requested ? 1 : 0, () => {
        loads += 1;
        return state as number;
      });
      assert.equal(loads, 1);
      assert.equal(fixture.lifecycle.failed, true);
      assert.equal(fixture.lifecycle.hasExited, true);
      assert.deepEqual(fixture.receipts.at(-2), {
        kind: "thread-failure",
        detail: { ...identity, policyCode: "thread-lifecycle" },
      });
      assert.deepEqual(fixture.receipts.at(-1), {
        kind: "thread-exit",
        detail: { ...identity, code: requested ? 1 : 0, failed: true },
      });
      assert.equal(JSON.stringify(fixture.receipts).includes(SECRET), false);
    }
    assert.equal(coercions, 0);
  });
  test(`actual ${requested ? "requested code1" : "natural code0"} exit converts secret startup read errors to fixed failure`, () => {
    const fixture = lifecycleFixture();
    let loads = 0;
    if (requested) fixture.lifecycle.terminate("requested");
    assert.equal(fixture.lifecycle.hasExited, false);
    observeThreadExit(fixture.lifecycle, requested ? 1 : 0, () => {
      loads += 1;
      throw new Error(SECRET);
    });
    assert.equal(loads, 1);
    assert.equal(fixture.lifecycle.failed, true);
    assert.equal(fixture.lifecycle.hasExited, true);
    assert.equal(
      fixture.receipts.at(-2)?.detail.policyCode,
      "thread-lifecycle",
    );
    assert.equal(fixture.receipts.at(-1)?.detail.failed, true);
    assert.equal(JSON.stringify(fixture.receipts).includes(SECRET), false);
  });
}
test("observed ready2 actual exit cannot clear an earlier worker failure", () => {
  const fixture = lifecycleFixture();
  fixture.lifecycle.error();
  fixture.lifecycle.terminate("requested");
  assert.equal(fixture.lifecycle.hasExited, false);
  observeThreadExit(fixture.lifecycle, 1, () => 2);
  assert.equal(fixture.lifecycle.hasExited, true);
  assert.equal(fixture.lifecycle.failed, true);
  assert.equal(fixture.receipts.at(-1)?.detail.failed, true);
});
test("actual exit is still recorded when reporting nonready startup failure throws", () => {
  const fixture = lifecycleFixture("thread-failure");
  fixture.lifecycle.terminate("requested");
  denied(
    () => observeThreadExit(fixture.lifecycle, 1, () => -1),
    "thread-receipt",
  );
  assert.equal(fixture.lifecycle.failed, true);
  assert.equal(fixture.lifecycle.hasExited, true);
  assert.deepEqual(fixture.receipts.at(-1), {
    kind: "thread-exit",
    detail: { ...identity, code: 1, failed: true },
  });
});

test("clean lifecycle requires an actual exit callback and emits exact identity", () => {
  const fixture = lifecycleFixture();
  assert.equal(fixture.lifecycle.failed, false);
  assert.equal(fixture.lifecycle.hasExited, false);
  fixture.lifecycle.exited(0);
  assert.equal(fixture.lifecycle.failed, false);
  assert.equal(fixture.lifecycle.hasExited, true);
  assert.deepEqual(fixture.receipts, [
    { kind: "thread-exit", detail: { ...identity, code: 0, failed: false } },
  ]);
});
test("terminate return value is never evidence of actual exit", () => {
  const fixture = lifecycleFixture();
  fixture.lifecycle.terminate("requested");
  assert.equal(fixture.terminates, 1);
  assert.equal(fixture.lifecycle.hasExited, false);
  assert.equal(fixture.lifecycle.failed, false);
  assert.deepEqual(
    fixture.receipts.map((receipt) => receipt.kind),
    ["thread-terminate-request"],
  );
  fixture.lifecycle.exited(1);
  assert.equal(fixture.lifecycle.hasExited, true);
  assert.equal(fixture.lifecycle.failed, false);
  assert.deepEqual(fixture.receipts.at(-1)?.detail, {
    ...identity,
    code: 1,
    failed: false,
  });
});
test("worker error remains permanently failed through later termination and exit1", () => {
  const fixture = lifecycleFixture();
  fixture.lifecycle.error();
  assert.equal(fixture.lifecycle.failed, true);
  assert.equal(fixture.lifecycle.hasExited, false);
  fixture.lifecycle.terminate("requested");
  fixture.lifecycle.exited(1);
  assert.equal(fixture.lifecycle.failed, true);
  assert.equal(fixture.lifecycle.hasExited, true);
  assert.deepEqual(
    fixture.receipts.map((receipt) => receipt.kind),
    ["thread-error", "thread-terminate-request", "thread-exit"],
  );
  assert.equal(fixture.receipts[0].detail.policyCode, "thread-worker-error");
  assert.equal(fixture.receipts.at(-1)?.detail.failed, true);
});
test("startup failure remains permanently failed through later requested termination and exit1", () => {
  const fixture = lifecycleFixture();
  fixture.lifecycle.terminate("startup-failure");
  assert.equal(fixture.lifecycle.failed, true);
  assert.equal(fixture.lifecycle.hasExited, false);
  fixture.lifecycle.terminate("requested");
  fixture.lifecycle.exited(1);
  assert.equal(fixture.lifecycle.failed, true);
  assert.equal(
    fixture.receipts.filter(
      (receipt) => receipt.kind === "thread-terminate-request",
    ).length,
    1,
  );
  assert.equal(fixture.receipts[0].detail.policyCode, "thread-startup");
  assert.equal(fixture.receipts.at(-1)?.detail.failed, true);
});
test("explicit receipt failure is permanently latched and secret failure codes are sanitized", () => {
  for (const code of ["thread-receipt", SECRET]) {
    const fixture = lifecycleFixture();
    fixture.lifecycle.fail(code);
    fixture.lifecycle.terminate("requested");
    fixture.lifecycle.exited(1);
    assert.equal(fixture.lifecycle.failed, true);
    assert.equal(
      fixture.receipts[0].detail.policyCode,
      code === SECRET ? "other" : code,
    );
    assert.equal(JSON.stringify(fixture.receipts).includes(SECRET), false);
    assert.equal(fixture.receipts.at(-1)?.detail.failed, true);
  }
});
for (const throwOn of [
  "thread-error",
  "thread-failure",
  "thread-terminate-request",
  "thread-exit",
]) {
  test(`receipt callback exception at ${throwOn} remains failed through exit1`, () => {
    const fixture = lifecycleFixture(throwOn);
    const action =
      throwOn === "thread-error"
        ? () => fixture.lifecycle.error()
        : throwOn === "thread-failure"
          ? () => fixture.lifecycle.fail("thread-receipt")
          : throwOn === "thread-exit"
            ? () => fixture.lifecycle.exited(0)
            : () => fixture.lifecycle.terminate("requested");
    denied(action, "thread-receipt");
    if (throwOn === "thread-terminate-request")
      assert.equal(fixture.terminates, 1);
    assert.equal(fixture.lifecycle.failed, true);
    fixture.lifecycle.terminate("requested");
    fixture.lifecycle.exited(1);
    assert.equal(fixture.lifecycle.failed, true);
    assert.equal(fixture.lifecycle.hasExited, true);
    assert.equal(fixture.receipts.at(-1)?.detail.failed, true);
  });
}
for (const [throwOn, reason] of [
  ["thread-failure", "startup-failure"],
  ["thread-terminate-request", "requested"],
  ["thread-terminate-request", "startup-failure"],
] as const) {
  test(`termination still cleans up when ${reason} ${throwOn} receipt throws`, () => {
    const trace: string[] = [];
    let rejectReceipt = true;
    let terminates = 0;
    const lifecycle = createThreadLifecycle(
      identity,
      (kind) => {
        trace.push(kind);
        if (rejectReceipt && kind === throwOn) {
          rejectReceipt = false;
          throw new Error(SECRET);
        }
      },
      () => {
        terminates += 1;
        trace.push("captured-terminate");
        return 1;
      },
    );
    denied(() => lifecycle.terminate(reason), "thread-receipt");
    assert.equal(terminates, 1);
    assert.equal(trace.at(-1), "captured-terminate");
    assert.equal(lifecycle.failed, true);
    assert.equal(lifecycle.hasExited, false);
    lifecycle.terminate("requested");
    lifecycle.exited(1);
    assert.equal(terminates, 2);
    assert.equal(lifecycle.failed, true);
    assert.equal(lifecycle.hasExited, true);
  });
}
test("captured native termination failure remains latched after successful cleanup and exit1", () => {
  const receipts: Array<{ kind: string; detail: Record<string, unknown> }> = [];
  let terminates = 0;
  const lifecycle = createThreadLifecycle(
    identity,
    (kind, detail) => {
      receipts.push({ kind, detail });
    },
    () => {
      terminates += 1;
      if (terminates === 1) throw new Error(SECRET);
      return 1;
    },
  );
  denied(() => lifecycle.terminate("requested"), "thread-lifecycle");
  assert.equal(terminates, 1);
  assert.equal(lifecycle.failed, true);
  assert.equal(lifecycle.hasExited, false);
  assert.equal(receipts.at(-1)?.kind, "thread-failure");
  assert.equal(receipts.at(-1)?.detail.policyCode, "thread-lifecycle");
  lifecycle.terminate("requested");
  lifecycle.exited(1);
  assert.equal(terminates, 2);
  assert.equal(lifecycle.failed, true);
  assert.equal(lifecycle.hasExited, true);
  assert.equal(receipts.at(-1)?.detail.failed, true);
  assert.equal(JSON.stringify(receipts).includes(SECRET), false);
});
test("native terminate failure followed by receipt failure is fixed-code and permanently latched", () => {
  const receipts: Array<{ kind: string; detail: Record<string, unknown> }> = [];
  let terminates = 0;
  const lifecycle = createThreadLifecycle(
    identity,
    (kind, detail) => {
      receipts.push({ kind, detail });
      if (kind === "thread-failure") throw new Error(SECRET);
    },
    () => {
      terminates += 1;
      if (terminates === 1) throw new Error(SECRET);
      return 1;
    },
  );
  denied(() => lifecycle.terminate("requested"), "thread-receipt");
  assert.equal(terminates, 1);
  assert.equal(lifecycle.failed, true);
  assert.equal(lifecycle.hasExited, false);
  assert.equal(receipts.at(-1)?.detail.policyCode, "thread-lifecycle");
  lifecycle.terminate("requested");
  lifecycle.exited(1);
  assert.equal(terminates, 2);
  assert.equal(lifecycle.failed, true);
  assert.equal(lifecycle.hasExited, true);
  assert.equal(receipts.at(-1)?.detail.failed, true);
  assert.equal(JSON.stringify(receipts).includes(SECRET), false);
});
test("unrequested exit1, invalid exits and duplicate exits fail closed", () => {
  for (const code of [
    1,
    2,
    -1,
    0.5,
    NaN,
    Infinity,
    "0",
    null,
    {
      valueOf() {
        throw new Error(SECRET);
      },
    },
  ]) {
    const fixture = lifecycleFixture();
    fixture.lifecycle.exited(code);
    assert.equal(fixture.lifecycle.failed, true);
    assert.equal(fixture.lifecycle.hasExited, true);
    assert.equal(fixture.receipts[0].kind, "thread-failure");
    assert.equal(fixture.receipts[0].detail.policyCode, "thread-lifecycle");
    assert.equal(
      fixture.receipts.at(-1)?.detail.code,
      Number.isSafeInteger(code) ? code : null,
    );
    assert.equal(JSON.stringify(fixture.receipts).includes(SECRET), false);
  }
  const fixture = lifecycleFixture();
  fixture.lifecycle.exited(0);
  fixture.lifecycle.exited(0);
  assert.equal(fixture.lifecycle.failed, true);
});
test("requested termination does not excuse arbitrary nonzero exit codes", () => {
  const fixture = lifecycleFixture();
  fixture.lifecycle.terminate("requested");
  fixture.lifecycle.exited(2);
  assert.equal(fixture.lifecycle.failed, true);
  assert.equal(fixture.receipts.at(-1)?.detail.failed, true);
});

test("failed construction that never returned has no cleanup target", () => {
  let cleanupCalls = 0;
  cleanupFailedThread(undefined, undefined, () => {
    cleanupCalls += 1;
  });
  assert.equal(cleanupCalls, 0);
});
for (const failedStep of ["thread-id-extraction", "lifecycle-setup"]) {
  test(`post-construction ${failedStep} failure uses captured untracked cleanup`, () => {
    const failure = new Error(`fake ${failedStep} failure`);
    const cleaned: object[] = [];
    let constructed: object | undefined;
    class FakeConstructedWorker {
      get threadId(): number {
        if (failedStep === "thread-id-extraction") throw failure;
        return 7;
      }
      get terminate(): never {
        throw new Error("must not read instance termination capability");
      }
    }
    assert.throws(
      () => {
        try {
          const worker = new FakeConstructedWorker();
          constructed = worker;
          assert.equal(worker.threadId, 7);
          throw failure; // Simulated lifecycle setup failure after ID extraction.
        } finally {
          cleanupFailedThread(constructed, undefined, (worker) => {
            cleaned.push(worker);
            return 1;
          });
        }
      },
      (error) => error === failure,
    );
    assert.equal(cleaned.length, 1);
    assert.strictEqual(cleaned[0], constructed);
  });
}
test("assigned lifecycle cleanup requests startup-failure termination without fabricating exit", () => {
  const fixture = lifecycleFixture();
  const worker = Object.freeze({});
  let fallbackCalls = 0;
  cleanupFailedThread(worker, fixture.lifecycle, () => {
    fallbackCalls += 1;
  });
  assert.equal(fallbackCalls, 0);
  assert.equal(fixture.terminates, 1);
  assert.equal(fixture.lifecycle.failed, true);
  assert.equal(fixture.lifecycle.hasExited, false);
  assert.deepEqual(
    [...fixture.receipts],
    [
      {
        kind: "thread-failure",
        detail: { ...identity, policyCode: "thread-startup" },
      },
      {
        kind: "thread-terminate-request",
        detail: { ...identity, reason: "startup-failure" },
      },
    ],
  );
  fixture.lifecycle.exited(1);
  assert.equal(fixture.lifecycle.failed, true);
  assert.equal(fixture.lifecycle.hasExited, true);
  assert.equal(fixture.receipts.at(-1)?.detail.failed, true);
});
test("tracked cleanup receipt failure stays failed and does not duplicate untracked termination", () => {
  const fixture = lifecycleFixture("thread-failure");
  let fallbackCalls = 0;
  denied(
    () =>
      cleanupFailedThread({}, fixture.lifecycle, () => {
        fallbackCalls += 1;
      }),
    "thread-receipt",
  );
  assert.equal(fixture.terminates, 1);
  assert.equal(fallbackCalls, 0);
  assert.equal(fixture.lifecycle.failed, true);
  assert.equal(fixture.lifecycle.hasExited, false);
  assert.equal(
    fixture.receipts.some((receipt) => receipt.kind === "thread-exit"),
    false,
  );
});

function constructorFixture() {
  const ctx = context();
  const constructed: Array<{ source: unknown; options: unknown }> = [];
  const launched: unknown[][] = [];
  const rejected: string[] = [];
  const terminated: Array<{ instance: object; call: unknown[] }> = [];
  let originalTerminates = 0;
  class FakeNativeWorker {
    static originalOnly = "private constructor capability";
    constructor(source: unknown, options: unknown) {
      constructed.push({ source, options });
    }
    terminate(...call: unknown[]): unknown {
      originalTerminates += 1;
      return { fakeResult: 1, call };
    }
  }
  const Guarded = createThreadConstructorAdapter(FakeNativeWorker, {
    reject(code): never {
      rejected.push(code);
      throw new PolicyViolation(code);
    },
    launch(call, construct) {
      launched.push(call);
      const prepared = prepareThread(
        ctx,
        call[0],
        call[1],
        `431:thread:${launched.length}`,
        fakeBuffer,
      );
      return construct(prepared.source, prepared.options);
    },
    terminate(instance, call, original) {
      terminated.push({ instance, call });
      if (call.length !== 0) throw new PolicyViolation("thread-options");
      return original();
    },
  });
  return {
    ctx,
    Guarded,
    FakeNativeWorker,
    constructed,
    launched,
    rejected,
    terminated,
    get originalTerminates() {
      return originalTerminates;
    },
  };
}
test("standalone fake constructor launches only a canonical validated wrapper", () => {
  const fixture = constructorFixture();
  const options = envelope(fixture.ctx);
  const worker = new fixture.Guarded(MINIFLARE_SYNC_SCRIPT, options);
  assert.equal(fixture.constructed.length, 1);
  assert.equal(fixture.launched.length, 1);
  assert.ok(worker instanceof fixture.Guarded);
  assert.equal(
    fixture.constructed[0].source,
    buildThreadWrapper(fixture.ctx.preload, MINIFLARE_SYNC_SCRIPT),
  );
  const actual = fixture.constructed[0].options as ReturnType<
    typeof prepareThread
  >["options"];
  assert.deepEqual(actual.execArgv, []);
  assert.deepEqual(actual.env, fixture.ctx.baseEnv);
  assert.deepEqual(
    actual.workerData.__qualification.threadLaunchId,
    "431:thread:1",
  );
  assert.notStrictEqual(actual, options);
});
test("returned constructor, prototype constructor and static prototype never expose original", () => {
  const fixture = constructorFixture();
  const Guarded = fixture.Guarded;
  const worker = new Guarded(MINIFLARE_SYNC_SCRIPT, envelope(fixture.ctx));
  assert.strictEqual(worker.constructor, Guarded);
  assert.strictEqual(Object.getPrototypeOf(worker).constructor, Guarded);
  assert.strictEqual(Guarded.prototype.constructor, Guarded);
  assert.notStrictEqual(worker.constructor, fixture.FakeNativeWorker);
  assert.strictEqual(Object.getPrototypeOf(Guarded), Function.prototype);
  assert.notStrictEqual(
    Object.getPrototypeOf(Guarded),
    fixture.FakeNativeWorker,
  );
  assert.equal(Object.hasOwn(Guarded, "originalOnly"), false);
  assert.equal(
    (Guarded as unknown as Record<string, unknown>).originalOnly,
    undefined,
  );
  assert.equal(
    Object.getOwnPropertyDescriptor(Guarded.prototype, "constructor")?.writable,
    false,
  );
  assert.equal(
    Object.getOwnPropertyDescriptor(Guarded.prototype, "constructor")
      ?.configurable,
    false,
  );
  assert.equal(
    Object.getOwnPropertyDescriptor(Guarded.prototype, "terminate")?.writable,
    false,
  );
  assert.equal(
    Object.getOwnPropertyDescriptor(Guarded.prototype, "terminate")
      ?.configurable,
    false,
  );
  assert.throws(
    () =>
      Object.defineProperty(Guarded.prototype, "constructor", {
        value: fixture.FakeNativeWorker,
      }),
    TypeError,
  );
});
test("all indirect fake constructor paths revalidate before construction", () => {
  const fixture = constructorFixture();
  const Guarded = fixture.Guarded;
  const worker = new Guarded(MINIFLARE_SYNC_SCRIPT, envelope(fixture.ctx));
  const returned = worker.constructor as unknown as typeof Guarded;
  const prototypeConstructor = Object.getPrototypeOf(worker)
    .constructor as typeof Guarded;
  const Bound = Guarded.bind(null);
  class Subclass extends Guarded {}
  function AlternateTarget() {}
  const paths: Array<(source: unknown, options: unknown) => object> = [
    (source, options) => new returned(source, options),
    (source, options) => new prototypeConstructor(source, options),
    (source, options) => new Bound(source, options),
    (source, options) => new Subclass(source, options),
    (source, options) => Reflect.construct(Guarded, [source, options]),
    (source, options) =>
      Reflect.construct(Guarded, [source, options], AlternateTarget),
  ];
  for (const construct of paths) {
    const before = fixture.constructed.length;
    denied(() => construct(SECRET, envelope(fixture.ctx)), "thread-source");
    denied(
      () =>
        construct(MINIFLARE_SYNC_SCRIPT, {
          ...envelope(fixture.ctx),
          env: { SECRET },
        }),
      "thread-options",
    );
    assert.equal(fixture.constructed.length, before);
    const instance = construct(MINIFLARE_SYNC_SCRIPT, envelope(fixture.ctx));
    assert.equal(fixture.constructed.length, before + 1);
    assert.strictEqual(instance.constructor, Guarded);
  }
  assert.equal(fixture.launched.length, 1 + paths.length * 3);
});
test("no-new and wrong-arity calls are recorded denials before launch hooks", () => {
  const fixture = constructorFixture();
  const Guarded = fixture.Guarded;
  denied(
    () =>
      Reflect.apply(Guarded, null, [
        MINIFLARE_SYNC_SCRIPT,
        envelope(fixture.ctx),
      ]),
    "thread-options",
  );
  denied(() => new Guarded(), "thread-options");
  denied(() => new Guarded(MINIFLARE_SYNC_SCRIPT), "thread-options");
  denied(
    () => new Guarded(MINIFLARE_SYNC_SCRIPT, envelope(fixture.ctx), SECRET),
    "thread-options",
  );
  assert.deepEqual(fixture.rejected, Array(4).fill("thread-options"));
  assert.equal(fixture.launched.length, 0);
  assert.equal(fixture.constructed.length, 0);
});
test("fake terminate calls are intercepted before original callback and retain receiver", () => {
  const fixture = constructorFixture();
  const worker = new fixture.Guarded(
    MINIFLARE_SYNC_SCRIPT,
    envelope(fixture.ctx),
  );
  const terminate = (worker as { terminate(...call: unknown[]): unknown })
    .terminate;
  assert.deepEqual(Reflect.apply(terminate, worker, []), {
    fakeResult: 1,
    call: [],
  });
  assert.equal(fixture.originalTerminates, 1);
  assert.strictEqual(fixture.terminated[0].instance, worker);
  denied(() => Reflect.apply(terminate, worker, [SECRET]), "thread-options");
  assert.equal(fixture.originalTerminates, 1);
});
test("constructor adapter refuses absent and accessor termination capabilities without calling getters", () => {
  let reads = 0;
  function Missing() {}
  function Accessor() {}
  Object.defineProperty(Accessor.prototype, "terminate", {
    get() {
      reads += 1;
      throw new Error(SECRET);
    },
  });
  for (const original of [Missing, Accessor]) {
    denied(
      () =>
        createThreadConstructorAdapter(
          original as unknown as {
            new (...args: never[]): object;
            prototype: object;
          },
          {
            reject(code): never {
              throw new PolicyViolation(code);
            },
            launch() {
              throw new Error("unreachable launch");
            },
            terminate() {
              throw new Error("unreachable terminate");
            },
          },
        ),
      "thread-constructor",
    );
  }
  assert.equal(reads, 0);
});

const processApiLabels = [
  "spawn",
  "spawnSync",
  "fork",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
] as const;
for (const api of processApiLabels) {
  for (const customPromisify of [false, true]) {
    const label = customPromisify ? `${api}[custom-promisify]` : api;
    test(`${label} refuses every synthetic thread writer before fake launch or argument inspection`, () => {
      let launches = 0;
      let argumentReads = 0;
      const refusals: Array<{ label: string; code: string }> = [];
      const hostile = new Proxy(
        { secret: SECRET },
        {
          get() {
            argumentReads += 1;
            throw new Error(SECRET);
          },
          getPrototypeOf() {
            argumentReads += 1;
            throw new Error(SECRET);
          },
          ownKeys() {
            argumentReads += 1;
            throw new Error(SECRET);
          },
          getOwnPropertyDescriptor() {
            argumentReads += 1;
            throw new Error(SECRET);
          },
        },
      );
      const fakeEntry = (writerThreadId: number, ...call: unknown[]) => {
        requireHostProcessScope(writerThreadId, () => {
          refusals.push({ label, code: "thread-subprocess" });
          throw new PolicyViolation("thread-subprocess");
        });
        launches += 1;
        return call;
      };
      for (const writerThreadId of [1, 7, Number.MAX_SAFE_INTEGER]) {
        denied(
          () => fakeEntry(writerThreadId, hostile, hostile, SECRET),
          "thread-subprocess",
        );
      }
      assert.equal(launches, 0);
      assert.equal(argumentReads, 0);
      assert.deepEqual(
        refusals,
        Array.from({ length: 3 }, () => ({ label, code: "thread-subprocess" })),
      );
      assert.equal(JSON.stringify(refusals).includes(SECRET), false);
    });
    test(`${label} permits writer0 to reach only the injected fake callback`, () => {
      let launches = 0;
      let refusals = 0;
      const marker = Object.freeze({ fakeCall: true });
      const fakeEntry = (writerThreadId: number, ...call: unknown[]) => {
        requireHostProcessScope(writerThreadId, () => {
          refusals += 1;
          throw new PolicyViolation("thread-subprocess");
        });
        launches += 1;
        assert.deepEqual(call, [marker]);
        return marker;
      };
      assert.strictEqual(fakeEntry(0, marker), marker);
      assert.equal(launches, 1);
      assert.equal(refusals, 0);
    });
  }
}
test("process scope rejects every nonzero or nonnumeric writer without coercion", () => {
  let coercions = 0;
  const hostile = {
    valueOf() {
      coercions += 1;
      throw new Error(SECRET);
    },
    toString() {
      coercions += 1;
      throw new Error(SECRET);
    },
  };
  for (const writer of [
    -1,
    0.5,
    NaN,
    Infinity,
    "0",
    null,
    undefined,
    new Number(0),
    hostile,
  ]) {
    let refusals = 0;
    denied(
      () =>
        requireHostProcessScope(writer as number, () => {
          refusals += 1;
          throw new PolicyViolation("thread-subprocess");
        }),
      "thread-subprocess",
    );
    assert.equal(refusals, 1);
  }
  assert.equal(coercions, 0);
});
for (const role of [
  "coordinator",
  "test-worker",
  "wrangler-bin",
  "wrangler-cli",
  THREAD_ROLE,
]) {
  test(`environment-data setter refuses ${role} without touching secret or coercion arguments`, () => {
    let argumentReads = 0;
    let nativeSets = 0;
    const receipts: Array<{
      role: string;
      writerThreadId: number;
      policyCode: string;
    }> = [];
    const hostile = new Proxy(Object.freeze({ secret: SECRET }), {
      get() {
        argumentReads += 1;
        throw new Error(SECRET);
      },
      ownKeys() {
        argumentReads += 1;
        throw new Error(SECRET);
      },
      getPrototypeOf() {
        argumentReads += 1;
        throw new Error(SECRET);
      },
      getOwnPropertyDescriptor() {
        argumentReads += 1;
        throw new Error(SECRET);
      },
    });
    const coercible = {
      toString() {
        argumentReads += 1;
        throw new Error(SECRET);
      },
      valueOf() {
        argumentReads += 1;
        throw new Error(SECRET);
      },
      [Symbol.toPrimitive]() {
        argumentReads += 1;
        throw new Error(SECRET);
      },
    };
    const fakeSetter = (..._call: unknown[]): never => {
      refuseEnvironmentData(() => {
        receipts.push({
          role,
          writerThreadId: role === THREAD_ROLE ? 7 : 0,
          policyCode: "worker-environment-data",
        });
        throw new PolicyViolation("worker-environment-data");
      });
      nativeSets += 1;
      throw new Error(
        "must never call the fake underlying environment-data setter",
      );
    };
    denied(() => fakeSetter(), "worker-environment-data");
    denied(() => fakeSetter(SECRET, hostile), "worker-environment-data");
    denied(() => fakeSetter(coercible, hostile), "worker-environment-data");
    assert.equal(nativeSets, 0);
    assert.equal(argumentReads, 0);
    assert.equal(receipts.length, 3);
    assert.equal(JSON.stringify(receipts).includes(SECRET), false);
    assert.ok(
      receipts.every(
        (receipt) =>
          receipt.role === role &&
          receipt.policyCode === "worker-environment-data",
      ),
    );
  });
}

// A synchronous in-process runner. In particular, do not switch this file to
// `node --test`: no test-worker subprocess or native Worker is needed here.
let passed = 0;
for (const entry of cases) {
  try {
    entry.run();
    passed += 1;
  } catch (error) {
    console.error(`FAIL: ${entry.name}`);
    throw error;
  }
}
console.log(
  `thread-policy pure cases: ${passed}/${cases.length} passed; no native resources created`,
);
