import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createCipheriv, createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { Miniflare, NoOpLog } from "miniflare";
import WebSocket from "ws";

const scenario = process.argv[2];
const variant = process.argv[3];
assert.ok(
  ["http-exact", "http-chunks"].includes(
    scenario,
  ),
);
assert.ok(["blob", "owned-stream"].includes(variant));
const base = "9527e3bcc4b6354f9c9062f91d296a07d0193b9f";
const previous = "62a5a7a6dd55de5263d79028605ebdc2bbaed542";
const root = process.cwd();
const reportDirectory = path.resolve("resource-reports");
mkdirSync(reportDirectory, { recursive: true });
const sourcePaths = [
  "src/chain-detail-d1-write.ts",
  "src/chain-detail-native-payloads.ts",
  "src/chain-detail-payloads.ts",
];
const expectedSource = [
  "898047cbde0a50f3480c4f25221291c97dd91d26",
  "f6c7a59928fc39ba9c402040393d34d37a4e2744",
  variant === "blob"
    ? "b087371c052d01079255a5ad72a72ac8196986f9"
    : "e112fe81cafd4e0efc204b6a12ae78f979925cbd",
];
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const sourceReceipt: Record<string, { blob: string; sha256: string }> = {};
const schemaPaths = [
  "migrations/d1/0014_recent_chain_state.sql",
  "migrations/d1/0024_chain_detail_payload_chunks.sql",
];
let stage = "source";
for (const [index, file] of sourcePaths.entries()) {
  const baselineOverlay = file === "src/chain-detail-payloads.ts" && variant === "blob";
  const ref = baselineOverlay ? previous : base;
  const blob = execFileSync("git", ["rev-parse", `${ref}:${file}`], {
    encoding: "utf8",
  }).trim();
  assert.equal(blob, expectedSource[index]);
  const source = execFileSync("git", ["show", `${ref}:${file}`], {
    encoding: "utf8",
  });
  if (!baselineOverlay) assert.equal(source, readFileSync(file, "utf8"));
  else writeFileSync(file, source);
  sourceReceipt[file] = { blob, sha256: digest(source) };
}
const schemaReceipt = Object.fromEntries(
  schemaPaths.map((file) => [file, digest(readFileSync(file))]),
);
const workerHash = digest(readFileSync("workers/data-api.ts"));
const compatibleDate = "2026-06-06";
const result: Record<string, unknown> = {
  scenario,
  variant,
  sourceBase: base,
  baselineOverlayBase: variant === "blob" ? previous : null,
  sourceReceipt,
  workerSha256: workerHash,
  schemaReceipt,
  compatibilityDate: compatibleDate,
  formattedDriverSha256: digest(readFileSync(process.argv[1])),
  productionActions: false,
  outboundRequests: 0,
  scope:
    "Actual data-api code in isolated local workerd; synthetic D1 only. Both variants share source base 9527e3bc. The blob variant overlays only the pinned original compression module from 62a5a7a6; owned-stream uses the exact reviewed candidate. This is a paired source observation, not production or queue memory acceptance.",
};
const output = `${scenario}-${variant}.json`;
let lastCheckpoint = 0;
function checkpoint() {
  const body =
    JSON.stringify(
      {
        ...result,
        status: "incomplete",
        incompleteStage: stage,
        checkpointAt: new Date().toISOString(),
        sampledHeap,
        rss,
        runtimeRestarts,
      },
      null,
      2,
    ) + "\n";
  assert.ok(Buffer.byteLength(body) <= 65536);
  const temporary = path.join(reportDirectory, ".checkpoint.tmp");
  writeFileSync(temporary, body);
  renameSync(temporary, path.join(reportDirectory, output));
  lastCheckpoint = Date.now();
}
let mf: Miniflare | undefined;
let sockets: WebSocket[] = [];
let samplerStopped = false;
let sampledHeap = {
  samples: 0,
  maxUsedSize: 0,
  maxTotalSize: 0,
  maxEmbedderHeapUsedSize: null as number | null,
  maxBackingStorageSize: null as number | null,
  embedderSamples: 0,
  backingStorageSamples: 0,
  errors: 0,
};
let rss = {
  samples: 0,
  maxVmRSSBytes: 0,
  maxVmHWMBytes: 0,
  maxNodeVmRSSBytes: 0,
  maxNodeVmHWMBytes: 0,
};
let runtimeRestarts = 0;
const structuredLogs: Record<string, number> = {
  info: 0,
  warn: 0,
  error: 0,
  debug: 0,
  other: 0,
};
const inspectorProtocolErrors = {
  methodNotFound: 0,
  invalidParameters: 0,
  serverError: 0,
  other: 0,
};
let sampler: Promise<void> | undefined;
const started = Date.now();
const deadline = started + 240_000;
const pause = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
writeFileSync(
  path.join(reportDirectory, "driver.ts"),
  readFileSync(process.argv[1]),
);
checkpoint();

function status(pid: number) {
  const text = readFileSync(`/proc/${pid}/status`, "utf8");
  const value = (key: string) => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB$`, "m").exec(text);
    assert.ok(match, `missing ${key}`);
    return Number(match[1]) * 1024;
  };
  return { rss: value("VmRSS"), hwm: value("VmHWM") };
}
function children(pid: number): number[] {
  const names = readFileSync(
    `/proc/${pid}/task/${pid}/children`,
    "utf8",
  ).trim();
  return names ? names.split(/\s+/).map(Number) : [];
}
function workerdPid() {
  const pending = children(process.pid),
    seen = new Set<number>();
  const matches: number[] = [];
  while (pending.length) {
    const pid = pending.shift()!;
    assert.ok(!seen.has(pid) && seen.size < 32);
    seen.add(pid);
    const executable = path.basename(realpathSync(`/proc/${pid}/exe`));
    if (executable === "workerd") matches.push(pid);
    pending.push(...children(pid));
  }
  assert.equal(matches.length, 1, "one attributable workerd process");
  return matches[0];
}
async function connect(url: string, expectedPort: string) {
  const target = new URL(url);
  assert.equal(target.protocol, "ws:");
  assert.ok(["127.0.0.1", "localhost"].includes(target.hostname));
  assert.equal(target.port, expectedPort);
  assert.equal(target.username + target.password, "");
  target.hostname = "127.0.0.1";
  const ws = new WebSocket(target, {
    followRedirects: false,
    maxPayload: 65536,
  });
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("inspector_open_timeout")),
      3000,
    );
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", () => {
      clearTimeout(timer);
      reject(new Error("inspector_open_failed"));
    });
  });
  let id = 0;
  const contextIds = new Set<number>();
  const waiting = new Map<
    number,
    {
      resolve(value: any): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  ws.on("message", (raw) => {
    assert.ok(raw.length <= 65536, "bounded inspector message");
    const message = JSON.parse(raw.toString());
    if (message.method === "Runtime.executionContextCreated") {
      const contextId = message.params?.context?.id;
      assert.ok(
        Number.isSafeInteger(contextId) &&
          contextId > 0 &&
          contextId <= 0x7fffffff &&
          contextIds.size < 32,
      );
      contextIds.add(contextId);
      return;
    }
    if (message.method === "Runtime.executionContextDestroyed") {
      contextIds.delete(message.params?.executionContextId);
      return;
    }
    const request = waiting.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    waiting.delete(message.id);
    if (message.error) {
      const key =
        message.error.code === -32601
          ? "methodNotFound"
          : message.error.code === -32602
            ? "invalidParameters"
            : message.error.code === -32000
              ? "serverError"
              : "other";
      inspectorProtocolErrors[key]++;
      request.reject(new Error("inspector_method_failed"));
    } else request.resolve(message.result);
  });
  return {
    ws,
    get contextIds() {
      return [...contextIds];
    },
    call(method: string, params: Record<string, unknown> = {}) {
      assert.ok(
        ["Runtime.enable", "Runtime.evaluate", "Runtime.getHeapUsage"].includes(
          method,
        ),
      );
      const requestId = ++id;
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(requestId);
          reject(new Error("inspector_reply_timeout"));
        }, 3000);
        waiting.set(requestId, { resolve, reject, timer });
        ws.send(JSON.stringify({ id: requestId, method, params }));
      });
    },
  };
}

function payload(data: string, block = 9_000_001) {
  const observed = 1_790_090_000_000;
  const hash = "0x" + block.toString(16).padStart(64, "0");
  return {
    blocks: [
      {
        block_number: block,
        block_hash: hash,
        observed_at: observed,
        spec_version: 291,
        extrinsics: [
          {
            block_number: block,
            extrinsic_index: 0,
            extrinsic_hash: "0x" + (block + 1).toString(16).padStart(64, "0"),
            signer: null,
            call_module: "System",
            call_function: "remark",
            success: null,
            fee_tao: null,
            tip_tao: null,
            call_args: JSON.stringify([
              { name: "memo", type: "Bytes", value: data },
            ]),
            observed_at: observed,
          },
        ],
        chain_events: [
          {
            block_number: block,
            event_index: 0,
            pallet: "System",
            method: "ExtrinsicSuccess",
            args: "[]",
            phase: "ApplyExtrinsic",
            extrinsic_index: 0,
            observed_at: observed,
          },
        ],
        account_events: [
          {
            block_number: block,
            event_index: 1,
            extrinsic_index: 0,
            event_kind: "Transfer",
            hotkey: "h",
            coldkey: "c",
            netuid: null,
            uid: null,
            amount_tao: "1.000000001",
            alpha_amount: null,
            observed_at: observed,
          },
        ],
      },
    ],
  };
}

try {
  stage = "bundle";
  const entry = `import worker from ${JSON.stringify(path.join(root, "workers/data-api.ts"))};
import { restoreChainDetailPayloads } from ${JSON.stringify(path.join(root, "src/chain-detail-payloads.ts"))};
globalThis.__metagraphed_resource_target = true;
export default { ...worker, async fetch(request, env, ctx) {
 if (new URL(request.url).pathname !== '/__qualification/verify') return worker.fetch(request, env, ctx);
 const counts = {};
 for (const name of ['chain_detail_blocks','chain_detail_extrinsics','chain_detail_chain_events','chain_detail_account_events','chain_detail_payload_chunks']) counts[name] = await env.D1_STATE.prepare('SELECT COUNT(*) n FROM '+name).first('n');
 const row = await env.D1_STATE.prepare('SELECT call_args FROM chain_detail_extrinsics ORDER BY block_number,extrinsic_index LIMIT 1').first();
 const restored = (await restoreChainDetailPayloads(env, [row]))[0].call_args;
 const bytes = new TextEncoder().encode(restored);
 const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
 return Response.json({ counts, firstPayloadBytes: bytes.length, firstPayloadSha256: hash });
}};`;
  const scratch = path.resolve(".resource-qualification");
  const bundled = path.join(scratch, "bundle");
  mkdirSync(bundled, { recursive: true });
  const entryPath = path.join(scratch, "resource-harness.ts");
  const configPath = path.join(scratch, "wrangler.json");
  writeFileSync(entryPath, entry);
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "resource-ingestion",
      main: entryPath,
      compatibility_date: compatibleDate,
      compatibility_flags: ["nodejs_compat"],
    }),
  );
  const bundle = spawnSync(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "deploy",
      "--dry-run",
      "--config",
      configPath,
      "--outdir",
      bundled,
    ],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 90_000,
      maxBuffer: 256 * 1024,
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_WRITE_LOGS: "false",
        CI: "true",
        BROWSER: "false",
      },
    },
  );
  assert.equal(bundle.error, undefined, "native dry-run bundler launched");
  assert.equal(bundle.status, 0, "native dry-run bundler succeeded");
  const entryFiles = readdirSync(bundled).filter((file) =>
    file.endsWith(".js"),
  );
  assert.equal(entryFiles.length, 1, "one native bundled entry");
  const scriptPath = path.join(bundled, entryFiles[0]);
  result.bundleSha256 = digest(readFileSync(scriptPath));
  result.harnessEntrySha256 = digest(entry);
  result.bundler = {
    nativeWranglerDryRun: true,
    stdoutRetained: false,
    stderrRetained: false,
  };
  stage = "runtime-constructor";
  checkpoint();
  let outbound = 0;
  mf = new Miniflare({
    modules: true,
    name: "resource-ingestion",
    scriptPath,
    compatibilityDate: compatibleDate,
    compatibilityFlags: ["nodejs_compat"],
    inspectorPort: 0,
    log: new NoOpLog(),
    handleStructuredLogs: (event) => {
      const level = ["info", "warn", "error", "debug"].includes(event.level)
        ? event.level
        : "other";
      structuredLogs[level]++;
    },
    unsafeHandleRuntimeRestart: () => {
      runtimeRestarts++;
    },
    bindings: {
      CHAIN_DETAIL_SYNC_SECRET: "synthetic-resource-secret",
      D1_STATE_TABLES:
        "blocks_head,chain_detail_blocks,chain_detail_extrinsics,chain_detail_chain_events,chain_detail_account_events",
    },
    d1Databases: ["D1_STATE"],
    outboundService: async () => {
      outbound++;
      return new Response("blocked synthetic qualification outbound", {
        status: 503,
      });
    },
  });
  stage = "runtime-ready";
  checkpoint();
  await mf.ready;
  stage = "schema";
  checkpoint();
  const db = await mf.getD1Database("D1_STATE");
  for (const file of schemaPaths)
    for (const statement of readFileSync(file, "utf8").split(
      "-- statement-breakpoint",
    ))
      if (statement.trim()) await db.prepare(statement).run();
  stage = "warmup";
  checkpoint();
  const fetcher = await mf.getWorker();
  const warmup = await fetcher.fetch(
    "https://resource.invalid/api/v1/internal/chain-detail-sync/head",
    { headers: { "x-chain-detail-sync-token": "synthetic-resource-secret" } },
  );
  assert.equal(warmup.status, 200);
  assert.deepEqual(await warmup.json(), { head: null });
  stage = "runtime-identity";
  checkpoint();
  const pid = workerdPid();
  const packageVersion = (file: string, name: string) => {
    const info = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(info.name, name);
    assert.match(info.version, /^[0-9][0-9A-Za-z.+-]{0,63}$/);
    return info.version;
  };
  result.runtimeVersions = {
    node: process.versions.node,
    miniflare: packageVersion(
      path.resolve("node_modules/miniflare/package.json"),
      "miniflare",
    ),
    wrangler: packageVersion(
      path.resolve("node_modules/wrangler/package.json"),
      "wrangler",
    ),
    workerd: packageVersion(
      path.resolve(
        path.dirname(realpathSync(`/proc/${pid}/exe`)),
        "..",
        "package.json",
      ),
      "@cloudflare/workerd-linux-64",
    ),
  };
  stage = "inspector-discovery";
  checkpoint();
  const inspector = await mf.getInspectorURL();
  assert.equal(inspector.hostname, "127.0.0.1");
  const listing = await fetch(`http://127.0.0.1:${inspector.port}/json/list`, {
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(listing.status, 200);
  const listingText = await listing.text();
  assert.ok(Buffer.byteLength(listingText) <= 65536);
  const targets = JSON.parse(listingText);
  assert.ok(Array.isArray(targets) && targets.length <= 32);
  const ownedTargets = targets.filter(
    (target) => target.id === "core:user:resource-ingestion",
  );
  const inspectorDiscovery = {
    targets: targets.length,
    exactOwnedIdMatches: ownedTargets.length,
    inspected: 0,
    markerMatches: 0,
    executionContexts: 0,
    unavailableContexts: 0,
  };
  result.inspectorDiscovery = inspectorDiscovery;
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  for (const target of ownedTargets.length === 1 ? ownedTargets : targets) {
    if (typeof target.webSocketDebuggerUrl !== "string") continue;
    stage = "inspector-connect";
    const candidate = await connect(
      target.webSocketDebuggerUrl,
      inspector.port,
    );
    stage = "inspector-marker";
    let markerMatches = 0;
    try {
      await candidate.call("Runtime.enable");
      await pause(0);
      const contexts = candidate.contextIds;
      inspectorDiscovery.executionContexts += contexts.length;
      for (const contextId of contexts) {
        try {
          const evaluation = await candidate.call("Runtime.evaluate", {
            expression: "globalThis.__metagraphed_resource_target === true",
            contextId,
            returnByValue: true,
          });
          inspectorDiscovery.inspected++;
          if (evaluation.result?.value === true) markerMatches++;
        } catch {
          inspectorDiscovery.unavailableContexts++;
        }
      }
    } catch {
      inspectorDiscovery.unavailableContexts++;
      candidate.ws.close();
      continue;
    }
    assert.ok(markerMatches <= 1);
    if (markerMatches === 1) {
      inspectorDiscovery.markerMatches++;
      assert.equal(client, undefined);
      client = candidate;
    } else candidate.ws.close();
  }
  stage = "inspector-target";
  assert.ok(client, "marked user isolate inspector selected");
  stage = "inspector-heap";
  const sample = async () => {
    const heap = await client!.call("Runtime.getHeapUsage");
    for (const key of ["usedSize", "totalSize"])
      assert.ok(Number.isFinite(heap[key]) && heap[key] >= 0);
    sampledHeap.samples++;
    sampledHeap.maxUsedSize = Math.max(sampledHeap.maxUsedSize, heap.usedSize);
    sampledHeap.maxTotalSize = Math.max(
      sampledHeap.maxTotalSize,
      heap.totalSize,
    );
    if (
      Number.isFinite(heap.embedderHeapUsedSize) &&
      heap.embedderHeapUsedSize >= 0
    ) {
      sampledHeap.embedderSamples++;
      sampledHeap.maxEmbedderHeapUsedSize = Math.max(
        sampledHeap.maxEmbedderHeapUsedSize ?? 0,
        heap.embedderHeapUsedSize,
      );
    }
    if (
      Number.isFinite(heap.backingStorageSize) &&
      heap.backingStorageSize >= 0
    ) {
      sampledHeap.backingStorageSamples++;
      sampledHeap.maxBackingStorageSize = Math.max(
        sampledHeap.maxBackingStorageSize ?? 0,
        heap.backingStorageSize,
      );
    }
    const runtimeStatus = status(pid),
      nodeStatus = status(process.pid);
    rss.samples++;
    rss.maxVmRSSBytes = Math.max(rss.maxVmRSSBytes, runtimeStatus.rss);
    rss.maxVmHWMBytes = Math.max(rss.maxVmHWMBytes, runtimeStatus.hwm);
    rss.maxNodeVmRSSBytes = Math.max(rss.maxNodeVmRSSBytes, nodeStatus.rss);
    rss.maxNodeVmHWMBytes = Math.max(rss.maxNodeVmHWMBytes, nodeStatus.hwm);
    if (Date.now() - lastCheckpoint >= 1000) checkpoint();
  };
  await sample();
  const initialHeap = { ...sampledHeap },
    initialRss = { ...rss };
  stage = "fixture";
  checkpoint();
  let expectedPayload: string;
  let operation: () => Promise<void>;
  let expectedBlocks = 1,
    expectedRows = 1;
  if (scenario.startsWith("http")) {
    const target = 16_000_000;
    const empty = JSON.stringify(payload(""));
    const length = target - Buffer.byteLength(empty);
    const data =
      scenario === "http-exact"
        ? "x".repeat(length)
        : createCipheriv(
            "aes-256-ctr",
            Buffer.alloc(32, 7),
            Buffer.alloc(16, 9),
          )
            .update(Buffer.alloc(Math.ceil((length * 3) / 4)))
            .toString("base64")
            .slice(0, length);
    const input = payload(data);
    expectedPayload = input.blocks[0].extrinsics[0].call_args;
    const body = JSON.stringify(input);
    assert.equal(Buffer.byteLength(body), target);
    result.fixture = {
      bodyBytes: target,
      sha256: digest(body),
      allFourFamilies: true,
      highEntropy: scenario === "http-chunks",
    };
    operation = async () => {
      const response = await fetcher.fetch(
        "https://resource.invalid/api/v1/internal/chain-detail-sync",
        {
          method: "POST",
          headers: {
            "x-chain-detail-sync-token": "synthetic-resource-secret",
            "content-type": "application/json",
          },
          body,
        },
      );
      result.httpStatus = response.status;
      const outcome = await response.json();
      assert.equal(
        response.status,
        200,
        "maximum admitted HTTP payload durable write",
      );
      assert.equal(outcome.ok, true);
      assert.deepEqual(outcome.stores, ["d1"]);
    };
  } else {
    const { parseChainDetailSync } = await import(
      path.join(root, "src/chain-detail-sync-payload.ts")
    );
    const { validSyncBatchMessage } = await import(
      path.join(root, "src/sync-batch-queue.ts")
    );
    const { SYNC_BATCH_MAX_DECODED_BYTES } = await import(
      path.join(root, "src/sync-batch-limits.ts")
    );
    const { decompressSyncBatchMessage } = await import(
      path.join(root, "src/sync-batch-compress.ts")
    );
    const large = '"' + "x".repeat(16 * 1024 * 1024 - 2) + '"';
    expectedPayload = large;
    expectedBlocks = scenario === "queue-two-ten" ? 20 : 10;
    expectedRows = expectedBlocks * 2;
    const messages = [];
    let maximumDecodedBytes = 0,
      maximumWireBytes = 0;
    const inputHashes: string[] = [];
    for (let index = 0; index < expectedBlocks; index++) {
      const parsed = parseChainDetailSync(
        payload("", 9_000_001 + index),
        1_790_090_000_000,
      );
      assert.equal(parsed.ok, true);
      if (!parsed.ok) throw new Error("synthetic_parser_refused");
      const rows = parsed.rows;
      rows.extrinsicRows[0].call_args = large;
      rows.extrinsicRows.push({
        ...rows.extrinsicRows[0],
        extrinsic_index: 1,
        extrinsic_hash:
          "0x" + (9_000_003 + index).toString(16).padStart(64, "0"),
      });
      rows.chainEventRows[0].args = large;
      rows.chainEventRows.push({ ...rows.chainEventRows[0], event_index: 1 });
      Object.assign(rows.blockRows[0], {
        extrinsic_count: 2,
        chain_event_count: 2,
      });
      const message = {
        lane: "chain-detail",
        captured_at: 1_790_090_000_000,
        families: {
          blockRows: rows.blockRows,
          extrinsicRows: rows.extrinsicRows,
          chainEventRows: rows.chainEventRows,
          accountEventRows: rows.accountEventRows,
        },
      };
      assert.equal(validSyncBatchMessage(message), true);
      const json = JSON.stringify(message);
      assert.ok(Buffer.byteLength(json) <= SYNC_BATCH_MAX_DECODED_BYTES);
      const bytes = gzipSync(json);
      assert.ok(bytes.length <= 96 * 1024);
      if (index === 0) {
        const decoded = await decompressSyncBatchMessage(new Uint8Array(bytes));
        assert.equal(validSyncBatchMessage(decoded), true);
        assert.equal(digest(JSON.stringify(decoded)), digest(json));
      }
      maximumDecodedBytes = Math.max(
        maximumDecodedBytes,
        Buffer.byteLength(json),
      );
      maximumWireBytes = Math.max(maximumWireBytes, bytes.length);
      inputHashes.push(digest(json));
      messages.push({
        id: `synthetic-${index}`,
        timestamp: new Date(1_790_090_000_000),
        body: new Uint8Array(bytes),
        attempts: 1,
      });
      if (Date.now() - lastCheckpoint >= 1000) {
        result.fixtureProgress = {
          preparedMessages: index + 1,
          expectedMessages: expectedBlocks,
          maximumDecodedBytes,
          maximumWireBytes,
          inputHashes,
        };
        checkpoint();
      }
    }
    result.fixture = {
      messages: expectedBlocks,
      events: expectedBlocks / 10,
      messagesPerEvent: 10,
      maximumWireBytes,
      maximumDecodedBytes,
      globalDecodedCeilingBytes: SYNC_BATCH_MAX_DECODED_BYTES,
      exactDecodeRoundTripVerified: true,
      inputHashes,
      familyRowsPerMessage: {
        blocks: 1,
        extrinsics: 2,
        chainEvents: 2,
        accountEvents: 1,
      },
      perValueBytes: 16 * 1024 * 1024,
      perPayloadFamilyBytes: 32 * 1024 * 1024,
      sourceReachability:
        "Direct valid queue contract and writer budget; not claimed derivable from a single maximum HTTP POST",
      scheduling:
        "Driver issues one or two simultaneous actual workerd queue events; not production broker scheduling acceptance",
    };
    operation = async () => {
      const outcomes = await Promise.all(
        Array.from({ length: expectedBlocks / 10 }, (_, event) =>
          fetcher.queue(
            "sync-batches",
            messages.slice(event * 10, (event + 1) * 10),
          ),
        ),
      );
      result.queueOutcomes = outcomes;
      for (const [index, outcome] of outcomes.entries()) {
        assert.equal(outcome.outcome, "ok");
        assert.equal(outcome.retryBatch.retry, false);
        assert.deepEqual(outcome.retryMessages, []);
        assert.deepEqual(
          [...outcome.explicitAcks].sort(),
          messages
            .slice(index * 10, (index + 1) * 10)
            .map((message) => message.id)
            .sort(),
        );
      }
    };
  }
  stage = "ingestion";
  const operationStarted = Date.now();
  result.operationStartedAt = new Date(operationStarted).toISOString();
  result.initialHeap = initialHeap;
  result.initialRss = initialRss;
  result.expectedFirstPayloadSha256 = digest(expectedPayload);
  checkpoint();
  sampler = (async () => {
    while (
      !samplerStopped &&
      sampledHeap.samples < 10_000 &&
      Date.now() < deadline
    ) {
      try {
        await sample();
      } catch {
        sampledHeap.errors++;
      }
      await pause(25);
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("synthetic_case_deadline")),
          Math.max(1, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  samplerStopped = true;
  await sampler;
  await sample();
  result.ingestionElapsedMs = Date.now() - operationStarted;
  result.initialHeap = initialHeap;
  result.initialRss = initialRss;
  stage = "correctness";
  const verificationResponse = await fetcher.fetch(
    "https://resource.invalid/__qualification/verify",
  );
  assert.equal(verificationResponse.status, 200);
  const verification = await verificationResponse.json();
  assert.equal(verification.counts.chain_detail_blocks, expectedBlocks);
  assert.equal(verification.counts.chain_detail_extrinsics, expectedRows);
  assert.equal(verification.counts.chain_detail_chain_events, expectedRows);
  assert.equal(verification.counts.chain_detail_account_events, expectedBlocks);
  assert.equal(
    verification.firstPayloadBytes,
    Buffer.byteLength(expectedPayload),
  );
  assert.equal(verification.firstPayloadSha256, digest(expectedPayload));
  if (scenario === "http-chunks")
    assert.ok(verification.counts.chain_detail_payload_chunks > 0);
  result.correctness = verification;
  result.outboundRequests = outbound;
  assert.equal(outbound, 0);
  assert.equal(runtimeRestarts, 0, "runtime did not silently restart");
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failureStage = stage;
  const classes = new Set([
    "AssertionError",
    "Error",
    "TypeError",
    "RangeError",
    "MiniflareCoreError",
  ]);
  const kind = error instanceof Error ? error.constructor.name : "unclassified";
  result.failureClass = classes.has(kind) ? kind : "unclassified";
  process.exitCode = 1;
} finally {
  samplerStopped = true;
  if (sampler) await sampler.catch(() => undefined);
  for (const socket of sockets) socket.terminate();
  if (mf)
    await mf.dispose().catch(() => {
      result.cleanupFailure = true;
      process.exitCode = 1;
    });
  result.runtimeRestarts = runtimeRestarts;
  result.structuredLogCounts = structuredLogs;
  result.inspectorProtocolErrors = inspectorProtocolErrors;
  result.measurements = {
    sampledUserIsolateHeap: sampledHeap,
    processRss: rss,
    heapScope:
      "Sampled marked user workerd isolate only, no forced GC; observed maximum is a lower bound and is not total isolate allocation or Cloudflare memory-limit proof",
    rssScope:
      "Actual workerd PID process RSS/HWM includes Miniflare system and D1 helper isolates; Node driver is reported separately. It cannot be interpreted as user-isolate heap or subtract D1 overhead.",
    acceptance:
      "No production 128 MiB clearance, sustained workload, regional placement, provider scheduling, or shared-account capacity acceptance",
  };
  result.elapsedMs = Date.now() - started;
  writeFileSync(
    path.join(reportDirectory, "driver.ts"),
    readFileSync(process.argv[1]),
  );
  writeFileSync(
    path.join(reportDirectory, output),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      scenario,
      variant,
      status: result.status,
      stage: result.failureStage,
      sampledHeap,
      rss,
      elapsedMs: result.elapsedMs,
    }),
  );
}
