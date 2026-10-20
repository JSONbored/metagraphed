import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCipheriv, createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createGunzip } from "node:zlib";
import path from "node:path";
import { Miniflare, NoOpLog } from "miniflare";
import WebSocket from "ws";

const scenario = process.argv[2];
const variant = process.argv[3];
assert.ok(["fresh-compressible", "retry-high-entropy"].includes(scenario));
const variants = ["q8-number", "v3-number"] as const;
assert.ok(variants.includes(variant as (typeof variants)[number]));
const base = "0a65fcffd51b0a6a2b9757905be02c1d8b859e6c";
const pinManifestPath = ".github/fixtures/raw-capture-number-candidates/manifest.json";
const pinManifestBytes = readFileSync(pinManifestPath);
assert.ok(pinManifestBytes.length <= 65536);
const pinManifestSha256 = createHash("sha256").update(pinManifestBytes).digest("hex");
assert.equal(pinManifestSha256, process.env.RESOURCE_CANDIDATE_MANIFEST_SHA256);
const pinManifest = JSON.parse(pinManifestBytes.toString("utf8")) as {
  status: string;
  base: string;
  files: string[];
  variants: Record<string, {
    nativeQualification: { runId: number | null; runAttempt: number | null; sourceCommit: string | null; artifactId: number | null; zipSha256: string | null; comparisonProofSha256: string | null };
    files: Record<string, { blob: string | null; sha256: string | null }>;
  }>;
};
assert.equal(pinManifest.status, "artifact_verified_native_compatibility_pins");
assert.equal(pinManifest.base, base);
assert.deepEqual(Object.keys(pinManifest.variants), variants);
const candidateFiles = ["src/raw-capture-d1.ts", "src/raw-chain-capture.ts", "src/raw-capture-retry-intent.ts", "src/raw-capture-retry-store.ts"];
assert.deepEqual(pinManifest.files, candidateFiles);
for (const id of variants) {
  const candidate = pinManifest.variants[id];
  assert.deepEqual(Object.keys(candidate.files), candidateFiles);
  for (const file of candidateFiles) {
    const pin = candidate.files[file];
    assert.ok(typeof pin.blob === "string" && /^[a-f0-9]{40}$/.test(pin.blob));
    assert.ok(typeof pin.sha256 === "string" && /^[a-f0-9]{64}$/.test(pin.sha256));
  }
  const qualification = candidate.nativeQualification;
  for (const key of ["runId", "runAttempt", "artifactId"] as const) assert.ok(Number.isSafeInteger(qualification[key]) && Number(qualification[key]) > 0);
  assert.ok(typeof qualification.sourceCommit === "string" && /^[a-f0-9]{40}$/.test(qualification.sourceCommit));
  for (const key of ["zipSha256", "comparisonProofSha256"] as const) assert.ok(typeof qualification[key] === "string" && /^[a-f0-9]{64}$/.test(qualification[key]));
}
const a = pinManifest.variants[variants[0]], b = pinManifest.variants[variants[1]];
for (const key of ["runId", "runAttempt", "sourceCommit", "comparisonProofSha256"] as const) assert.equal(a.nativeQualification[key], b.nativeQualification[key]);
assert.notEqual(a.nativeQualification.artifactId, b.nativeQualification.artifactId);
for (const file of candidateFiles.slice(0, 2)) assert.deepEqual(a.files[file], b.files[file]);
const preflightPath = "tmp/raw-capture-resource-native/preflight.json";
const preflightBytes = readFileSync(preflightPath);
assert.ok(preflightBytes.length > 0 && preflightBytes.length <= 65536);
const preflightSha256 = createHash("sha256").update(preflightBytes).digest("hex");
assert.equal(preflightSha256, process.env.RESOURCE_NATIVE_PREFLIGHT_SHA256);
assert.equal(process.env.RESOURCE_GATE_PHASE, "qualify");
const preflight = JSON.parse(preflightBytes.toString("utf8")) as {
  status: string; phase: string; scenario: string; variant: string;
  source_head: string; run_id: string; run_attempt: string; manifest_sha256: string;
  native_qualification: unknown; canonical_runtime_restored: boolean;
  observer_controls_passed: number; type_inputs_confirmed: number;
  helper_pins: { path: string; bytes: number; sha256: string }[];
};
assert.equal(preflight.status, "native_checks_passed_resource_not_run");
assert.equal(preflight.phase, "qualify");
assert.equal(preflight.scenario, scenario);
assert.equal(preflight.variant, variant);
assert.equal(preflight.source_head, process.env.GITHUB_SHA);
assert.equal(preflight.run_id, process.env.GITHUB_RUN_ID);
assert.equal(preflight.run_attempt, process.env.GITHUB_RUN_ATTEMPT);
assert.equal(preflight.manifest_sha256, pinManifestSha256);
assert.deepEqual(preflight.native_qualification, pinManifest.variants[variant].nativeQualification);
assert.equal(preflight.canonical_runtime_restored, true);
assert.equal(preflight.observer_controls_passed, 38);
assert.equal(preflight.type_inputs_confirmed, 3);
assert.deepEqual(preflight.helper_pins.map((pin) => pin.path), [
  ".github/scripts/qualify-raw-capture-resources.ts",
  ".github/fixtures/raw-capture-resource-worker.ts",
  ".github/scripts/gate-raw-capture-resources.ts",
  ".github/tsconfig.raw-capture-resources.json",
]);
for (const pin of preflight.helper_pins) {
  const bytes = readFileSync(pin.path);
  assert.equal(bytes.length, pin.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.sha256);
}
const selectedCandidate = pinManifest.variants[variant];
const nativeQualification = selectedCandidate.nativeQualification;
const candidateBlobs: Record<string, string> = {}, candidateHashes: Record<string, string> = {};
for (const file of candidateFiles) {
  const pin = selectedCandidate.files[file];
  assert.ok(typeof pin.blob === "string" && typeof pin.sha256 === "string");
  candidateBlobs[file] = pin.blob;
  candidateHashes[file] = pin.sha256;
}
const fixturePath = (file: string, id = variant) => ".github/fixtures/raw-capture-number-candidates/" + id + "/" + file;
const carrierPaths = [
  ".github/scripts/qualify-raw-capture-resources.ts",
  ".github/fixtures/raw-capture-resource-worker.ts",
  ".github/workflows/raw-capture-resource-qualification.yml",
  ".github/scripts/gate-raw-capture-resources.ts",
  ".github/tsconfig.raw-capture-resources.json",
  pinManifestPath,
  ...variants.flatMap((id) => candidateFiles.map((file) => fixturePath(file, id))),
];
const schemaPaths = [
  "migrations/d1/0027_generated_artifacts.sql",
  "migrations/d1/0028_raw_capture_storage.sql",
  "migrations/d1/0029_raw_capture_archive.sql",
];
const root = process.cwd();
const reportDirectory = path.resolve("raw-capture-resource-reports");
mkdirSync(reportDirectory, { recursive: true });
const output = `${scenario}-${variant}.json`;
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const compatibleDate = "2026-06-06";
const compatibilityFlags = ["nodejs_compat", "global_fetch_strictly_public"];
const LOGICAL_RPC_URL = "https://rpc.fixture.invalid/rpc";
const result: Record<string, any> = {
  scenario,
  variant,
  sourceBase: base,
  nativeQualification,
  sourcePinManifestSha256: pinManifestSha256,
  protocolProfile: "candidate_raw_capture_retry",
  nativeGatePreflightSha256: preflightSha256,
  formattedDriverSha256: digest(readFileSync(process.argv[1])),
  workerFixtureSha256: digest(
    readFileSync(".github/fixtures/raw-capture-resource-worker.ts"),
  ),
  productionActions: false,
  startupGraph:
    "Actual split/minified native api.entry.ts builder/options with reserved lazy probe; API loaded explicitly before capture baseline; direct captureTick, not production cron/runRawCaptureSync scheduling",
  fixtureScope:
    "Source-accepted synthetic RPC strings; not real SCALE or a finite maximum for currently unbounded RPC inputs",
  compatibilityDate: compatibleDate,
  compatibilityFlags,
  transportScope: {
    logicalRpcUrl: LOGICAL_RPC_URL,
    logicalRole: "Fixed reserved fixture endpoint; no DNS or external fetch",
    actualTransport:
      "Owned 127.0.0.1 server only; ephemeral port and address are not retained",
  },
};
// Retain only fixed categories, numeric bundle lines and source-derived builtins.
// Native error messages may contain ephemeral headers and are never retained.
const diagnosticCodes = new Set([
  "ERR_ADDRESS_IN_USE",
  "ERR_DISPOSED",
  "ERR_MODULE_PARSE",
  "ERR_MODULE_STRING_SCRIPT",
  "ERR_MODULE_DYNAMIC_SPEC",
  "ERR_MODULE_RULE",
  "ERR_PERSIST_UNSUPPORTED",
  "ERR_FUTURE_COMPATIBILITY_DATE",
  "ERR_NO_WORKERS",
  "ERR_VALIDATION",
  "ERR_DUPLICATE_NAME",
  "ERR_DIFFERENT_STORAGE_BACKEND",
  "ERR_DIFFERENT_UNIQUE_KEYS",
  "ERR_DIFFERENT_PREVENT_EVICTION",
  "ERR_DIFFERENT_S3_CREDENTIALS",
  "ERR_MISSING_INSPECTOR_PROXY_PORT",
  "ERR_MISSING_EXPLORER_UI",
  "ERR_RUNTIME_FAILURE",
  "ERR_PLUGIN_LOADING_FAILED",
]);
const diagnosticClasses = [
  "TypeError",
  "ReferenceError",
  "SyntaxError",
  "RangeError",
  "EvalError",
  "URIError",
];
const startupDiagnostic = {
  codes: [] as string[],
  exceptions: [] as string[],
  builtinModules: [] as string[],
  bundleLines: [] as number[],
  importIndexes: [] as number[],
};
function diagnose(error: unknown) {
  const push = <T>(values: T[], value: T, limit: number) => {
    if (!values.includes(value) && values.length < limit) values.push(value);
  };
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string" && diagnosticCodes.has(code))
      push(startupDiagnostic.codes, code, 8);
    const text = current.message.slice(0, 65536);
    for (const name of diagnosticClasses)
      if (text.includes(name + ":"))
        push(startupDiagnostic.exceptions, name, 6);
    for (const match of text.matchAll(/\.js:([0-9]{1,7}):[0-9]{1,7}/g))
      push(startupDiagnostic.bundleLines, Number(match[1]), 16);
    current = (current as Error & { cause?: unknown }).cause;
  }
  result.startupDiagnostic = startupDiagnostic;
}
let stage = "source";
let rpcServer: Server | undefined;
let permittedOutbound = 0;
let blockedOutbound = 0;
let rpcRequests = 0;
const rpcReceipts: Record<string, unknown>[] = [];

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
        rpcObservation: {
          permitted: permittedOutbound,
          blocked: blockedOutbound,
          requests: rpcRequests,
          responses: rpcReceipts,
        },
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
writeFileSync(
  path.join(reportDirectory, "worker.ts"),
  readFileSync(".github/fixtures/raw-capture-resource-worker.ts"),
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

const FIRST = 9_000_001;
const LAST = FIRST + 24;
const RAW_BYTES = 32 * 1024 * 1024;
const TIMES = [1_790_090_000_000, 1_790_090_001_000, 1_790_090_002_000];
const rawKey = `chain/raw/blocks/${String(FIRST).padStart(12, "0")}-${String(LAST).padStart(12, "0")}.ndjson`;
const hashAt = (height: number) => "0x" + height.toString(16).padStart(64, "0");
function row(height: number, events: string, at: number) {
  const parentHash = hashAt(height - 1);
  return {
    block_number: height,
    block_hash: hashAt(height),
    parent_hash: parentHash,
    header: { parentHash },
    extrinsics: [],
    events,
    captured_at: at,
  };
}
function fixture() {
  const emptyBytes = Array.from({ length: 25 }, (_, i) =>
    Buffer.byteLength(JSON.stringify(row(FIRST + i, "", TIMES[0])) + "\n"),
  ).reduce((a, b) => a + b, 0);
  const padding = RAW_BYTES - emptyBytes;
  assert.ok(padding > 0);
  const events =
    scenario === "fresh-compressible"
      ? "x".repeat(padding)
      : createCipheriv(
          "aes-256-ctr",
          Buffer.alloc(32, 11),
          Buffer.alloc(16, 13),
        )
          .update(Buffer.alloc(Math.ceil((padding * 3) / 4)))
          .toString("base64")
          .slice(0, padding);
  const expected = TIMES.map((at) => {
    const hash = createHash("sha256");
    let bytes = 0;
    for (let i = 0; i < 25; i++) {
      const line =
        JSON.stringify(row(FIRST + i, i === 0 ? events : "", at)) + "\n";
      hash.update(line);
      bytes += Buffer.byteLength(line);
    }
    assert.equal(bytes, RAW_BYTES);
    return { at, bytes, sha256: hash.digest("hex") };
  });
  return { events, expected, padding, eventsSha256: digest(events) };
}

async function ownedRpc(
  data: ReturnType<typeof fixture>,
  eventsStorageKey: string,
) {
  rpcServer = createServer(async (request, response) => {
    try {
      assert.ok(
        ["127.0.0.1", "::ffff:127.0.0.1"].includes(
          request.socket.remoteAddress ?? "",
        ),
      );
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/rpc");
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString("utf8");
        assert.ok(Buffer.byteLength(body) <= 65536);
      }
      const input = JSON.parse(body);
      const answer = (call: any) => {
        assert.equal(call.jsonrpc, "2.0");
        assert.ok(typeof call.id === "number" || typeof call.id === "string");
        let value: unknown;
        if (call.method === "chain_getHeader") {
          assert.deepEqual(call.params, []);
          value = { number: "0x" + LAST.toString(16) };
        } else if (call.method === "chain_getBlockHash") {
          assert.deepEqual(call.params, [
            Array.from({ length: 25 }, (_, i) => FIRST + i),
          ]);
          value = Array.from({ length: 25 }, (_, i) => hashAt(FIRST + i));
        } else if (call.method === "chain_getBlock") {
          const height = Number.parseInt(call.params[0].slice(2), 16);
          assert.ok(height >= FIRST && height <= LAST);
          assert.deepEqual(call.params, [hashAt(height)]);
          value = {
            block: {
              header: { parentHash: hashAt(height - 1) },
              extrinsics: [],
            },
          };
        } else if (call.method === "state_getStorage") {
          const height = Number.parseInt(call.params[1].slice(2), 16);
          assert.ok(height >= FIRST && height <= LAST);
          assert.equal(call.params.length, 2);
          assert.equal(call.params[0], eventsStorageKey);
          assert.equal(call.params[1], hashAt(height));
          value = height === FIRST ? data.events : "";
        } else throw new Error("fixture_rpc_method");
        return { jsonrpc: "2.0", id: call.id, result: value };
      };
      if (Array.isArray(input)) {
        assert.equal(input.length, 50);
        assert.equal(
          input.filter((c) => c.method === "chain_getBlock").length,
          25,
        );
        assert.equal(
          input.filter((c) => c.method === "state_getStorage").length,
          25,
        );
      }
      const payload = JSON.stringify(
        Array.isArray(input) ? input.map(answer) : answer(input),
      );
      rpcRequests++;
      assert.ok(rpcReceipts.length < 16);
      rpcReceipts.push({
        calls: Array.isArray(input) ? input.length : 1,
        bytes: Buffer.byteLength(payload),
        sha256: digest(payload),
      });
      if (Date.now() - lastCheckpoint >= 1000) checkpoint();
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      });
      response.end(payload);
    } catch {
      result.rpcFixtureFailure = true;
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"fixtureFailure":true}');
    }
  });
  rpcServer.maxConnections = 4;
  rpcServer.headersTimeout = 5000;
  rpcServer.requestTimeout = 15000;
  rpcServer.listen(0, "127.0.0.1");
  await once(rpcServer, "listening");
  const address = rpcServer.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}/rpc`;
}

async function initializeSchema(db: D1Database) {
  const reference = new DatabaseSync(":memory:");
  try {
    const receipt: Record<string, string> = {};
    for (const file of schemaPaths) {
      const sql = readFileSync(file, "utf8");
      receipt[file] = digest(sql);
      reference.exec(sql);
    }
    const schema = readFileSync("db/d1-schema.sql", "utf8");
    const state = /CREATE TABLE raw_capture_state[\s\S]*?;/.exec(schema);
    assert.ok(state);
    reference.exec(state[0]);
    receipt["db/d1-schema.sql"] = digest(schema);
    receipt["raw_capture_state DDL"] = digest(state[0]);
    const ddl = reference
      .prepare(
        "SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
      )
      .all() as { type: string; name: string; sql: string }[];
    for (const object of ddl) await db.prepare(object.sql).run();
    const seed = /INSERT INTO raw_capture_budget\(id\) VALUES\(1\);/.exec(
      readFileSync(schemaPaths[1], "utf8"),
    );
    assert.ok(seed);
    await db.prepare(seed[0]).run();
    const sort = (rows: any[]) =>
      rows
        .map((row) => ({ type: row.type, name: row.name, sql: row.sql }))
        .sort((a, b) => (a.type + a.name).localeCompare(b.type + b.name));
    const actual = await db
      .prepare(
        "SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      )
      .all();
    assert.deepEqual(sort(actual.results), sort(ddl));
    const budget = await db
      .prepare("SELECT id,bytes,objects FROM raw_capture_budget")
      .all();
    assert.deepEqual(
      budget.results,
      reference
        .prepare("SELECT id,bytes,objects FROM raw_capture_budget")
        .all()
        .map((row) => ({ ...row })),
    );
    assert.equal(
      await db.prepare("PRAGMA foreign_keys").first<number>("foreign_keys"),
      1,
    );
    result.schemaReceipt = {
      sourceHashes: receipt,
      canonicalSchemaSha256: digest(JSON.stringify(sort(ddl))),
      fullNativeEquality: true,
      seedEquality: true,
      nativeForeignKeys: true,
    };
    await db
      .prepare(
        "INSERT INTO raw_capture_state(network,last_contiguous_block,updated_at) VALUES(?,?,?)",
      )
      .bind("mainnet", FIRST - 1, TIMES[0] - 1000)
      .run();
  } finally {
    reference.close();
  }
}

async function snapshot(db: D1Database) {
  const batches = (
    await db
      .prepare("SELECT * FROM raw_capture_batches ORDER BY key,sha256")
      .all()
  ).results as Record<string, any>[];
  assert.ok(batches.length <= 2);
  const budget = await db
    .prepare("SELECT bytes,objects FROM raw_capture_budget WHERE id=1")
    .first();
  const chunks = (
    await db
      .prepare(
        "SELECT sha256,count(*) parts,sum(length(data)) bytes FROM raw_capture_chunks GROUP BY sha256 ORDER BY sha256",
      )
      .all()
  ).results;
  const selected = (
    await db
      .prepare("SELECT key,sha256 FROM raw_capture_selected ORDER BY key")
      .all()
  ).results;
  const watermark = await db
    .prepare(
      "SELECT last_contiguous_block FROM raw_capture_state WHERE network='mainnet'",
    )
    .first<number>("last_contiguous_block");
  const controls = (
    await db
      .prepare("SELECT key,payload FROM generated_artifacts ORDER BY key")
      .all()
  ).results as { key: string; payload: string }[];
  assert.ok(controls.length <= 1);
  const prefix = [];
  for (const batch of batches) {
    const rows = await db
      .prepare(
        "SELECT part,hex(data) data FROM raw_capture_chunks WHERE key=? AND sha256=? AND part<8 ORDER BY part",
      )
      .bind(batch.key, batch.sha256)
      .all<{ part: number; data: string }>();
    assert.ok(rows.results.length <= 8);
    for (const [index, stored] of rows.results.entries()) {
      assert.equal(stored.part, index);
      assert.match(stored.data, /^[0-9A-F]+$/);
      assert.ok(stored.data.length <= 2 * 65536);
      const bytes = Buffer.from(stored.data, "hex");
      prefix.push({
        sha256: batch.sha256,
        part: stored.part,
        bytes: bytes.length,
        dataSha256: digest(bytes),
      });
    }
  }
  const archives = await db
    .prepare("SELECT count(*) n FROM raw_capture_archives")
    .first<number>("n");
  return {
    batches,
    budget,
    chunks,
    prefix,
    selected,
    watermark,
    archives,
    controls: controls.map((control) => {
      assert.ok(Buffer.byteLength(control.payload) <= 96 * 1024);
      const parsed = JSON.parse(control.payload);
      return {
        key: control.key,
        payloadSha256: digest(control.payload),
        bytes: Buffer.byteLength(control.payload),
        descriptor: parsed.descriptor,
        provenanceCount: parsed.provenance.length,
        provenanceSha256: digest(JSON.stringify(parsed.provenance)),
      };
    }),
  };
}

async function verifyStored(
  db: D1Database,
  state: Awaited<ReturnType<typeof snapshot>>,
  expected: { at: number; bytes: number; sha256: string },
) {
  assert.equal(state.batches.length, 1);
  const descriptor = state.batches[0];
  assert.equal(descriptor.key, rawKey);
  assert.equal(descriptor.network, "mainnet");
  assert.equal(descriptor.first_block, FIRST);
  assert.equal(descriptor.last_block, LAST);
  assert.equal(descriptor.sha256, expected.sha256);
  assert.equal(descriptor.raw_bytes, RAW_BYTES);
  assert.equal(descriptor.captured_at, expected.at);
  assert.equal(descriptor.complete, 1);
  assert.deepEqual(state.budget, {
    bytes: descriptor.compressed_bytes,
    objects: 1,
  });
  assert.equal(state.watermark, LAST);
  assert.equal(state.controls.length, 0);
  assert.equal(state.archives, 0);
  assert.deepEqual(state.selected, [{ key: rawKey, sha256: expected.sha256 }]);
  assert.deepEqual(state.chunks, [
    {
      sha256: expected.sha256,
      parts: descriptor.parts,
      bytes: descriptor.compressed_bytes,
    },
  ]);
  const compressedHash = createHash("sha256"),
    rawHash = createHash("sha256");
  let compressedBytes = 0,
    rawBytes = 0,
    lines = 0;
  const inflater = createGunzip();
  let readerFailure = false;
  const consumed = (async () => {
    for await (const chunk of inflater) {
      rawBytes += chunk.length;
      assert.ok(rawBytes <= RAW_BYTES);
      rawHash.update(chunk);
      for (const byte of chunk) if (byte === 10) lines++;
    }
  })().then(
    () => undefined,
    () => {
      readerFailure = true;
    },
  );
  try {
    for (let start = 0; start < descriptor.parts; start += 8) {
      const rows = await db
        .prepare(
          "SELECT part,hex(data) data FROM raw_capture_chunks WHERE key=? AND sha256=? AND part>=? AND part<? ORDER BY part",
        )
        .bind(
          rawKey,
          expected.sha256,
          start,
          Math.min(descriptor.parts, start + 8),
        )
        .all<{ part: number; data: string }>();
      assert.equal(rows.results.length, Math.min(8, descriptor.parts - start));
      for (const [index, stored] of rows.results.entries()) {
        assert.equal(stored.part, start + index);
        assert.match(stored.data, /^[0-9A-F]+$/);
        assert.ok(stored.data.length <= 2 * 65536);
        const bytes = Buffer.from(stored.data, "hex");
        assert.equal(
          bytes.length,
          Math.min(65536, descriptor.compressed_bytes - stored.part * 65536),
        );
        compressedBytes += bytes.length;
        compressedHash.update(bytes);
        await new Promise<void>((resolve, reject) =>
          inflater.write(bytes, (error) =>
            error ? reject(new Error("fixture_gzip_verification")) : resolve(),
          ),
        );
        assert.equal(
          readerFailure,
          false,
          "gzip verification reader succeeded",
        );
      }
    }
    inflater.end();
    await consumed;
    assert.equal(readerFailure, false, "gzip verification reader succeeded");
  } finally {
    inflater.destroy();
    await consumed;
  }
  assert.equal(compressedBytes, descriptor.compressed_bytes);
  assert.equal(compressedHash.digest("hex"), descriptor.compressed_sha256);
  assert.equal(rawBytes, RAW_BYTES);
  assert.equal(rawHash.digest("hex"), expected.sha256);
  assert.equal(lines, 25);
  return {
    descriptor,
    rawBytes,
    records: lines,
    compressedBytes,
    rawSha256: expected.sha256,
    compressedSha256: descriptor.compressed_sha256,
    independentGunzipVerified: true,
  };
}

try {
  const runtimeInputs = [
    "src",
    "workers",
    "schemas-src",
    "schemas",
    "generated",
    "db",
    "migrations",
    "package.json",
    "package-lock.json",
    "wrangler.jsonc",
    "wrangler.data.jsonc",
    "scripts/build-api-worker.ts",
    "scripts/lib.ts",
  ];
  const changed = execFileSync("git", ["diff", "--name-only", base, "HEAD"], {
    encoding: "utf8",
    maxBuffer: 65536,
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(
    changed,
    [...carrierPaths].sort(),
    "only the fourteen isolated .github carrier files differ",
  );
  execFileSync(
    "git",
    ["diff", "--exit-code", base, "HEAD", "--", ...runtimeInputs],
    { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 65536 },
  );
  const workingChanged = execFileSync("git", ["diff", "--name-only", base], {
    encoding: "utf8",
    maxBuffer: 65536,
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(
    workingChanged,
    [...carrierPaths].sort(),
    "install and formatting did not alter other tracked inputs",
  );
  execFileSync("git", ["diff", "--exit-code", base, "--", ...runtimeInputs], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 65536,
  });
  result.carrierCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  result.sourceTree = execFileSync("git", ["rev-parse", `${base}^{tree}`], {
    encoding: "utf8",
  }).trim();
  result.runtimeInputManifestSha256 = digest(
    execFileSync("git", ["ls-tree", "-r", base, "--", ...runtimeInputs], {
      maxBuffer: 2 * 1024 * 1024,
    }),
  );
  result.carrierRuntimeInputManifestSha256 = digest(
    execFileSync("git", ["ls-tree", "-r", "HEAD", "--", ...runtimeInputs], {
      maxBuffer: 2 * 1024 * 1024,
    }),
  );
  assert.equal(
    result.carrierRuntimeInputManifestSha256,
    result.runtimeInputManifestSha256,
  );
  result.canonicalRuntimeUnchanged = true;
  result.sourceOverlayScope =
    "Verified .github fixture source copied only into this disposable job checkout before bundling";
  const productionConfig = readFileSync("wrangler.jsonc", "utf8");
  const productionConfigBlob = execFileSync(
    "git",
    ["rev-parse", "HEAD:wrangler.jsonc"],
    { encoding: "utf8" },
  ).trim();
  assert.equal(
    productionConfigBlob,
    "6624787c6bb26130e7a6d1d18e685e0b0f1d8ccf",
  );
  const flagSource = /"compatibility_flags"\s*:\s*(\[[^\]]*\])/.exec(
    productionConfig,
  );
  const dateSource = /"compatibility_date"\s*:\s*"([0-9-]+)"/.exec(
    productionConfig,
  );
  assert.ok(flagSource && dateSource);
  assert.deepEqual(JSON.parse(flagSource[1]), compatibilityFlags);
  assert.equal(dateSource[1], compatibleDate);
  result.productionCompatibilitySource = {
    source: "wrangler.jsonc",
    sourceBase: base,
    blob: productionConfigBlob,
    sha256: digest(productionConfig),
    flags: compatibilityFlags,
    date: compatibleDate,
  };
  result.sourceReceipt = {};
  for (const [file, candidateBlob] of Object.entries(candidateBlobs)) {
    const fixture = fixturePath(file);
    assert.equal(
      execFileSync("git", ["rev-parse", `HEAD:${fixture}`], {
        encoding: "utf8",
      }).trim(),
      candidateBlob,
    );
    assert.equal(digest(readFileSync(fixture)), candidateHashes[file]);
    const ref = result.carrierCommit;
    const expectedBlob = candidateBlob;
    const sourcePath = fixture;
    const blob = execFileSync("git", ["rev-parse", `${ref}:${sourcePath}`], {
      encoding: "utf8",
    }).trim();
    assert.equal(blob, expectedBlob);
    const source = execFileSync("git", ["show", `${ref}:${sourcePath}`]);
    writeFileSync(file, source);
    result.sourceReceipt[file] = {
      ref,
      sourcePath,
      blob,
      sha256: digest(source),
    };
  }
  result.workerSha256 = digest(readFileSync("workers/api.ts"));
  stage = "fixture";
  checkpoint();
  const data = fixture();
  result.fixture = {
    records: 25,
    rawBytes: RAW_BYTES,
    first: FIRST,
    last: LAST,
    eventsBytes: data.padding,
    eventsSha256: data.eventsSha256,
    entropy:
      scenario === "fresh-compressible"
        ? "repeated ASCII"
        : "deterministic AES-CTR base64",
    expected: data.expected,
  };
  const { SYSTEM_EVENTS_STORAGE_KEY } = await import(
    path.join(root, "src/twox-storage-key.ts")
  );
  result.fixture.eventsStorageKey = SYSTEM_EVENTS_STORAGE_KEY;
  const rpcUrl = await ownedRpc(data, SYSTEM_EVENTS_STORAGE_KEY);
  stage = "native-build-source";
  checkpoint();
  const buildPins = {
    "workers/api.entry.ts": {
      sha256:
        "d322d676b640fecd7ad66d719e1f3bc26eca502192d74cfabc3992ec81059979",
      blob: "5cd1f4e15dd23a5c2beca221af5c9f202245898a",
    },
    "scripts/build-api-worker.ts": {
      sha256:
        "2c8d80adfa15f45211c7f8cdd8c19e4a19629fe4d6efcf87b710be26f7251893",
      blob: "48face14c44fae096bb9be84034716ae7084479b",
    },
  };
  for (const [file, pin] of Object.entries(buildPins)) {
    assert.equal(
      execFileSync("git", ["rev-parse", `HEAD:${file}`], {
        encoding: "utf8",
      }).trim(),
      pin.blob,
    );
    assert.equal(digest(readFileSync(file)), pin.sha256);
  }
  assert.equal(process.env.METAGRAPH_REPO_ROOT, undefined);
  const originalEntry = readFileSync("workers/api.entry.ts", "utf8");
  assert.equal(originalEntry.split("export default {").length, 2);
  assert.ok(!originalEntry.includes("resourceOriginalApiEntry"));
  const entryWrapper = `
export default {
  ...resourceOriginalApiEntry,
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/__resource/warm" || pathname === "/__resource/capture") {
      return (await import("../.github/fixtures/raw-capture-resource-worker.ts")).default.fetch(request, env as never, ctx);
    }
    return resourceOriginalApiEntry.fetch(request, env, ctx);
  },
};
`;
  const transformedEntry =
    originalEntry.replace(
      "export default {",
      "const resourceOriginalApiEntry = {",
    ) + entryWrapper;
  assert.equal(
    digest(transformedEntry),
    "99ad3aaa206f8de472334be7c82db241a857b0704df9061762eb0d81a6cb6cb7",
  );
  writeFileSync("workers/api.entry.ts", transformedEntry);
  result.nativeBuild = {
    sourcePins: buildPins,
    transformedEntrySha256: digest(transformedEntry),
    entryWrapperSha256: digest(entryWrapper),
    entryTransform:
      "Exactly one default declaration renamed; original methods and five DO exports retained verbatim; reserved paths lazily import controller",
    options:
      "Unchanged exported buildApiWorker(outdir), including splitting, esm, minify, conditions, node-require plugin, defines and wasm copy loader",
    instrumentationScope:
      "Entry fetch wrapper and lazy synthetic controller add code/module edges; direct warmed captureTick excludes scheduler, endpoint selection and two-network concurrency; not exact deployed bytes or a production upper bound",
  };
  // The native helper removes outdir recursively. Create its parent ourselves,
  // then prove both parent and assigned child are real, owned, non-symlink dirs.
  const realRoot = realpathSync(root);
  assert.equal(
    realpathSync(
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        encoding: "utf8",
      }).trim(),
    ),
    realRoot,
  );
  const scratch = mkdtempSync(path.join(realRoot, ".raw-capture-native-"));
  const scratchInfo = lstatSync(scratch);
  assert.ok(scratchInfo.isDirectory() && !scratchInfo.isSymbolicLink());
  assert.equal(scratchInfo.uid, process.getuid!());
  assert.equal(scratchInfo.mode & 0o077, 0);
  assert.equal(path.dirname(realpathSync(scratch)), realRoot);
  const bundled = path.join(scratch, "bundle");
  mkdirSync(bundled);
  const outputInfo = lstatSync(bundled);
  assert.ok(outputInfo.isDirectory() && !outputInfo.isSymbolicLink());
  assert.equal(outputInfo.uid, process.getuid!());
  assert.equal(
    realpathSync(bundled),
    path.join(realpathSync(scratch), "bundle"),
  );
  assert.ok(realpathSync(bundled).startsWith(realpathSync(scratch) + path.sep));
  result.nativeBuild.ownedOutput = {
    freshPrivateParent: true,
    parentAndOutputNonSymlink: true,
    realCheckoutContainment: true,
    ephemeralPathRetained: false,
  };
  stage = "native-build";
  checkpoint();
  const { buildApiWorker } = await import(
    path.join(root, "scripts/build-api-worker.ts")
  );
  const esbuild = await import("esbuild");
  let buildTimer: ReturnType<typeof setTimeout> | undefined;
  let built: Awaited<ReturnType<typeof buildApiWorker>>;
  try {
    built = await Promise.race([
      buildApiWorker(bundled),
      new Promise<never>((_, reject) => {
        buildTimer = setTimeout(
          () => reject(new Error("fixture_native_build_deadline")),
          90000,
        );
      }),
    ]);
  } finally {
    clearTimeout(buildTimer);
    await esbuild.stop();
  }
  assert.equal(built.errors.length, 0);
  assert.ok(built.metafile);
  const metafile = built.metafile;
  assert.ok(
    Object.keys(metafile.inputs).length <= 20000 &&
      Object.keys(metafile.outputs).length <= 1024,
  );
  const buildPackage = JSON.parse(
    readFileSync("node_modules/esbuild/package.json", "utf8"),
  );
  assert.equal(buildPackage.name, "esbuild");
  assert.match(buildPackage.version, /^[0-9][0-9A-Za-z.+-]{0,63}$/);
  result.nativeBuild.esbuildVersion = buildPackage.version;
  const walk = (directory: string, depth = 0): string[] => {
    assert.ok(depth <= 8);
    const files: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      assert.ok(
        realpathSync(file).startsWith(realpathSync(bundled) + path.sep),
      );
      if (entry.isDirectory()) files.push(...walk(file, depth + 1));
      else {
        assert.ok(entry.isFile());
        files.push(file);
      }
      assert.ok(files.length <= 1024);
    }
    return files;
  };
  stage = "native-output-inventory";
  checkpoint();
  const scriptPath = path.join(bundled, "api.entry.js");
  const files = walk(bundled).sort();
  assert.equal(
    files.filter(
      (file) => path.dirname(file) === bundled && file.endsWith(".js"),
    ).length,
    1,
  );
  assert.ok(files.includes(scriptPath));
  const fileIndex = new Map(files.map((file, index) => [file, index]));
  const records: Array<{
    index: number;
    outputPathSha256: string;
    role: string;
    bytes: number;
    sha256: string;
  }> = [];
  let totalBytes = 0;
  for (const file of files) {
    const info = statSync(file);
    totalBytes += info.size;
    assert.ok(
      info.size <= 128 * 1024 * 1024 && totalBytes <= 256 * 1024 * 1024,
    );
    const extension = path.extname(file);
    const role =
      extension === ".js"
        ? "ESModule"
        : extension === ".wasm"
          ? "CompiledWasm"
          : extension === ".map"
            ? "SourceMap"
            : "unexpected";
    assert.notEqual(role, "unexpected");
    const fd = openSync(file, "r"),
      hash = createHash("sha256"),
      buffer = Buffer.allocUnsafe(128 * 1024);
    try {
      let count = 0;
      for (;;) {
        assert.ok(Date.now() < deadline);
        const size = readSync(fd, buffer);
        if (!size) break;
        count += size;
        hash.update(buffer.subarray(0, size));
      }
      assert.equal(count, info.size);
    } finally {
      closeSync(fd);
    }
    records.push({
      index: fileIndex.get(file)!,
      outputPathSha256: digest(path.relative(bundled, file)),
      role,
      bytes: info.size,
      sha256: hash.digest("hex"),
    });
    const meta = Object.entries(metafile.outputs).find(
      ([key]) => path.resolve(root, key) === file,
    )?.[1];
    assert.ok(meta);
    assert.equal(meta.bytes, info.size);
  }
  stage = "native-output-edges";
  const outputs = new Map(
    Object.entries(metafile.outputs).map(([key, value]) => [
      path.resolve(root, key),
      value,
    ]),
  );
  const edges: Array<{ from: number; to: number; dynamic: boolean }> = [];
  for (const [file, output] of outputs)
    for (const dependency of output.imports) {
      if (dependency.external) continue;
      const candidates = [
        ...new Set([
          path.resolve(root, dependency.path),
          path.resolve(path.dirname(file), dependency.path),
        ]),
      ].filter((item) => outputs.has(item));
      assert.equal(candidates.length, 1);
      assert.ok(fileIndex.has(file) && fileIndex.has(candidates[0]));
      edges.push({
        from: fileIndex.get(file)!,
        to: fileIndex.get(candidates[0])!,
        dynamic: dependency.kind === "dynamic-import",
      });
    }
  const entryIndex = fileIndex.get(scriptPath)!;
  const closure = (includeDynamic: boolean) => {
    const visited = new Set([entryIndex]);
    for (let size = -1; size !== visited.size;) {
      size = visited.size;
      for (const edge of edges)
        if (visited.has(edge.from) && (includeDynamic || !edge.dynamic))
          visited.add(edge.to);
    }
    return [...visited].sort((a, b) => a - b);
  };
  const eager = closure(false),
    reachable = closure(true);
  const executable = records
    .filter((record) => record.role !== "SourceMap")
    .map((record) => record.index)
    .sort((a, b) => a - b);
  stage = "native-output-closure";
  assert.deepEqual(reachable, executable);
  const ownership: Record<
    string,
    { sourceInputs: number; outputIndexes: number[] }
  > = {};
  const sourceFiles = [
    "workers/api.entry.ts",
    "workers/api.ts",
    "src/raw-capture-sync.ts",
    ...Object.keys(candidateBlobs),
  ];
  stage = "native-raw-module-ownership";
  result.nativeBuild.rawModuleOwnership = ownership;
  for (const file of sourceFiles) {
    const matchingInputs = Object.keys(metafile.inputs).filter(
      (input) => path.resolve(root, input) === path.join(root, file),
    );
    ownership[file] = {
      sourceInputs: matchingInputs.length,
      outputIndexes: [],
    };
    assert.equal(matchingInputs.length, 1);
    const owners = [...outputs]
      .filter(([, value]) =>
        Object.entries(value.inputs).some(
          ([input, contribution]) =>
            matchingInputs.includes(input) && contribution.bytesInOutput > 0,
        ),
      )
      .map(([output]) => fileIndex.get(output)!);
    ownership[file].outputIndexes = owners;
    assert.equal(owners.length, 1);
    ownership[file] = {
      sourceInputs: matchingInputs.length,
      outputIndexes: owners,
    };
  }
  stage = "native-api-lazy-closure";
  assert.ok(
    ownership["workers/api.ts"].outputIndexes.every(
      (index) => !eager.includes(index),
    ),
  );
  stage = "native-wasm-identity";
  const expectedWasm = [
    {
      bytes: 1373887,
      sha256:
        "375e38603c5f5128a9a0e6e2ac90ac14f1b79a0f8b667eb434c2c1b18a031733",
    },
    {
      bytes: 88658,
      sha256:
        "47fb4f81d274932184cd19c75ed34f902d13f0519301590789a37f7077977e27",
    },
  ];
  const actualWasm = records
    .filter((record) => record.role === "CompiledWasm")
    .map(({ bytes, sha256 }) => ({ bytes, sha256 }))
    .sort((a, b) => a.sha256.localeCompare(b.sha256));
  assert.deepEqual(actualWasm, expectedWasm);
  for (const file of files.filter((file) => file.endsWith(".wasm"))) {
    const fd = openSync(file, "r"),
      magic = Buffer.alloc(8);
    try {
      assert.equal(readSync(fd, magic), 8);
      assert.deepEqual([...magic], [0, 97, 115, 109, 1, 0, 0, 0]);
    } finally {
      closeSync(fd);
    }
  }
  stage = "native-module-manifest";
  const manifest = {
    status: "complete",
    files: records,
    edges,
    entryIndex,
    eagerModuleIndexes: eager,
    reachableModuleIndexes: reachable,
    ownership,
  };
  const manifestBytes = JSON.stringify(manifest, null, 2) + "\n";
  assert.ok(Buffer.byteLength(manifestBytes) <= 131072);
  writeFileSync(
    path.join(reportDirectory, "module-manifest.json"),
    manifestBytes,
  );
  result.nativeBuild.moduleManifestSha256 = digest(manifestBytes);
  result.nativeBuild.metafileSha256 = digest(JSON.stringify(metafile));
  result.nativeBuild.outputSummary = {
    modules: executable.length,
    js: records.filter((record) => record.role === "ESModule").length,
    wasm: actualWasm.length,
    sourceMaps: records.filter((record) => record.role === "SourceMap").length,
    totalBytes,
  };
  result.nativeBuild.apiAbsentFromEntryEagerClosure = true;
  result.nativeBuild.rawModuleOwnership = ownership;
  result.bundleSha256 = records[entryIndex].sha256;
  result.bundler = {
    actualBuildApiWorker: true,
    unchangedNativeOptionsAndPlugin: true,
    split: true,
    minified: true,
    format: "esm",
    sourceMapsExecutable: false,
  };
  result.moduleLoader = {
    rules: [
      { type: "ESModule", include: ["**/*.js"] },
      { type: "CompiledWasm", include: ["**/*.wasm"] },
    ],
    verifiedWasm: expectedWasm,
    scope:
      "Complete identity-inventoried native module closure; source maps excluded from executable matching",
  };
  stage = "runtime-constructor";
  checkpoint();
  mf = new Miniflare({
    modules: true,
    modulesRoot: bundled,
    modulesRules: [
      { type: "ESModule", include: ["**/*.js"] },
      { type: "CompiledWasm", include: ["**/*.wasm"] },
    ],
    name: "resource-capture",
    scriptPath,
    host: "127.0.0.1",
    compatibilityDate: compatibleDate,
    compatibilityFlags,
    inspectorPort: 0,
    log: new NoOpLog(),
    handleStructuredLogs: (event) => {
      structuredLogs[
        ["info", "warn", "error", "debug"].includes(event.level)
          ? event.level
          : "other"
      ]++;
    },
    unsafeHandleRuntimeRestart: () => {
      runtimeRestarts++;
    },
    bindings: { RESOURCE_RPC_URL: LOGICAL_RPC_URL },
    d1Databases: ["D1_STATE"],
    outboundService: async (request) => {
      if (request.url !== LOGICAL_RPC_URL || request.method !== "POST") {
        blockedOutbound++;
        return new Response("blocked fixture outbound", { status: 503 });
      }
      const body = await request.text();
      assert.ok(Buffer.byteLength(body) <= 65536);
      permittedOutbound++;
      return fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    },
  });
  stage = "runtime-ready";
  checkpoint();
  await mf.ready;
  stage = "schema";
  checkpoint();
  const db = (await mf.getD1Database("D1_STATE")) as unknown as D1Database;
  await initializeSchema(db);
  const fetcher = await mf.getWorker();
  stage = "warmup";
  checkpoint();
  const warmup = await fetcher.fetch(
    "https://resource.invalid/__resource/warm",
  );
  assert.equal(warmup.status, 200);
  assert.deepEqual(await warmup.json(), { ready: true });
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
    (target) => target.id === "core:user:resource-capture",
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

  result.phases = [];
  const zeroHeap = { ...sampledHeap },
    zeroRss = { ...rss };
  async function measured(label: string, operation: () => Promise<unknown>) {
    sampledHeap = { ...zeroHeap };
    rss = { ...zeroRss };
    samplerStopped = false;
    stage = label;
    const phaseStarted = Date.now();
    await sample();
    const phase: Record<string, unknown> = {
      label,
      operationStartedAt: new Date(phaseStarted).toISOString(),
      initialHeap: { ...sampledHeap },
      initialRss: { ...rss },
    };
    result.phases.push(phase);
    checkpoint();
    sampler = (async () => {
      while (
        !samplerStopped &&
        sampledHeap.samples < 10000 &&
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
      phase.outcome = await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("fixture_deadline")),
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      samplerStopped = true;
      await sampler;
      await sample();
      phase.elapsedMs = Date.now() - phaseStarted;
      phase.heap = { ...sampledHeap };
      phase.rss = { ...rss };
      checkpoint();
    }
    return phase.outcome;
  }
  async function invoke(index: number, failure: boolean) {
    const response = await fetcher.fetch(
      "https://resource.invalid/__resource/capture",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ at: TIMES[index], failSecondWindow: failure }),
      },
    );
    const outcome = await response.json();
    if (failure) {
      assert.equal(response.status, 500);
      assert.deepEqual(outcome, {
        failureClass: "injected_second_window",
        faultHits: 1,
      });
    } else {
      assert.equal(response.status, 200);
      assert.deepEqual(outcome, {
        captured: 25,
        watermark: LAST,
        behind: 0,
        faultHits: 0,
      });
    }
    return { httpStatus: response.status, ...outcome };
  }
  if (scenario === "retry-high-entropy") {
    await measured("persistent-failure-original", () => invoke(0, true));
    stage = "first-reservation-proof";
    const first = await snapshot(db);
    assert.equal(first.batches.length, 1);
    const descriptor = first.batches[0];
    assert.ok(descriptor.parts > 8);
    assert.equal(descriptor.complete, 0);
    assert.equal(descriptor.raw_bytes, RAW_BYTES);
    assert.equal(descriptor.sha256, data.expected[0].sha256);
    assert.deepEqual(first.budget, {
      bytes: descriptor.compressed_bytes,
      objects: 1,
    });
    assert.equal(first.watermark, FIRST - 1);
    assert.equal(first.selected.length, 0);
    assert.equal(first.controls.length, 1);
    assert.deepEqual(first.chunks, [
      { sha256: descriptor.sha256, parts: 8, bytes: 8 * 65536 },
    ]);
    assert.equal(first.prefix.length, 8);
    assert.ok(first.prefix.every((part) => part.bytes === 65536));
    assert.equal(first.archives, 0);
    const { complete, ...originalDescriptor } = descriptor;
    assert.equal(first.controls[0].key, "raw-capture-retry/v1/mainnet");
    assert.equal(first.controls[0].provenanceCount, 25);
    assert.deepEqual(first.controls[0].descriptor, originalDescriptor);
    assert.equal(
      first.controls[0].provenanceSha256,
      digest(JSON.stringify(Array(25).fill(String(TIMES[0])))),
    );
    result.firstFailure = first;
    checkpoint();
    await measured("persistent-failure-fresh-provenance-recreated-writer", () =>
      invoke(1, true),
    );
    stage = "second-reservation-proof";
    const second = await snapshot(db);
    assert.deepEqual(second, first);
    result.secondFailure = second;
    checkpoint();
    await measured("resume-fresh-provenance-recreated-writer", () =>
      invoke(2, false),
    );
  } else await measured("fresh-capture", () => invoke(0, false));
  stage = "correctness";
  checkpoint();
  const final = await snapshot(db);
  result.correctness = {
    state: final,
    verification: await verifyStored(db, final, data.expected[0]),
  };
  assert.equal(rpcRequests, scenario === "retry-high-entropy" ? 9 : 3);
  assert.equal(permittedOutbound, rpcRequests);
  assert.equal(blockedOutbound, 0);
  assert.equal(result.rpcFixtureFailure, undefined);
  assert.equal(runtimeRestarts, 0);
  result.rpc = {
    logicalRpcUrl: LOGICAL_RPC_URL,
    logicalRole:
      "Reserved fixture name intercepted without DNS or external fetch",
    scope:
      "Mapped solely to exact owned loopback server with stripped headers, no redirects and finite timeout",
    permitted: permittedOutbound,
    blocked: blockedOutbound,
    requests: rpcRequests,
    responses: rpcReceipts,
  };
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failureStage = stage;
  diagnose(error);
  const allowed = new Set([
    "AssertionError",
    "Error",
    "TypeError",
    "RangeError",
    "MiniflareCoreError",
  ]);
  const kind = error instanceof Error ? error.constructor.name : "unclassified";
  result.failureClass = allowed.has(kind) ? kind : "unclassified";
  process.exitCode = 1;
} finally {
  samplerStopped = true;
  if (sampler) await sampler.catch(() => undefined);
  for (const socket of sockets) socket.terminate();
  if (mf) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        mf.dispose(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("fixture_cleanup_deadline")),
            20000,
          );
        }),
      ]);
    } catch {
      result.cleanupFailure = true;
      process.exitCode = 1;
    } finally {
      clearTimeout(timer);
    }
  }
  if (rpcServer) {
    rpcServer.closeAllConnections();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => rpcServer!.close(() => resolve())),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("fixture_server_cleanup_deadline")),
            3000,
          );
        }),
      ]);
    } catch {
      result.cleanupFailure = true;
      process.exitCode = 1;
    } finally {
      clearTimeout(timer);
    }
  }
  result.runtimeRestarts = runtimeRestarts;
  result.structuredLogCounts = structuredLogs;
  result.inspectorProtocolErrors = inspectorProtocolErrors;
  if (result.cleanupFailure) {
    result.status = "failed";
    result.failureStage ??= "cleanup";
    result.failureClass ??= "cleanup_failed";
  }
  result.elapsedMs = Date.now() - started;
  result.measurementScope = {
    heap: "Explicit marked full API user isolate; baseline included; each maximum is a sparse lower bound; external/embedder fields are separate and not added",
    process:
      "Actual workerd PID includes system and D1 isolates; Node driver is separate; HWM is cumulative across phases",
    excludes:
      "Independent stored-gzip verification after ingestion sampling; production scheduler, exact deployed bytes, uninstrumented topology and any upper-bound/isolate-limit acceptance",
  };
  const body = JSON.stringify(result, null, 2) + "\n";
  assert.ok(Buffer.byteLength(body) <= 65536);
  writeFileSync(
    path.join(reportDirectory, "driver.ts"),
    readFileSync(process.argv[1]),
  );
  writeFileSync(
    path.join(reportDirectory, "worker.ts"),
    readFileSync(".github/fixtures/raw-capture-resource-worker.ts"),
  );
  writeFileSync(path.join(reportDirectory, output), body);
  console.log(
    JSON.stringify({
      scenario,
      variant,
      status: result.status,
      failureStage: result.failureStage,
      phases: result.phases?.map((phase: any) => ({
        label: phase.label,
        heap: phase.heap,
        rss: phase.rss,
        elapsedMs: phase.elapsedMs,
      })),
      elapsedMs: result.elapsedMs,
    }),
  );
}
