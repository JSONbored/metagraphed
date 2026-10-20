import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createCipheriv, createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createGunzip } from "node:zlib";
import path from "node:path";
import { Miniflare, NoOpLog } from "miniflare";
import WebSocket from "ws";

const scenario = process.argv[2];
const variant = process.argv[3];
assert.ok(["fresh-compressible", "fresh-high-entropy", "retry-high-entropy"].includes(scenario));
assert.ok(["legacy", "candidate"].includes(variant));
assert.ok(scenario !== "retry-high-entropy" || variant === "candidate");
const base = "0a65fcffd51b0a6a2b9757905be02c1d8b859e6c";
// Keep exact verified native artifact bytes under .github only. Canonical
// runtime paths remain byte-identical to the deployed base on the carrier.
const nativeQualification = { runId: 39348983680, sourceCommit: "8afe1572c224dcfe0b4b41b4e2ca5058716a4352", artifactId: 12232566849, zipSha256: "d21753e26968c424aa6af1dac14b8a3ae2254bc14b33709e02167010c68485d5" };
const candidateBlobs = {
  "src/raw-capture-d1.ts": "2758ccf8c95a78ab3c4a2068f6b65caf811bed2e",
  "src/raw-chain-capture.ts": "285ad4bae1ed8108260bb71ace4753df16428120",
  "src/raw-capture-retry-intent.ts": "97a46b700a2078e1cf262ed80190beec4d79e376",
  "src/raw-capture-retry-store.ts": "5dd19a4b3114d227d8cd1f0c2fe7fb3039926f53",
};
const candidateHashes: Record<string, string> = {
  "src/raw-capture-d1.ts": "b7c86da367120a81186e7cab46e218a255bfa195c1205fcacd187e97767cac55",
  "src/raw-chain-capture.ts": "a017f2075d25aa955ff0cfca2845cc278408c82726cf5e8fe29d028079dc15ad",
  "src/raw-capture-retry-intent.ts": "59431bc97dc13d8b0ea4395e103b55fb4afba88f10789f8d1a21f385cb20b860",
  "src/raw-capture-retry-store.ts": "a19f5189eea2c2e09893961b9f606a23bcf7a927dedcb85fd51bbc99c99f794a",
};
const fixturePath = (file: string) => ".github/fixtures/raw-capture-candidate/" + file;
const carrierPaths = [
  ".github/scripts/qualify-raw-capture-resources.ts",
  ".github/fixtures/raw-capture-resource-worker.ts",
  ".github/workflows/raw-capture-resource-qualification.yml",
  ...Object.keys(candidateBlobs).map(fixturePath),
];
const legacyBlobs: Record<string, string> = {
  "src/raw-capture-d1.ts": "a2117ac28687f6e83b1c0c9f63d3c7996702cde1",
  "src/raw-chain-capture.ts": "ba70a0a49d560f013b5468cf022038f00dd58948",
};
const schemaPaths = ["migrations/d1/0027_generated_artifacts.sql", "migrations/d1/0028_raw_capture_storage.sql", "migrations/d1/0029_raw_capture_archive.sql"];
const root = process.cwd();
const reportDirectory = path.resolve("raw-capture-resource-reports");
mkdirSync(reportDirectory, { recursive: true });
const output = `${scenario}-${variant}.json`;
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const compatibleDate = "2026-06-06";
const compatibilityFlags = ["nodejs_compat", "global_fetch_strictly_public"];
const LOGICAL_RPC_URL = "https://rpc.fixture.invalid/rpc";
const result: Record<string, any> = {
  scenario, variant, sourceBase: base, nativeQualification,
  formattedDriverSha256: digest(readFileSync(process.argv[1])),
  workerFixtureSha256: digest(readFileSync(".github/fixtures/raw-capture-resource-worker.ts")),
  productionActions: false,
  startupGraph: "Full workers/api.ts retained; actual captureTick/rawCaptureD1/neonWatermark invoked directly, not production cron/runRawCaptureSync scheduling",
  fixtureScope: "Source-accepted synthetic RPC strings; not real SCALE or a finite maximum for currently unbounded RPC inputs",
  compatibilityDate: compatibleDate,
  compatibilityFlags,
  transportScope: { logicalRpcUrl: LOGICAL_RPC_URL, logicalRole: "Fixed reserved fixture endpoint; no DNS or external fetch", actualTransport: "Owned 127.0.0.1 server only; ephemeral port and address are not retained" },
};
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
        rpcObservation: { permitted: permittedOutbound, blocked: blockedOutbound, requests: rpcRequests, responses: rpcReceipts },
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
writeFileSync(path.join(reportDirectory, "worker.ts"), readFileSync(".github/fixtures/raw-capture-resource-worker.ts"));
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
  return { block_number: height, block_hash: hashAt(height), parent_hash: parentHash,
    header: { parentHash }, extrinsics: [], events, captured_at: at };
}
function fixture() {
  const emptyBytes = Array.from({ length: 25 }, (_, i) => Buffer.byteLength(JSON.stringify(row(FIRST + i, "", TIMES[0])) + "\n")).reduce((a, b) => a + b, 0);
  const padding = RAW_BYTES - emptyBytes;
  assert.ok(padding > 0);
  const events = scenario === "fresh-compressible" ? "x".repeat(padding) :
    createCipheriv("aes-256-ctr", Buffer.alloc(32, 11), Buffer.alloc(16, 13)).update(Buffer.alloc(Math.ceil(padding * 3 / 4))).toString("base64").slice(0, padding);
  const expected = TIMES.map(at => {
    const hash = createHash("sha256"); let bytes = 0;
    for (let i = 0; i < 25; i++) {
      const line = JSON.stringify(row(FIRST + i, i === 0 ? events : "", at)) + "\n";
      hash.update(line); bytes += Buffer.byteLength(line);
    }
    assert.equal(bytes, RAW_BYTES);
    return { at, bytes, sha256: hash.digest("hex") };
  });
  return { events, expected, padding, eventsSha256: digest(events) };
}

async function ownedRpc(data: ReturnType<typeof fixture>, eventsStorageKey: string) {
  rpcServer = createServer(async (request, response) => {
    try {
      assert.ok(["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? ""));
      assert.equal(request.method, "POST"); assert.equal(request.url, "/rpc");
      let body = "";
      for await (const chunk of request) { body += chunk.toString("utf8"); assert.ok(Buffer.byteLength(body) <= 65536); }
      const input = JSON.parse(body);
      const answer = (call: any) => {
        assert.equal(call.jsonrpc, "2.0");
        assert.ok(typeof call.id === "number" || typeof call.id === "string");
        let value: unknown;
        if (call.method === "chain_getHeader") { assert.deepEqual(call.params, []); value = { number: "0x" + LAST.toString(16) }; }
        else if (call.method === "chain_getBlockHash") { assert.deepEqual(call.params, [Array.from({ length: 25 }, (_, i) => FIRST + i)]); value = Array.from({ length: 25 }, (_, i) => hashAt(FIRST + i)); }
        else if (call.method === "chain_getBlock") {
          const height = Number.parseInt(call.params[0].slice(2), 16); assert.ok(height >= FIRST && height <= LAST);
          assert.deepEqual(call.params, [hashAt(height)]); value = { block: { header: { parentHash: hashAt(height - 1) }, extrinsics: [] } };
        } else if (call.method === "state_getStorage") {
          const height = Number.parseInt(call.params[1].slice(2), 16); assert.ok(height >= FIRST && height <= LAST);
          assert.equal(call.params.length, 2); assert.equal(call.params[0], eventsStorageKey); assert.equal(call.params[1], hashAt(height));
          value = height === FIRST ? data.events : "";
        } else throw new Error("fixture_rpc_method");
        return { jsonrpc: "2.0", id: call.id, result: value };
      };
      if (Array.isArray(input)) {
        assert.equal(input.length, 50);
        assert.equal(input.filter(c => c.method === "chain_getBlock").length, 25);
        assert.equal(input.filter(c => c.method === "state_getStorage").length, 25);
      }
      const payload = JSON.stringify(Array.isArray(input) ? input.map(answer) : answer(input));
      rpcRequests++;
      assert.ok(rpcReceipts.length < 16);
      rpcReceipts.push({ calls: Array.isArray(input) ? input.length : 1, bytes: Buffer.byteLength(payload), sha256: digest(payload) });
      if (Date.now() - lastCheckpoint >= 1000) checkpoint();
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }); response.end(payload);
    } catch {
      result.rpcFixtureFailure = true;
      response.writeHead(500, { "content-type": "application/json" }); response.end('{"fixtureFailure":true}');
    }
  });
  rpcServer.maxConnections = 4;
  rpcServer.headersTimeout = 5000; rpcServer.requestTimeout = 15000;
  rpcServer.listen(0, "127.0.0.1"); await once(rpcServer, "listening");
  const address = rpcServer.address(); assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}/rpc`;
}

async function initializeSchema(db: D1Database) {
  const reference = new DatabaseSync(":memory:");
  try {
    const receipt: Record<string, string> = {};
    for (const file of schemaPaths) { const sql = readFileSync(file, "utf8"); receipt[file] = digest(sql); reference.exec(sql); }
    const schema = readFileSync("db/d1-schema.sql", "utf8");
    const state = /CREATE TABLE raw_capture_state[\s\S]*?;/.exec(schema); assert.ok(state);
    reference.exec(state[0]); receipt["db/d1-schema.sql"] = digest(schema); receipt["raw_capture_state DDL"] = digest(state[0]);
    const ddl = reference.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as { type: string; name: string; sql: string }[];
    for (const object of ddl) await db.prepare(object.sql).run();
    const seed = /INSERT INTO raw_capture_budget\(id\) VALUES\(1\);/.exec(readFileSync(schemaPaths[1], "utf8")); assert.ok(seed);
    await db.prepare(seed[0]).run();
    const sort = (rows: any[]) => rows.map(row => ({ type: row.type, name: row.name, sql: row.sql })).sort((a, b) => (a.type + a.name).localeCompare(b.type + b.name));
    const actual = await db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all();
    assert.deepEqual(sort(actual.results), sort(ddl));
    const budget = await db.prepare("SELECT id,bytes,objects FROM raw_capture_budget").all();
    assert.deepEqual(budget.results, reference.prepare("SELECT id,bytes,objects FROM raw_capture_budget").all().map(row => ({ ...row })));
    assert.equal(await db.prepare("PRAGMA foreign_keys").first<number>("foreign_keys"), 1);
    result.schemaReceipt = { sourceHashes: receipt, canonicalSchemaSha256: digest(JSON.stringify(sort(ddl))), fullNativeEquality: true, seedEquality: true, nativeForeignKeys: true };
    await db.prepare("INSERT INTO raw_capture_state(network,last_contiguous_block,updated_at) VALUES(?,?,?)").bind("mainnet", FIRST - 1, TIMES[0] - 1000).run();
  } finally { reference.close(); }
}

async function snapshot(db: D1Database) {
  const batches = (await db.prepare("SELECT * FROM raw_capture_batches ORDER BY key,sha256").all()).results as Record<string, any>[];
  assert.ok(batches.length <= 2);
  const budget = await db.prepare("SELECT bytes,objects FROM raw_capture_budget WHERE id=1").first();
  const chunks = (await db.prepare("SELECT sha256,count(*) parts,sum(length(data)) bytes FROM raw_capture_chunks GROUP BY sha256 ORDER BY sha256").all()).results;
  const selected = (await db.prepare("SELECT key,sha256 FROM raw_capture_selected ORDER BY key").all()).results;
  const watermark = await db.prepare("SELECT last_contiguous_block FROM raw_capture_state WHERE network='mainnet'").first<number>("last_contiguous_block");
  const controls = (await db.prepare("SELECT key,payload FROM generated_artifacts ORDER BY key").all()).results as { key: string; payload: string }[];
  assert.ok(controls.length <= 1);
  const prefix = [];
  for (const batch of batches) {
    const rows = await db.prepare("SELECT part,hex(data) data FROM raw_capture_chunks WHERE key=? AND sha256=? AND part<8 ORDER BY part").bind(batch.key, batch.sha256).all<{ part: number; data: string }>();
    assert.ok(rows.results.length <= 8);
    for (const [index, stored] of rows.results.entries()) {
      assert.equal(stored.part, index); assert.match(stored.data, /^[0-9A-F]+$/); assert.ok(stored.data.length <= 2 * 65536);
      const bytes = Buffer.from(stored.data, "hex");
      prefix.push({ sha256: batch.sha256, part: stored.part, bytes: bytes.length, dataSha256: digest(bytes) });
    }
  }
  const archives = await db.prepare("SELECT count(*) n FROM raw_capture_archives").first<number>("n");
  return { batches, budget, chunks, prefix, selected, watermark, archives, controls: controls.map(control => {
    assert.ok(Buffer.byteLength(control.payload) <= 96 * 1024);
    const parsed = JSON.parse(control.payload);
    return { key: control.key, payloadSha256: digest(control.payload), bytes: Buffer.byteLength(control.payload), descriptor: parsed.descriptor, provenanceCount: parsed.provenance.length, provenanceSha256: digest(JSON.stringify(parsed.provenance)) };
  }) };
}

async function verifyStored(db: D1Database, state: Awaited<ReturnType<typeof snapshot>>, expected: { at: number; bytes: number; sha256: string }) {
  assert.equal(state.batches.length, 1);
  const descriptor = state.batches[0];
  assert.equal(descriptor.key, rawKey); assert.equal(descriptor.network, "mainnet");
  assert.equal(descriptor.first_block, FIRST); assert.equal(descriptor.last_block, LAST);
  assert.equal(descriptor.sha256, expected.sha256); assert.equal(descriptor.raw_bytes, RAW_BYTES);
  assert.equal(descriptor.captured_at, expected.at); assert.equal(descriptor.complete, 1);
  assert.deepEqual(state.budget, { bytes: descriptor.compressed_bytes, objects: 1 });
  assert.equal(state.watermark, LAST); assert.equal(state.controls.length, 0); assert.equal(state.archives, 0);
  assert.deepEqual(state.selected, [{ key: rawKey, sha256: expected.sha256 }]);
  assert.deepEqual(state.chunks, [{ sha256: expected.sha256, parts: descriptor.parts, bytes: descriptor.compressed_bytes }]);
  const compressedHash = createHash("sha256"), rawHash = createHash("sha256");
  let compressedBytes = 0, rawBytes = 0, lines = 0;
  const inflater = createGunzip();
  let readerFailure = false;
  const consumed = (async () => { for await (const chunk of inflater) {
    rawBytes += chunk.length; assert.ok(rawBytes <= RAW_BYTES); rawHash.update(chunk);
    for (const byte of chunk) if (byte === 10) lines++;
  } })().then(() => undefined, () => { readerFailure = true; });
  try {
    for (let start = 0; start < descriptor.parts; start += 8) {
      const rows = await db.prepare("SELECT part,hex(data) data FROM raw_capture_chunks WHERE key=? AND sha256=? AND part>=? AND part<? ORDER BY part").bind(rawKey, expected.sha256, start, Math.min(descriptor.parts, start + 8)).all<{ part: number; data: string }>();
      assert.equal(rows.results.length, Math.min(8, descriptor.parts - start));
      for (const [index, stored] of rows.results.entries()) {
        assert.equal(stored.part, start + index); assert.match(stored.data, /^[0-9A-F]+$/); assert.ok(stored.data.length <= 2 * 65536);
        const bytes = Buffer.from(stored.data, "hex");
        assert.equal(bytes.length, Math.min(65536, descriptor.compressed_bytes - stored.part * 65536));
        compressedBytes += bytes.length; compressedHash.update(bytes);
        await new Promise<void>((resolve, reject) => inflater.write(bytes, error => error ? reject(new Error("fixture_gzip_verification")) : resolve()));
        assert.equal(readerFailure, false, "gzip verification reader succeeded");
      }
    }
    inflater.end(); await consumed;
    assert.equal(readerFailure, false, "gzip verification reader succeeded");
  } finally {
    inflater.destroy(); await consumed;
  }
  assert.equal(compressedBytes, descriptor.compressed_bytes);
  assert.equal(compressedHash.digest("hex"), descriptor.compressed_sha256);
  assert.equal(rawBytes, RAW_BYTES); assert.equal(rawHash.digest("hex"), expected.sha256); assert.equal(lines, 25);
  return { descriptor, rawBytes, records: lines, compressedBytes, rawSha256: expected.sha256, compressedSha256: descriptor.compressed_sha256, independentGunzipVerified: true };
}

try {
  const runtimeInputs = ["src", "workers", "schemas-src", "schemas", "generated", "db", "migrations", "package.json", "package-lock.json", "wrangler.jsonc", "wrangler.data.jsonc"];
  const changed = execFileSync("git", ["diff", "--name-only", base, "HEAD"], { encoding: "utf8", maxBuffer: 65536 }).trim().split("\n").filter(Boolean).sort();
  assert.deepEqual(changed, [...carrierPaths].sort(), "only seven isolated .github carrier files differ");
  execFileSync("git", ["diff", "--exit-code", base, "HEAD", "--", ...runtimeInputs], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 65536 });
  const workingChanged = execFileSync("git", ["diff", "--name-only", base], { encoding: "utf8", maxBuffer: 65536 }).trim().split("\n").filter(Boolean).sort();
  assert.deepEqual(workingChanged, [...carrierPaths].sort(), "install and formatting did not alter other tracked inputs");
  execFileSync("git", ["diff", "--exit-code", base, "--", ...runtimeInputs], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 65536 });
  result.carrierCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  result.sourceTree = execFileSync("git", ["rev-parse", `${base}^{tree}`], { encoding: "utf8" }).trim();
  result.runtimeInputManifestSha256 = digest(execFileSync("git", ["ls-tree", "-r", base, "--", ...runtimeInputs], { maxBuffer: 2 * 1024 * 1024 }));
  result.carrierRuntimeInputManifestSha256 = digest(execFileSync("git", ["ls-tree", "-r", "HEAD", "--", ...runtimeInputs], { maxBuffer: 2 * 1024 * 1024 }));
  assert.equal(result.carrierRuntimeInputManifestSha256, result.runtimeInputManifestSha256);
  result.canonicalRuntimeUnchanged = true;
  result.sourceOverlayScope = "Verified .github fixture source copied only into this disposable job checkout before bundling";
  const productionConfig = readFileSync("wrangler.jsonc", "utf8");
  const productionConfigBlob = execFileSync("git", ["rev-parse", "HEAD:wrangler.jsonc"], { encoding: "utf8" }).trim();
  assert.equal(productionConfigBlob, "6624787c6bb26130e7a6d1d18e685e0b0f1d8ccf");
  const flagSource = /"compatibility_flags"\s*:\s*(\[[^\]]*\])/.exec(productionConfig);
  const dateSource = /"compatibility_date"\s*:\s*"([0-9-]+)"/.exec(productionConfig);
  assert.ok(flagSource && dateSource);
  assert.deepEqual(JSON.parse(flagSource[1]), compatibilityFlags); assert.equal(dateSource[1], compatibleDate);
  result.productionCompatibilitySource = { source: "wrangler.jsonc", sourceBase: base, blob: productionConfigBlob, sha256: digest(productionConfig), flags: compatibilityFlags, date: compatibleDate };
  result.sourceReceipt = {};
  for (const [file, candidateBlob] of Object.entries(candidateBlobs)) {
    const fixture = fixturePath(file);
    assert.equal(execFileSync("git", ["rev-parse", `HEAD:${fixture}`], { encoding: "utf8" }).trim(), candidateBlob);
    assert.equal(digest(readFileSync(fixture)), candidateHashes[file]);
    const legacy = variant === "legacy" && Object.hasOwn(legacyBlobs, file);
    const ref = legacy ? base : result.carrierCommit;
    const expectedBlob = legacy ? legacyBlobs[file] : candidateBlob;
    const sourcePath = legacy ? file : fixture;
    const blob = execFileSync("git", ["rev-parse", `${ref}:${sourcePath}`], { encoding: "utf8" }).trim();
    assert.equal(blob, expectedBlob);
    const source = execFileSync("git", ["show", `${ref}:${sourcePath}`]);
    writeFileSync(file, source); result.sourceReceipt[file] = { ref, sourcePath, blob, sha256: digest(source), importedByLegacyWriter: variant === "legacy" && file.includes("retry-") ? false : undefined };
  }
  result.workerSha256 = digest(readFileSync("workers/api.ts"));
  stage = "fixture"; checkpoint();
  const data = fixture();
  result.fixture = { records: 25, rawBytes: RAW_BYTES, first: FIRST, last: LAST, eventsBytes: data.padding, eventsSha256: data.eventsSha256, entropy: scenario === "fresh-compressible" ? "repeated ASCII" : "deterministic AES-CTR base64", expected: data.expected };
  const { SYSTEM_EVENTS_STORAGE_KEY } = await import(path.join(root, "src/twox-storage-key.ts"));
  result.fixture.eventsStorageKey = SYSTEM_EVENTS_STORAGE_KEY;
  const rpcUrl = await ownedRpc(data, SYSTEM_EVENTS_STORAGE_KEY);
  stage = "bundle"; checkpoint();
  const scratch = path.resolve(".raw-capture-resource"); const bundled = path.join(scratch, "bundle"); mkdirSync(bundled, { recursive: true });
  const configPath = path.join(scratch, "wrangler.json");
  writeFileSync(configPath, JSON.stringify({ name: "resource-capture", main: path.resolve(".github/fixtures/raw-capture-resource-worker.ts"), compatibility_date: compatibleDate, compatibility_flags: compatibilityFlags }));
  const bundle = spawnSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "deploy", "--dry-run", "--config", configPath, "--outdir", bundled], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 90000, maxBuffer: 256 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false", CI: "true", BROWSER: "false" } });
  assert.equal(bundle.error, undefined); assert.equal(bundle.status, 0);
  const entries = readdirSync(bundled).filter(file => file.endsWith(".js")); assert.equal(entries.length, 1);
  const scriptPath = path.join(bundled, entries[0]); result.bundleSha256 = digest(readFileSync(scriptPath));
  result.bundler = { nativeWranglerDryRun: true, stdoutRetained: false, stderrRetained: false };
  stage = "runtime-constructor"; checkpoint();
  mf = new Miniflare({
    modules: true, name: "resource-capture", scriptPath, host: "127.0.0.1", compatibilityDate: compatibleDate, compatibilityFlags, inspectorPort: 0,
    log: new NoOpLog(), handleStructuredLogs: event => { structuredLogs[["info", "warn", "error", "debug"].includes(event.level) ? event.level : "other"]++; },
    unsafeHandleRuntimeRestart: () => { runtimeRestarts++; }, bindings: { RESOURCE_RPC_URL: LOGICAL_RPC_URL }, d1Databases: ["D1_STATE"],
    outboundService: async request => {
      if (request.url !== LOGICAL_RPC_URL || request.method !== "POST") { blockedOutbound++; return new Response("blocked fixture outbound", { status: 503 }); }
      const body = await request.text(); assert.ok(Buffer.byteLength(body) <= 65536); permittedOutbound++;
      return fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body, redirect: "error", signal: AbortSignal.timeout(15000) });
    },
  });
  stage = "runtime-ready"; checkpoint(); await mf.ready;
  stage = "schema"; checkpoint(); const db = await mf.getD1Database("D1_STATE") as unknown as D1Database; await initializeSchema(db);
  const fetcher = await mf.getWorker();
  stage = "warmup"; checkpoint(); const warmup = await fetcher.fetch("https://resource.invalid/__resource/warm"); assert.equal(warmup.status, 200); assert.deepEqual(await warmup.json(), { ready: true });
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
  const zeroHeap = { ...sampledHeap }, zeroRss = { ...rss };
  async function measured(label: string, operation: () => Promise<unknown>) {
    sampledHeap = { ...zeroHeap }; rss = { ...zeroRss }; samplerStopped = false;
    stage = label; const phaseStarted = Date.now(); await sample();
    const phase: Record<string, unknown> = { label, operationStartedAt: new Date(phaseStarted).toISOString(), initialHeap: { ...sampledHeap }, initialRss: { ...rss } }; result.phases.push(phase); checkpoint();
    sampler = (async () => { while (!samplerStopped && sampledHeap.samples < 10000 && Date.now() < deadline) { try { await sample(); } catch { sampledHeap.errors++; } await pause(25); } })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { phase.outcome = await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("fixture_deadline")), Math.max(1, deadline - Date.now())); })]); }
    finally { clearTimeout(timer); samplerStopped = true; await sampler; await sample(); phase.elapsedMs = Date.now() - phaseStarted; phase.heap = { ...sampledHeap }; phase.rss = { ...rss }; checkpoint(); }
    return phase.outcome;
  }
  async function invoke(index: number, failure: boolean) {
    const response = await fetcher.fetch("https://resource.invalid/__resource/capture", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ at: TIMES[index], failSecondWindow: failure }) });
    const outcome = await response.json();
    if (failure) { assert.equal(response.status, 500); assert.deepEqual(outcome, { failureClass: "injected_second_window", faultHits: 1 }); }
    else { assert.equal(response.status, 200); assert.deepEqual(outcome, { captured: 25, watermark: LAST, behind: 0, faultHits: 0 }); }
    return { httpStatus: response.status, ...outcome };
  }
  if (scenario === "retry-high-entropy") {
    await measured("persistent-failure-original", () => invoke(0, true));
    stage = "first-reservation-proof"; const first = await snapshot(db);
    assert.equal(first.batches.length, 1); const descriptor = first.batches[0]; assert.ok(descriptor.parts > 8); assert.equal(descriptor.complete, 0); assert.equal(descriptor.raw_bytes, RAW_BYTES); assert.equal(descriptor.sha256, data.expected[0].sha256);
    assert.deepEqual(first.budget, { bytes: descriptor.compressed_bytes, objects: 1 }); assert.equal(first.watermark, FIRST - 1); assert.equal(first.selected.length, 0); assert.equal(first.controls.length, 1);
    assert.deepEqual(first.chunks, [{ sha256: descriptor.sha256, parts: 8, bytes: 8 * 65536 }]);
    assert.equal(first.prefix.length, 8); assert.ok(first.prefix.every(part => part.bytes === 65536)); assert.equal(first.archives, 0);
    const { complete, ...originalDescriptor } = descriptor;
    assert.equal(first.controls[0].key, "raw-capture-retry/v1/mainnet"); assert.equal(first.controls[0].provenanceCount, 25);
    assert.deepEqual(first.controls[0].descriptor, originalDescriptor);
    assert.equal(first.controls[0].provenanceSha256, digest(JSON.stringify(Array(25).fill(String(TIMES[0])))));
    result.firstFailure = first; checkpoint();
    await measured("persistent-failure-fresh-provenance-recreated-writer", () => invoke(1, true));
    stage = "second-reservation-proof"; const second = await snapshot(db); assert.deepEqual(second, first); result.secondFailure = second; checkpoint();
    await measured("resume-fresh-provenance-recreated-writer", () => invoke(2, false));
  } else await measured("fresh-capture", () => invoke(0, false));
  stage = "correctness"; checkpoint(); const final = await snapshot(db); result.correctness = { state: final, verification: await verifyStored(db, final, data.expected[0]) };
  assert.equal(rpcRequests, scenario === "retry-high-entropy" ? 9 : 3); assert.equal(permittedOutbound, rpcRequests); assert.equal(blockedOutbound, 0); assert.equal(result.rpcFixtureFailure, undefined); assert.equal(runtimeRestarts, 0);
  result.rpc = { logicalRpcUrl: LOGICAL_RPC_URL, logicalRole: "Reserved fixture name intercepted without DNS or external fetch", scope: "Mapped solely to exact owned loopback server with stripped headers, no redirects and finite timeout", permitted: permittedOutbound, blocked: blockedOutbound, requests: rpcRequests, responses: rpcReceipts };
  result.status = "passed";
} catch (error) {
  result.status = "failed"; result.failureStage = stage;
  const allowed = new Set(["AssertionError", "Error", "TypeError", "RangeError", "MiniflareCoreError"]);
  const kind = error instanceof Error ? error.constructor.name : "unclassified";
  result.failureClass = allowed.has(kind) ? kind : "unclassified"; process.exitCode = 1;
} finally {
  samplerStopped = true; if (sampler) await sampler.catch(() => undefined);
  for (const socket of sockets) socket.terminate();
  if (mf) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([mf.dispose(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("fixture_cleanup_deadline")), 20000); })]); }
    catch { result.cleanupFailure = true; process.exitCode = 1; }
    finally { clearTimeout(timer); }
  }
  if (rpcServer) {
    rpcServer.closeAllConnections();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([new Promise<void>(resolve => rpcServer!.close(() => resolve())), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("fixture_server_cleanup_deadline")), 3000); })]); }
    catch { result.cleanupFailure = true; process.exitCode = 1; }
    finally { clearTimeout(timer); }
  }
  result.runtimeRestarts = runtimeRestarts; result.structuredLogCounts = structuredLogs; result.inspectorProtocolErrors = inspectorProtocolErrors;
  if (result.cleanupFailure) { result.status = "failed"; result.failureStage ??= "cleanup"; result.failureClass ??= "cleanup_failed"; }
  result.elapsedMs = Date.now() - started;
  result.measurementScope = { heap: "Explicit marked full API user isolate; baseline included; each maximum is a sparse lower bound; external/embedder fields are separate and not added", process: "Actual workerd PID includes system and D1 isolates; Node driver is separate; HWM is cumulative across phases", excludes: "Independent stored-gzip verification after ingestion sampling; production scheduler and any upper-bound/isolate-limit acceptance" };
  const body = JSON.stringify(result, null, 2) + "\n"; assert.ok(Buffer.byteLength(body) <= 65536);
  writeFileSync(path.join(reportDirectory, "driver.ts"), readFileSync(process.argv[1]));
  writeFileSync(path.join(reportDirectory, "worker.ts"), readFileSync(".github/fixtures/raw-capture-resource-worker.ts"));
  writeFileSync(path.join(reportDirectory, output), body);
  console.log(JSON.stringify({ scenario, variant, status: result.status, failureStage: result.failureStage, phases: result.phases?.map((phase: any) => ({ label: phase.label, heap: phase.heap, rss: phase.rss, elapsedMs: phase.elapsedMs })), elapsedMs: result.elapsedMs }));
}
