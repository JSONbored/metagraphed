import { readOwnerNativeEvidence } from "./owner-native-evidence.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Miniflare } from "miniflare";
import { createRequire } from "node:module";
// The pinned repository has no @types/ws; this is the narrow used interface,
// not a replacement implementation or dependency addition.
interface InspectorSocket {
  readyState: number;
  on(event: "error", callback: () => void): void;
  on(event: "message", callback: (bytes: unknown) => void): void;
  once(event: "open" | "error" | "close", callback: () => void): void;
  send(value: string): void;
  close(): void;
  terminate(): void;
}
const WebSocket = createRequire(import.meta.url)("ws") as {
  new (
    url: URL,
    options: { followRedirects: false; maxPayload: number },
  ): InspectorSocket;
  OPEN: number;
  CLOSED: number;
};
import {
  runnerRuntimeIdentity,
  validateOwnerBuild,
} from "./owner-build-evidence.ts";
import {
  type Owner,
  type OwnerProof,
  type OwnerObservations,
  type Phase,
  publicOwnerProof,
  OWNER_SCENARIOS,
} from "./owner-resource-policy.ts";

export const OWNER_RECEIPT_FILES = {
  raw: "owner-raw.json",
  queue: "owner-queue.json",
} as const;
const digest = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
function procMemory(pid: number) {
  const text = readFileSync(`/proc/${pid}/status`, "utf8");
  assert.ok(text.length <= 65536);
  const number = (key: string) => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB$`, "m").exec(text);
    assert.ok(match);
    return Number(match[1]) * 1024;
  };
  return { rss: number("VmRSS"), hwm: number("VmHWM") };
}
function startIdentity(pid: number) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  assert.ok(stat.length <= 65536);
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  assert.match(fields[19] ?? "", /^\d+$/);
  return fields[19]!;
}
function actualRuntime() {
  const root = process.env.DECODER_QUALIFICATION_ROOT;
  assert.ok(root && path.isAbsolute(root));
  const expected = realpathSync(
    path.join(
      root,
      "node_modules/miniflare/node_modules/@cloudflare/workerd-linux-64/bin/workerd",
    ),
  );
  const info = JSON.parse(
    readFileSync(path.resolve(expected, "../../package.json"), "utf8"),
  );
  assert.equal(info.name, "@cloudflare/workerd-linux-64");
  assert.equal(info.version, "1.20260730.1");
  const pending = [process.pid],
    seen = new Set<number>(),
    found: number[] = [];
  while (pending.length) {
    const pid = pending.shift()!;
    assert.ok(!seen.has(pid) && seen.size < 32);
    seen.add(pid);
    if (pid !== process.pid && realpathSync(`/proc/${pid}/exe`) === expected)
      found.push(pid);
    const text = readFileSync(
      `/proc/${pid}/task/${pid}/children`,
      "utf8",
    ).trim();
    assert.ok(text.length < 4096 && /^(?:\d+(?:\s+\d+)*)?$/.test(text));
    if (text) pending.push(...text.split(/\s+/).map(Number));
  }
  assert.equal(
    found.length,
    1,
    "Require exactly one attributable nested workerd runtime",
  );
  return {
    pid: found[0]!,
    start: startIdentity(found[0]!),
    executable: expected,
    sha256: digest(readFileSync(expected)),
  };
}
async function boundedText(response: Response, limit: number) {
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      assert.ok(length <= limit);
      parts.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(parts).toString("utf8");
}
async function inspectorClient(url: string, port: string) {
  const endpoint = new URL(url);
  assert.equal(endpoint.protocol, "ws:");
  assert.equal(endpoint.hostname, "127.0.0.1");
  assert.equal(endpoint.port, port);
  assert.equal(
    endpoint.username + endpoint.password + endpoint.search + endpoint.hash,
    "",
  );
  assert.ok(endpoint.pathname.length < 1024);
  const socket = new WebSocket(endpoint, {
    followRedirects: false,
    maxPayload: 65536,
  });
  let failure = false,
    id = 0;
  const pending = new Map<
    number,
    {
      resolve(value: Record<string, unknown>): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const fail = () => {
    failure = true;
    for (const wait of pending.values()) {
      clearTimeout(wait.timer);
      wait.reject(new Error("Owner inspector failed"));
    }
    pending.clear();
  };
  socket.on("error", fail);
  socket.on("message", (bytes) => {
    try {
      assert.ok(bytes instanceof Buffer && bytes.byteLength <= 65536);
      const message = JSON.parse(bytes.toString());
      if (!Number.isSafeInteger(message.id)) return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (
        message.error ||
        !message.result ||
        typeof message.result !== "object"
      ) {
        failure = true;
        waiter.reject(new Error("Owner inspector method failed"));
      } else waiter.resolve(message.result);
    } catch {
      fail();
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Owner inspector open timed out"));
    }, 3000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Owner inspector open failed"));
    });
  });
  return {
    async call(method: "Runtime.getIsolateId" | "Runtime.getHeapUsage") {
      assert.ok(
        !failure && socket.readyState === WebSocket.OPEN && pending.size === 0,
      );
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const request = ++id;
        const timer = setTimeout(() => {
          pending.delete(request);
          failure = true;
          reject(new Error("Owner inspector reply timed out"));
        }, 3000);
        pending.set(request, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: request, method }));
      });
    },
    async close() {
      assert.equal(pending.size, 0);
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          socket.terminate();
          resolve();
        }, 1000);
        socket.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.close();
      });
      assert.equal(failure, false);
    },
  };
}
export async function observeOwner(
  runtime: Miniflare,
  name: string,
  restarts: () => number,
) {
  assert.ok(Object.values(OWNER_SCENARIOS).some((row) => row.worker === name));
  const processIdentity = actualRuntime();
  const inspector = await runtime.getInspectorURL();
  assert.equal(inspector.protocol, "http:");
  assert.equal(inspector.hostname, "127.0.0.1");
  assert.equal(
    inspector.username + inspector.password + inspector.search + inspector.hash,
    "",
  );
  assert.ok(Number(inspector.port) > 0);
  const listing = JSON.parse(
    await boundedText(
      await fetch(new URL("/json/list", inspector), {
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      }),
      65536,
    ),
  );
  assert.ok(Array.isArray(listing) && listing.length <= 32);
  const targets = listing.filter((row) => row.id === `core:user:${name}`);
  assert.equal(targets.length, 1);
  assert.equal(typeof targets[0].webSocketDebuggerUrl, "string");
  const client = await inspectorClient(
    targets[0].webSocketDebuggerUrl,
    inspector.port,
  );
  const initial = await client.call("Runtime.getIsolateId");
  assert.match(String(initial.id), /^[a-f0-9]{1,64}$/i);
  let finished = false;
  const report: OwnerObservations = {
    hostPid: process.pid,
    runtimePid: processIdentity.pid,
    runtimeStartTicks: processIdentity.start,
    runtimeExecutablePath: processIdentity.executable,
    runtimeVersion: "1.20260730.1",
    runtimeSha256: processIdentity.sha256,
    owner: name,
    isolateId: String(initial.id),
    runtimeRestarts: 0,
    samples: [],
    sampleErrors: 0,
    missedSamples: 0,
    maximumGapMs: 0,
    sampling: "explicit-phase-checkpoints",
    postgresMemory: "not-observed",
  };
  return {
    async sample(phase: Phase) {
      assert.equal(finished, false);
      try {
        assert.equal(startIdentity(processIdentity.pid), processIdentity.start);
        assert.equal(
          realpathSync(`/proc/${processIdentity.pid}/exe`),
          processIdentity.executable,
        );
        assert.equal(restarts(), 0);
        const identity = await client.call("Runtime.getIsolateId");
        assert.equal(identity.id, report.isolateId);
        const heap = await client.call("Runtime.getHeapUsage");
        const integer = (value: unknown): number => {
          assert.ok(Number.isSafeInteger(value) && Number(value) >= 0);
          return Number(value);
        };
        const optional = (key: string) =>
          Object.hasOwn(heap, key) ? integer(heap[key]) : null;
        const native = procMemory(processIdentity.pid),
          host = procMemory(process.pid),
          atMs = performance.now();
        const previous = report.samples.at(-1);
        if (previous)
          report.maximumGapMs = Math.max(
            report.maximumGapMs,
            atMs - previous.atMs,
          );
        assert.ok(report.samples.length < 3);
        report.samples.push({
          atMs,
          phase,
          isolateId: report.isolateId,
          heapUsed: integer(heap.usedSize),
          heapTotal: integer(heap.totalSize),
          backingStorage: optional("backingStorageSize"),
          embedderHeap: optional("embedderHeapUsedSize"),
          nativeExternal: null,
          workerdRss: native.rss,
          workerdHwm: native.hwm,
          hostRss: host.rss,
          hostHwm: host.hwm,
          postgresRss: null,
        });
      } catch {
        report.sampleErrors++;
        throw new Error("Owner observation failed");
      }
    },
    async finish() {
      assert.equal(finished, false);
      finished = true;
      report.runtimeRestarts = restarts();
      await client.close();
      assert.equal(report.runtimeRestarts, 0);
    },
    receipt() {
      assert.equal(finished, true);
      return structuredClone(report);
    },
  };
}
export async function writeOwnerReceipt(owner: Owner, proof: OwnerProof) {
  assert.equal(proof.owner, owner);

  const result = process.env.DECODER_QUALIFICATION_RESULT;
  assert.ok(result && path.isAbsolute(result));
  const root = process.env.DECODER_QUALIFICATION_ROOT;
  assert.ok(root && path.isAbsolute(root));
  const run = path.dirname(result);
  const expected = await validateOwnerBuild(
    path.join(run, "owner-builds", owner),
    owner,
    root,
    runnerRuntimeIdentity(run, root),
  );
  readOwnerNativeEvidence(run, proof.observations);
  publicOwnerProof(proof, expected); // Independent publication validates again.
  const bytes = JSON.stringify(proof) + "\n";
  assert.ok(Buffer.byteLength(bytes) <= 65536);
  writeFileSync(
    path.join(path.dirname(result), OWNER_RECEIPT_FILES[owner]),
    bytes,
    { flag: "wx", mode: 0o600 },
  );
}
