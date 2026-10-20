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
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import workerThreads from "node:worker_threads";
import {
  authorizeSocketConnect,
  createLaunchGate,
  invokeAuthorized,
  observeChildLifecycle,
  PolicyViolation,
  refusalTargetCategory,
  sanitizeDenial,
  validateBaseEnvironment,
  type AuthorizedLaunch,
  type ChildLifecycle,
  type HostRole,
  type LaunchApi,
  type NativeExecutable,
  type PolicyContext,
} from "./launch-policy.ts";

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
const realEntry = entry ? realpathSync(entry) : "";
let eventCount = 0;
const lockWait = new Int32Array(new SharedArrayBuffer(4));
function record(kind: string, detail: Record<string, unknown> = {}): void {
  let lock: number | undefined;
  try {
    const line =
      JSON.stringify({
        kind,
        pid: process.pid,
        ppid: process.ppid,
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
const role = roles.get(realEntry);
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
  role,
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
Object.defineProperty(workerThreads, "Worker", {
  value: class RefusedWorker {
    constructor() {
      refuse("worker-thread", undefined, "worker-thread");
    }
  },
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
record("guard-start", { node: process.version, role });
process.once("exit", () => {
  try {
    record("guard-exit", {
      denied: state.denied,
      unobservedNativeExits: unobservedNativeExits.size,
    });
  } catch {
    process.exitCode = 1;
  }
  if (state.denied) process.exitCode = 1;
});
