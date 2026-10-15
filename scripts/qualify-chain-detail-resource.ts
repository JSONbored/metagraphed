// Finite synthetic Workerd measurements. No production bindings or RPCs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  open,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { Miniflare } from "miniflare";
import { CHAIN_DETAIL_SYNC_MAX_BODY_BYTES } from "../src/chain-detail-sync-payload.ts";
import { parseChainDetailSync } from "../src/chain-detail-sync-payload.ts";
import { restoreChainDetailPayloads } from "../src/chain-detail-payloads.ts";
import {
  packSyncBatchMessages,
  type SyncBatchLane,
  SYNC_BATCH_MAX_BYTES,
} from "../src/sync-batch-queue.ts";
import { makeSyncDelivery } from "../src/sync-delivery-receipt.ts";
import { captureUpsertStatements } from "../src/capture-family-d1.ts";
import { NOMINATOR_POSITIONS_CONFLICT } from "../src/nominator-positions-neon-write.ts";
import { PASS_TABLES } from "../src/pass-completeness.ts";
import { chainDetailTables } from "../src/chain-detail-neon-write.ts";
import { stripJsonComments } from "./lib.ts";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  compressSyncBatchMessage,
  SYNC_BATCH_MAX_DECODED_BYTES,
  SyncBatchSizeError,
} from "../src/sync-batch-compress.ts";

const cpuProfiles = process.env.CHAIN_DETAIL_RESOURCE_CPU_PROFILES !== "false";
const nativeOracle =
  process.env.CHAIN_DETAIL_RESOURCE_NATIVE_ORACLE !== "false";
const separateHttpPhases =
  process.env.CHAIN_DETAIL_RESOURCE_SEPARATE_HTTP_PHASES === "true";
const output = path.resolve("reports/chain-detail-resource");
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(tmpdir(), "chain-detail-resource-"));
const report: Record<string, unknown> = {
  source_head: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  status: "incomplete",
  driver_exec_argv: process.execArgv,
  cpu_profiles_enabled: cpuProfiles,
  separate_http_phases: separateHttpPhases,
  process_lifetime: separateHttpPhases
    ? "fresh application Workerd per dispatch, stopped before separate persisted-D1 verification Workerd"
    : "original warm application/D1/verifier Workerd",
  phase_comparison_limits: [
    "application dispatch still includes native D1/helper allocations in its Workerd process",
    "fresh application lifetime changes cache/retention; compare with original warm mode",
    "one unchanged 512MiB scope bounds sequential processes; its memory.peak is cumulative",
    "isolate samples can miss synchronous peaks and do not implement production limits",
  ],
  database_verifier: nativeOracle
    ? "native-fixture-worker"
    : "node-binding-proxy",

  scope: "synthetic native Workerd, actual dry-run data-api bundle and D1",
  exclusions: [
    "true synchronous heap peak",
    "production CPU/memory limit enforcement",
    "Cloudflare billed CPU",
    "native queue scheduling/concurrency parity",
    "production workload representativeness",
    "production HTTP concurrency/backpressure and sustained throughput",
  ],
  batches: {
    messages: 1,
    simultaneous_calls:
      process.env.CHAIN_DETAIL_RESOURCE_SHAPE === "http-concurrent" ? 2 : 1,
    scheduling: "driver-imposed, not Miniflare max_concurrency",
  },
  load_identity:
    "finite first insert, distinct fresh insert, changed-row rollback, repair and oversized DLQ recovery",
  observations: [],
};
const observations = report.observations as unknown[];
const save = () =>
  writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
// Linux's process high-water mark survives missed synchronous allocations.
// This includes every isolate and native allocation in the Workerd process;
// it is an upper observation, not Cloudflare's per-isolate accounting.
async function processMemory() {
  const results = [];
  const scope = await readFile("/proc/self/cgroup", "utf8");
  for (const pid of (await readdir("/proc")).filter((name) =>
    /^\d+$/.test(name),
  )) {
    try {
      const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
      if (!command.split("\0")[0].endsWith("/workerd")) continue;
      const membership = await readFile(`/proc/${pid}/cgroup`, "utf8");
      if (membership !== scope) continue;
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const mapping = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
      const mappingKiB = Object.fromEntries(
        [
          ...mapping.matchAll(
            /^(Rss|Pss|Anonymous|Private_Dirty|Shared_Clean|Swap):\s+(\d+)/gm,
          ),
        ].map((match) => [match[1], Number(match[2])]),
      );
      const fields = Object.fromEntries(
        [...status.matchAll(/^(VmRSS|VmHWM|Threads):\s+(\d+)/gm)].map(
          (match) => [match[1], Number(match[2])],
        ),
      );
      results.push({
        pid: Number(pid),
        cgroup: membership.trim(),
        rss_kib: fields.VmRSS,
        high_water_kib: fields.VmHWM,
        threads: fields.Threads,
        mapping_kib: mappingKiB,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  assert.equal(results.length, 1, "one native Workerd process required");
  return results[0];
}

async function nativeLimits() {
  const membership = await readFile("/proc/self/cgroup", "utf8");
  const relative = membership.trim().match(/^0::(\/.*)$/m)?.[1];
  assert.ok(relative && !relative.includes(".."), "cgroup v2 scope required");
  const root = path.join("/sys/fs/cgroup", relative);
  const fields: Record<string, string> = {};
  for (const name of [
    "memory.max",
    "memory.swap.max",
    "memory.peak",
    "memory.current",
    "memory.stat",
    "memory.events",
    "pids.max",
    "pids.current",
    "cpu.max",
  ])
    fields[name] = (await readFile(path.join(root, name), "utf8")).trim();
  assert.equal(fields["memory.max"], "536870912");
  assert.equal(fields["memory.swap.max"], "0");
  assert.equal(fields["pids.max"], "128");
  assert.equal(fields["cpu.max"], "200000 100000");
  return { scope: relative, fields };
}

const stamp = 1_790_090_000_000;

interface ResourceMessage {
  lane: "chain-detail";
  captured_at: number;
  families: {
    blockRows: Record<string, unknown>[];
    extrinsicRows: Record<string, unknown>[];
    chainEventRows: Record<string, unknown>[];
    accountEventRows: Record<string, unknown>[];
  };
}

function httpBody(message: ResourceMessage): string {
  return JSON.stringify({
    blocks: message.families.blockRows.map((block) => ({
      ...block,
      extrinsics: message.families.extrinsicRows
        .filter((row) => row.block_number === block.block_number)
        .map((row) => ({
          ...row,
          success: row.success === null ? null : Boolean(row.success),
        })),
      chain_events: message.families.chainEventRows.filter(
        (row) => row.block_number === block.block_number,
      ),
      account_events: message.families.accountEventRows.filter(
        (row) => row.block_number === block.block_number,
      ),
    })),
  });
}

// Deterministic JSON-safe high-entropy text: unlike repeated x, it must use
// nonempty native payload chunks after gzip, while fitting the queue wire cap.
function chunkArgument(): string {
  let seed = 0x12345678;
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  let value = "";
  for (let i = 0; i < 160_000; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    value += alphabet[seed >>> 26];
  }
  return JSON.stringify({ value });
}

function payload(shape: string, block = 9_000_001): ResourceMessage {
  const parsed = parseChainDetailSync(
    {
      blocks: [
        {
          block_number: block,
          block_hash: `0x${"ab".repeat(32)}`,
          observed_at: stamp,
          spec_version: 291,
          extrinsics: [
            {
              block_number: block,
              extrinsic_index: 0,
              extrinsic_hash: `0x${"cd".repeat(32)}`,
              signer: null,
              call_module: "Timestamp",
              call_function: "set",
              success:
                shape === "objects"
                  ? true
                  : shape === "objects-max"
                    ? false
                    : null,
              fee_tao: null,
              tip_tao: null,
              call_args: null,
              observed_at: stamp,
            },
          ],
          chain_events: Array.from(
            {
              length:
                shape === "chunks-http"
                  ? 4_999
                  : shape === "http-envelope"
                    ? 79_998
                    : shape === "objects-max"
                      ? 23_000
                      : shape === "objects"
                        ? 12_000
                        : shape === "objects-admitted"
                          ? 4_998
                          : shape === "objects-repair"
                            ? 3_000
                            : 0,
            },
            (_, i) => ({
              block_number: block,
              event_index: i,
              pallet: "System",
              method: "ExtrinsicSuccess",
              args: null,
              phase: "Initialization",
              extrinsic_index: null,
              observed_at: stamp,
            }),
          ),
          account_events: [
            {
              block_number: block,
              event_index: 0,
              extrinsic_index: 0,
              event_kind: "Transfer",
              hotkey: null,
              coldkey: null,
              netuid: null,
              uid: null,
              amount_tao: "0.000000001",
              alpha_amount: null,
              observed_at: stamp,
            },
          ],
        },
      ],
    },
    stamp,
  );
  assert.ok(parsed.ok);
  const { head: _head, ...families } = parsed.rows;
  const message: ResourceMessage = {
    lane: "chain-detail",
    captured_at: stamp,
    families,
  };
  if (shape.startsWith("chunks"))
    families.extrinsicRows[0].call_args = chunkArgument();
  if (shape === "http-envelope") {
    families.extrinsicRows[0].call_args = JSON.stringify({ s: "" });
    const remaining =
      CHAIN_DETAIL_SYNC_MAX_BODY_BYTES - Buffer.byteLength(httpBody(message));
    assert.ok(
      remaining > 0,
      "all80000 detail rows must fit supported HTTP envelope",
    );
    families.extrinsicRows[0].call_args = JSON.stringify({
      s: "x".repeat(remaining),
    });
    assert.equal(
      Buffer.byteLength(httpBody(message)),
      CHAIN_DETAIL_SYNC_MAX_BODY_BYTES,
    );
  }
  if (shape === "http-concurrent") {
    const parts = [
      payload("http-envelope", block),
      payload("http-envelope", block + 100_000),
    ];
    for (const name of Object.keys(families) as Array<keyof typeof families>)
      families[name] = parts.flatMap((part) => part.families[name]);
  }
  if (shape === "string") {
    // Near the decoded byte ceiling; leave space for the JSON envelope.
    families.extrinsicRows[0].call_args = JSON.stringify({
      s: "x".repeat(SYNC_BATCH_MAX_DECODED_BYTES - 4_096),
    });
  }
  if (shape === "objects-max" || shape === "objects-admitted") {
    const remaining =
      SYNC_BATCH_MAX_DECODED_BYTES -
      Buffer.byteLength(JSON.stringify(message)) -
      4_096;
    assert.ok(remaining > 0);
    families.extrinsicRows[0].call_args = JSON.stringify({
      s: "x".repeat(remaining),
    });
  }
  if (shape === "blocks16") {
    const parts = Array.from({ length: 16 }, (_, index) =>
      payload("small", block + index * 100),
    );
    for (const name of Object.keys(families) as Array<keyof typeof families>)
      families[name] = parts.flatMap((part) => part.families[name]);
  }
  return message;
}

// Same exact16MB/80000-detail request workload, materialized incrementally.
// Only fixture-driver retention changes: the API still parses every byte/row.
async function writeHttpEnvelope(
  filePath: string,
  block: number,
  observedAt: number,
) {
  const base = payload("small", block);
  const blockRow = {
    ...base.families.blockRows[0],
    chain_event_count: 79_998,
    observed_at: observedAt,
  };
  const extrinsic = {
    ...base.families.extrinsicRows[0],
    observed_at: observedAt,
    call_args: JSON.stringify({ s: "" }),
  };
  const account = {
    ...base.families.accountEventRows[0],
    observed_at: observedAt,
  };
  const event = (index: number) =>
    JSON.stringify({
      block_number: block,
      event_index: index,
      pallet: "System",
      method: "ExtrinsicSuccess",
      args: null,
      phase: "Initialization",
      extrinsic_index: null,
      observed_at: observedAt,
    });
  const prefix = () =>
    `{"blocks":[${JSON.stringify(blockRow).slice(0, -1)},"extrinsics":[${JSON.stringify(extrinsic)}],"chain_events":[`;
  const suffix = `],"account_events":[${JSON.stringify(account)}]}]}`;
  let eventBytes = 79_997; // commas between79998 rows
  for (let index = 0; index < 79_998; index++)
    eventBytes += Buffer.byteLength(event(index));
  const remaining =
    CHAIN_DETAIL_SYNC_MAX_BODY_BYTES -
    Buffer.byteLength(prefix()) -
    eventBytes -
    Buffer.byteLength(suffix);
  assert.ok(remaining > 0);
  extrinsic.call_args = JSON.stringify({ s: "x".repeat(remaining) });
  const argumentSha256 = hash(Buffer.from(extrinsic.call_args));
  const expectedBytes =
    Buffer.byteLength(prefix()) + eventBytes + Buffer.byteLength(suffix);
  assert.equal(expectedBytes, CHAIN_DETAIL_SYNC_MAX_BODY_BYTES);
  const file = await open(filePath, "wx");
  const digest = createHash("sha256");
  let written = 0;
  const append = async (text: string) => {
    const bytes = Buffer.from(text);
    digest.update(bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.write(bytes, offset);
      assert.ok(result.bytesWritten > 0);
      offset += result.bytesWritten;
    }
    written += bytes.length;
  };
  try {
    await append(prefix());
    for (let start = 0; start < 79_998; start += 128) {
      let chunk = "";
      for (let i = start; i < Math.min(start + 128, 79_998); i++)
        chunk += (i ? "," : "") + event(i);
      await append(chunk);
    }
    await append(suffix);
  } finally {
    await file.close();
  }
  assert.equal(written, CHAIN_DETAIL_SYNC_MAX_BODY_BYTES);
  return {
    file_path: filePath,
    bytes: written,
    sha256: digest.digest("hex"),
    detail_rows: 80000,
    chain_events: 79998,
    block,
    observed_at: observedAt,
    argument_sha256: argumentSha256,
  };
}

// Only the verifier methods used below; both the native binding and the
// HTTP diagnostic adapter implement this surface without claiming batch/exec.
interface VerificationStatement {
  bind(...values: unknown[]): VerificationStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(field?: string): Promise<T | null>;
}
interface VerificationDb {
  prepare(sql: string): VerificationStatement;
}

async function databaseState(
  db: VerificationDb,
  progress?: (state: { table: string; rows: number }) => Promise<void>,
) {
  const state = [];
  for (const table of [...chainDetailTables(), "chain_detail_payload_chunks"]) {
    const digest = createHash("sha256");
    let count = 0;
    for (;;) {
      if (progress && count % 8192 === 0)
        await progress({ table, rows: count });
      const rows = (
        await db
          .prepare(`SELECT * FROM ${table} ORDER BY 1,2 LIMIT 128 OFFSET ?`)
          .bind(count)
          .all()
      ).results;
      for (const row of rows) digest.update(JSON.stringify(row) + "\n");
      count += rows.length;
      assert.ok(count <= 400_000, "finite verification row bound");
      if (rows.length < 128) break;
    }
    state.push({ table, rows: count, sha256: digest.digest("hex") });
  }
  return state;
}

async function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("synthetic phase exceeded its time budget")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function inspector(url: string) {
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname),
    "inspector must stay on loopback",
  );
  const socket = new WebSocket(url);
  let sequence = 0;
  const pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("inspector connect timeout"));
    }, 5_000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        socket.close();
        reject(new Error("inspector connection failed"));
      },
      { once: true },
    );
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("inspector disconnected"));
    }
    pending.clear();
  });
  let protocolError: Error | undefined;
  socket.addEventListener("message", (event) => {
    let message;
    try {
      const text = String(event.data);
      assert.ok(
        Buffer.byteLength(text) <= 64 * 1024 * 1024,
        "inspector message byte bound",
      );
      message = JSON.parse(text);
      assert.ok(
        message && typeof message === "object" && !Array.isArray(message),
        "inspector frame must be an object",
      );
    } catch (error) {
      protocolError = error instanceof Error ? error : new Error(String(error));
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(protocolError);
      }
      pending.clear();
      socket.close();
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result ?? {});
  });
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (protocolError || socket.readyState !== WebSocket.OPEN) {
        reject(protocolError ?? new Error("inspector is not connected"));
        return;
      }
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`inspector timeout: ${method}`));
      }, 5_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return {
    request,
    close: () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("inspector closed"));
      }
      pending.clear();
      socket.close();
    },
  };
}

await save();
try {
  report.native_limits_start = await nativeLimits();
  // Same native bundler as deploy qualification; --dry-run never uploads.
  execFileSync(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "deploy",
      "--dry-run",
      "--config",
      "wrangler.data.jsonc",
      "--outdir",
      temporary,
    ],
    { stdio: "inherit", timeout: 120_000 },
  );
  report.native_limits_after_bundle = await nativeLimits();
  const modules = (await readdir(temporary)).filter((name) =>
    name.endsWith(".js"),
  );
  assert.equal(modules.length, 1, "expected one data-api entry");
  const scriptPath = path.join(temporary, modules[0]);
  report.bundle_sha256 = hash(await readFile(scriptPath));
  // Consume the configured dry-run entry exactly; no measurement-only facade.
  report.configured_entry = "workers/data-api.entry.ts";
  const nativeModules = [
    { type: "ESModule" as const, path: scriptPath },
    ...(await readdir(temporary, { recursive: true }))
      .filter((name) => name.endsWith(".wasm"))
      .map((name) => ({
        type: "CompiledWasm" as const,
        path: path.join(temporary, name),
      })),
  ];
  report.module_manifest = await Promise.all(
    nativeModules.map(async (module) => ({
      path: path.relative(temporary, module.path),
      type: module.type,
      sha256: hash(await readFile(module.path)),
    })),
  );
  report.lock_sha256 = hash(await readFile("package-lock.json"));
  report.config_sha256 = hash(await readFile("wrangler.data.jsonc"));
  const configured = JSON.parse(
    stripJsonComments(await readFile("wrangler.data.jsonc", "utf8")),
  );
  assert.equal(configured.main, "workers/data-api.entry.ts");
  const policy = configured.queues.consumers.find(
    (item: { queue: string }) => item.queue === "sync-batches",
  );
  assert.equal(policy.max_batch_size, 1);
  assert.equal(policy.max_concurrency, 1);
  report.native_admission = policy;
  const shape = process.env.CHAIN_DETAIL_RESOURCE_SHAPE;
  assert.ok(
    shape &&
      [
        "small",
        "string",
        "objects",
        "objects-max",
        "objects-admitted",
        "blocks16",
        "chunks",
        "chunks-http",
        "mixed-lanes",
        "http-envelope",
        "http-concurrent",
        "combined",
      ].includes(shape),
    "one explicit finite diagnostic shape required",
  );
  if (separateHttpPhases)
    assert.ok(
      nativeOracle && ["http-envelope", "http-concurrent"].includes(shape),
      "separate phases require one HTTP boundary shape and native verifier",
    );
  report.shape = shape;
  const shapes =
    shape === "combined"
      ? [
          "small",
          "string",
          "objects",
          "objects-max",
          "objects-admitted",
          "blocks16",
        ]
      : [shape];
  for (const selectedShape of shapes) {
    const shape = selectedShape;
    report.current_shape = shape;
    report.current_phase = "construct-input";
    await save();
    const message = payload(shape.startsWith("http-") ? "small" : shape);
    const decoded = Buffer.byteLength(JSON.stringify(message));
    if (!shape.startsWith("http-"))
      assert.ok(decoded <= SYNC_BATCH_MAX_DECODED_BYTES);
    const mixed = shape === "mixed-lanes";
    const schemaFiles = mixed
      ? (await readdir("migrations/d1"))
          .filter((name) => name.endsWith(".sql"))
          .sort()
      : [];
    const schemaSources = await Promise.all(
      schemaFiles.map((name) => readFile(`migrations/d1/${name}`, "utf8")),
    );
    const mixedTables = schemaSources.flatMap((sql) =>
      [
        ...sql.matchAll(
          /CREATE TABLE(?: IF NOT EXISTS)?\s+([A-Za-z_][A-Za-z_0-9]*)/gi,
        ),
      ].map((match) => match[1]),
    );
    const apiOptions = {
      name: "chain-detail-resource",
      modules: nativeModules,
      modulesRoot: temporary,
      compatibilityDate: "2026-06-06",
      compatibilityFlags: ["nodejs_compat"],
      inspectorPort: 0,
      d1Databases: ["D1_STATE"],
      queueProducers: { SYNC_BATCHES: "sync-batches" },
      bindings: {
        D1_STATE_TABLES: mixed
          ? [
              ...mixedTables,
              "sync_delivery_passes",
              "sync_delivery_receipts",
            ].join(",")
          : [...chainDetailTables(), "lane_health"].join(","),
        SYNC_DELIVERY_V1_READY: mixed ? "true" : "false",
        D1_EXPORT_REVISIONS: "enabled",
        ARCHIVE_OBJECT_STORAGE: "native",
        CHAIN_DETAIL_SYNC_SECRET: "synthetic-only",
        SYNC_QUEUE_LANES: mixed
          ? configured.vars.SYNC_QUEUE_LANES
          : "chain-detail",
      },
      // No network service, credentials, external store or live queue binding.
      outboundService: { network: { allow: [] } },
    };
    // The optional oracle runs the SAME SQL through an ordinary native binding.
    // It avoids thousands of temporary Node prepared-statement proxies whose
    // native strong-reference release otherwise depends on Node finalization.
    // This is a local fixture only; the production entry and writer are intact.
    const oracleOptions = {
      name: "chain-detail-oracle",
      modules: true,
      compatibilityDate: "2026-06-06",
      d1Databases: { D1_STATE: "D1_STATE" },
      outboundService: { network: { allow: [] } },
      script: `export default { async fetch(request, env) {
          const raw = await request.text();
          if (new TextEncoder().encode(raw).length > 2097152) return new Response("oracle request bound", {status:413});
          const { sql, values } = JSON.parse(raw);
          if (typeof sql !== "string" || !Array.isArray(values) || values.length > 100) return new Response("oracle shape", {status:400});
          return Response.json(await env.D1_STATE.prepare(sql).bind(...values).all());
        }};`,
    };
    const persistence = path.join(temporary, "d1", shape);
    const createApplication = () =>
      new Miniflare(
        nativeOracle
          ? {
              inspectorPort: 0,
              ...(separateHttpPhases ? { resourcePersistencePath: persistence } : {}),
              workers: [apiOptions, oracleOptions],
            }
          : apiOptions,
      );
    let runtime = createApplication();
    let cdp: Awaited<ReturnType<typeof inspector>> | undefined;
    const helpers: Array<{
      id: string;
      title: string;
      client: Awaited<ReturnType<typeof inspector>>;
    }> = [];
    const helperHeaps = async () => {
      const results = [];
      for (const helper of helpers)
        results.push({
          target_id: helper.id,
          title: helper.title,
          request_started_ms: performance.now(),
          ...(await helper.client.request("Runtime.getHeapUsage")),
          reply_received_ms: performance.now(),
        });
      return results;
    };
    async function verificationDb(): Promise<VerificationDb> {
      const oracle = nativeOracle
        ? await deadline(runtime.getWorker("chain-detail-oracle"), 30_000)
        : undefined;
      return oracle
        ? {
            prepare(sql: string) {
              let values: unknown[] = [];
              const statement = {
                bind(...bindings: unknown[]) {
                  values = bindings;
                  return statement;
                },
                async all<T = Record<string, unknown>>() {
                  const response = await deadline(
                    oracle.fetch("https://oracle/query", {
                      method: "POST",
                      body: JSON.stringify({ sql, values }),
                    }),
                    30_000,
                  );
                  assert.equal(
                    response.status,
                    200,
                    "native oracle query must succeed",
                  );
                  return response.json() as Promise<D1Result<T>>;
                },
                async run() {
                  return statement.all();
                },
                async first<T = Record<string, unknown>>(
                  field?: string,
                ): Promise<T | null> {
                  const result = await statement.all();
                  const row = result.results[0] ?? null;
                  return (
                    field === undefined ? row : (row?.[field] ?? null)
                  ) as T | null;
                },
              };
              return statement;
            },
          }
        : await deadline(runtime.getD1Database("D1_STATE"), 30_000);
    }
    async function attachInspectors(application: boolean) {
      const targetUrl = new URL(
        "/json/list",
        await deadline(runtime.getInspectorURL(), 15_000),
      );
      targetUrl.protocol = "http:";
      const targets = (await (
        await fetch(targetUrl, { signal: AbortSignal.timeout(5_000) })
      ).json()) as Array<{
        id: string;
        title: string;
        webSocketDebuggerUrl: string;
      }>;
      report.inspector_targets = targets.map(({ id, title }) => ({
        id,
        title,
      }));
      const subjects = targets.filter((target) =>
        target.title.includes("chain-detail-resource"),
      );
      assert.equal(
        subjects.length,
        application ? 1 : 0,
        "must identify exactly the actual data-api isolate",
      );
      cdp = application
        ? await inspector(subjects[0].webSocketDebuggerUrl)
        : undefined;
      const auxiliaryTargets = targets.filter(
        (target) =>
          target.id.startsWith("d1:") ||
          target.id === "core:entry" ||
          target.id === "core:user:chain-detail-oracle",
      );
      assert.ok(auxiliaryTargets.length <= 4, "finite native helper census");
      for (const target of auxiliaryTargets)
        helpers.push({
          id: target.id,
          title: target.title,
          client: await inspector(target.webSocketDebuggerUrl),
        });
      return {
        client: cdp,
        applicationTargetId: subjects[0]?.id,
        isolate: await cdp?.request("Runtime.getIsolateId"),
      };
    }
    async function stopRuntime() {
      cdp?.close();
      cdp = undefined;
      for (const helper of helpers) helper.client.close();
      helpers.length = 0;
      await deadline(runtime.dispose(), 10_000);
    }
    try {
      let db: VerificationDb = await verificationDb();
      for (const migration of mixed
        ? schemaFiles
        : [
            "0001_lane_health.sql",
            "0002_lane_health_current.sql",
            "0003_lane_health_history_indexes.sql",
            "0014_recent_chain_state.sql",
            "0016_archive_export_revisions.sql",
            "0024_chain_detail_payload_chunks.sql",
            "0039_lane_health_retention_trigger_bounds.sql",
            "0025_sync_dead_letters.sql",
          ]) {
        for (const statement of (
          await readFile(`migrations/d1/${migration}`, "utf8")
        ).split("-- statement-breakpoint")) {
          if (statement.trim()) await db.prepare(statement).run();
        }
      }
      for (const statement of (
        await readFile("deploy/chain-detail-payloads/sqlite.sql", "utf8")
      ).split("-- statement-breakpoint")) {
        if (statement.trim()) await db.prepare(statement).run();
      }
      // Explicit synthetic encoded-byte quota, not a production capacity value.
      await db
        .prepare(
          "UPDATE chain_detail_payload_budget SET max_encoded_bytes=? WHERE id=1",
        )
        .bind(64 * 1024 * 1024)
        .run();
      if (mixed) {
        for (const statement of (
          await readFile("deploy/sync-delivery-receipts/sqlite.sql", "utf8")
        )
          .split(/(?<=;)\n(?=CREATE|--|\n)/)
          .filter((sql) => sql.trim()))
          await db.prepare(statement).run();
      }
      let worker = await runtime.getWorker();
      const attached = await attachInspectors(true);
      cdp = attached.client;
      let isolate = attached.isolate;
      const applicationTargetId = attached.applicationTargetId;
      assert.ok(cdp);
      assert.ok(applicationTargetId);
      if (cpuProfiles) {
        await cdp.request("Profiler.enable");
        await cdp.request("Profiler.setSamplingInterval", { interval: 1_000 });
      }
      if (shape.startsWith("http-")) {
        report.http_cpu_profiles_collected = false;
        report.http_fixture_driver =
          "exact request file streamed64KiB at a time; no retained80000-row normalized driverDTO; unchanged API body/count/limits";
        const simultaneous = shape === "http-concurrent" ? 2 : 1;
        let prior: Awaited<ReturnType<typeof databaseState>> | undefined;
        for (const phase of [
          "first",
          "fresh-insert",
          "late-failure",
          "repair-replay",
        ]) {
          report.current_phase = phase;
          for (const field of [
            "http_response_receipt",
            "http_application_phase",
            "http_verifier_phase",
            "http_pre_dispatch",
            "http_current_process_samples",
            "http_post_response_api_heap",
            "http_post_response_helper_heaps",
            "http_post_response_process",
            "http_post_response_limits",
            "http_verification_progress",
            "http_verification_api_heap",
            "http_verification_helper_heaps",
          ])
            delete report[field];
          report.current_stage = "construct-streamed-fixtures";
          await save();
          const fixtures = [];
          for (let index = 0; index < simultaneous; index++)
            fixtures.push(
              await writeHttpEnvelope(
                path.join(temporary, `${shape}-${phase}-${index}.json`),
                (phase === "fresh-insert" ? 9_000_002 : 9_000_001) +
                  index * 100_000,
                phase === "late-failure" || phase === "repair-replay"
                  ? stamp + 1
                  : stamp,
              ),
            );
          if (phase === "late-failure")
            await db
              .prepare(
                "CREATE TRIGGER resource_http_reject BEFORE INSERT ON chain_detail_blocks BEGIN SELECT RAISE(ABORT,'synthetic streamed HTTP late failure'); END",
              )
              .run();
          if (phase === "repair-replay")
            await db.prepare("DROP TRIGGER resource_http_reject").run();
          assert.ok(cdp, "application inspector required before dispatch");
          const before = await cdp.request("Runtime.getHeapUsage");
          report.current_stage = "before-dispatch";
          report.http_current_fixtures = fixtures;
          report.http_pre_dispatch = {
            api_heap: before,
            native_helper_heaps: await helperHeaps(),
            driver_memory: process.memoryUsage(),
            workerd_process: await processMemory(),
            native_limits: await nativeLimits(),
          };
          await save();
          const processSamples: Array<Record<string, unknown>> = [];
          let done = false;
          report.current_stage = "dispatch-and-write";
          await save();
          let monitoringError: unknown;
          const monitor = (async () => {
            while (!done) {
              assert.ok(processSamples.length < 2048);
              processSamples.push({
                at_ms: performance.now(),
                driver_memory: process.memoryUsage(),
                workerd_process: await processMemory(),
                native_limits: await nativeLimits(),
              });
              if (separateHttpPhases) {
                const requested = performance.now();
                const apiHeap = await cdp!.request("Runtime.getHeapUsage");
                const replied = performance.now();
                Object.assign(processSamples.at(-1)!, {
                  api_heap: apiHeap,
                  api_heap_request_started_ms: requested,
                  api_heap_reply_received_ms: replied,
                  native_helper_heaps: await helperHeaps(),
                });
              }
              report.http_current_process_samples = processSamples;
              await save();
              if (!done)
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
          })().catch((error: unknown) => {
            monitoringError = error;
          });
          let responses;
          const start = performance.now();
          try {
            responses = await deadline(
              Promise.all(
                fixtures.map(async (fixture) => {
                  const source = createReadStream(fixture.file_path, {
                    highWaterMark: 65536,
                  });
                  const started_ms = performance.now();
                  try {
                    const init = {
                      method: "POST",
                      headers: {
                        "x-chain-detail-sync-token": "synthetic-only",
                      },
                      body: Readable.toWeb(
                        source,
                      ) as ReadableStream<Uint8Array>,
                      duplex: "half" as const,
                    };
                    const response = await worker.fetch(
                      "https://d/api/v1/internal/chain-detail-sync",
                      init,
                    );
                    return {
                      status: response.status,
                      body: await response.json(),
                      started_ms,
                      finished_ms: performance.now(),
                    };
                  } finally {
                    source.destroy();
                  }
                }),
              ),
              120_000,
            );
          } finally {
            done = true;
            await monitor;
          }
          if (monitoringError) throw monitoringError;
          for (const response of responses) {
            assert.equal(response.status, phase === "late-failure" ? 502 : 200);
            if (phase !== "late-failure")
              assert.deepEqual((response.body as { stores: string[] }).stores, [
                "d1",
              ]);
          }
          const overlap =
            simultaneous === 2
              ? Math.max(...responses.map((r) => r.started_ms)) <
                Math.min(...responses.map((r) => r.finished_ms))
              : null;
          if (simultaneous === 2)
            assert.equal(
              overlap,
              true,
              "driver windows overlap; API execution overlap remains unknown",
            );
          // Persist the asserted response before any inspector/oracle call can
          // fail. This receipt proves HTTP/store claims and driver windows;
          // independent persisted census/hash verification is still pending.
          assert.ok(JSON.stringify(responses).length <= 16384);
          report.current_stage = "response-receipt";
          report.http_response_receipt = {
            phase,
            responses,
            driver_request_windows_overlap: overlap,
            actual_api_execution_overlap_qualified: false,
            persisted_census_and_hashes_verified: false,
          };
          await save();
          report.current_stage = "post-response-memory";
          await save();
          report.http_post_response_api_heap = await cdp.request(
            "Runtime.getHeapUsage",
          );
          await save();
          report.http_post_response_helper_heaps = await helperHeaps();
          report.http_post_response_process = await processMemory();
          report.http_post_response_limits = await nativeLimits();
          await save();
          if (separateHttpPhases) {
            report.current_stage = "stop-application-before-verification";
            report.http_application_phase = {
              phase,
              isolate,
              inspector_targets: report.inspector_targets,
              pre_dispatch: report.http_pre_dispatch,
              final_api_heap: report.http_post_response_api_heap,
              final_helper_heaps: report.http_post_response_helper_heaps,
              final_native_limits: report.http_post_response_limits,
              final_process: report.http_post_response_process,
              response_receipt: report.http_response_receipt,
              persisted_database:
                "same synthetic D1 id and private temporary persistence directory",
              application_disposed_before_verification: false,
            };
            await save();
            await stopRuntime();
            Object.assign(report.http_application_phase as object, {
              application_disposed_before_verification: true,
            });
            report.current_stage = "start-separate-verifier";
            await save();
            runtime = new Miniflare({
              inspectorPort: 0,
              resourcePersistencePath: persistence,
              workers: [oracleOptions],
            });
            db = await verificationDb();
            await attachInspectors(false);
            const process = await processMemory();
            assert.notEqual(
              process.pid,
              (report.http_post_response_process as { pid: number }).pid,
              "verifier must run in a distinct Workerd process",
            );
            report.http_verifier_phase = {
              phase,
              process,
              inspector_targets: report.inspector_targets,
              application_isolate_present: false,
              native_limits: await nativeLimits(),
            };
            await save();
          }
          report.current_stage = "verify";
          await save();
          const rows = await databaseState(db, async (state) => {
            // Finite samples before the first read and each 8192-row boundary
            // localize shared D1/oracle growth without changing verifier SQL.
            report.http_verification_progress = {
              ...state,
              at_ms: performance.now(),
              driver_memory: process.memoryUsage(),
              workerd_process: await processMemory(),
              native_limits: await nativeLimits(),
            };
            await save();
            report.http_verification_api_heap = cdp
              ? await cdp.request("Runtime.getHeapUsage")
              : null;
            await save();
            report.http_verification_helper_heaps = await helperHeaps();
            await save();
          });
          if (phase === "late-failure")
            assert.deepEqual(
              rows,
              prior,
              "all published rows and inline payload state survive rollback",
            );
          const count = simultaneous * (phase === "first" ? 1 : 2);
          assert.deepEqual(
            rows.map((row) => ({ table: row.table, rows: row.rows })),
            [
              { table: "chain_detail_extrinsics", rows: count },
              { table: "chain_detail_chain_events", rows: 79998 * count },
              { table: "chain_detail_account_events", rows: count },
              { table: "chain_detail_blocks", rows: count },
              { table: "chain_detail_payload_chunks", rows: 0 },
            ],
          );
          for (const fixture of fixtures) {
            const row = await db
              .prepare(
                "SELECT call_args,observed_at FROM chain_detail_extrinsics WHERE block_number=? AND extrinsic_index=0",
              )
              .bind(fixture.block)
              .first<Record<string, unknown>>();
            assert.ok(row);
            assert.equal(
              row.observed_at,
              phase === "repair-replay" ? stamp + 1 : stamp,
            );
            const [restored] = await restoreChainDetailPayloads(
              { D1_STATE: db },
              [row],
            );
            assert.equal(
              hash(Buffer.from(String(restored.call_args))),
              fixture.argument_sha256,
            );
          }
          if (phase === "repair-replay")
            for (const fixture of fixtures)
              for (const table of chainDetailTables()) {
                assert.equal(
                  await db
                    .prepare(
                      `SELECT count(*) n FROM ${table} WHERE block_number=? AND observed_at IS NOT ?`,
                    )
                    .bind(fixture.block, stamp + 1)
                    .first<number>("n"),
                  0,
                );
              }
          const health = await db
            .prepare(
              "SELECT verdict FROM lane_health_current WHERE lane='neon:chain-detail'",
            )
            .first<{ verdict: string }>();
          assert.equal(
            health?.verdict,
            phase === "late-failure" ? "stale" : "ok",
          );
          prior = rows;
          observations.push({
            shape,
            phase,
            health,
            fixtures,
            responses,
            driver_request_windows_overlap: overlap,
            actual_api_execution_overlap_qualified: false,
            four_family_and_chunk_digests: rows,
            wall_ms: performance.now() - start,
            before,
            after: separateHttpPhases
              ? report.http_post_response_api_heap
              : await cdp!.request("Runtime.getHeapUsage"),
            application_phase: separateHttpPhases
              ? report.http_application_phase
              : undefined,
            verifier_phase: separateHttpPhases
              ? {
                  ...(report.http_verifier_phase as object),
                  final_process: await processMemory(),
                  helper_heaps: await helperHeaps(),
                  persisted_census_and_hashes_verified: true,
                }
              : undefined,
            process_samples: processSamples,
            native_limits: await nativeLimits(),
            true_peak_qualified: false,
          });
          await save();
          for (const fixture of fixtures) await rm(fixture.file_path);
          if (separateHttpPhases && phase !== "repair-replay") {
            report.current_stage = "stop-verifier-before-next-application";
            await save();
            await stopRuntime();
            runtime = createApplication();
            db = await verificationDb();
            worker = await runtime.getWorker();
            const attached = await attachInspectors(true);
            cdp = attached.client;
            isolate = attached.isolate;
          }
        }
        continue;
      }
      assert.ok(cdp, "application inspector required");
      if (shape === "chunks") {
        await assert.rejects(
          compressSyncBatchMessage(message, SYNC_BATCH_MAX_BYTES),
          /over the 98304-byte budget/,
        );
        report.chunk_legacy_admission = {
          current_producer_wire_bytes: SYNC_BATCH_MAX_BYTES,
          current_producer_refused: true,
          consumer_wire_bytes: 128 * 1024,
          scope: "older accepted consumer body; not current producer admission",
        };
        await save();
      }
      if (mixed) {
        report.mixed_cpu_profiles_collected = false;
        report.mixed_cpu_scope =
          "wall/service times only; this branch never starts CPU profile collection";
        const lanes = String(configured.vars.SYNC_QUEUE_LANES).split(",");
        assert.deepEqual(
          [...lanes].sort(),
          [
            "account-balances",
            "chain-detail",
            "hotkey-alpha",
            "nominator-positions",
            "validator-nominator-counts",
          ].sort(),
          "measure every configured shared lane; changed roster needs an explicit fixture",
        );
        const account = (index: number) =>
          `5${"A".repeat(43)}${String(index).padStart(4, "0")}`;
        // Explicit warm-state dependency: hotkey-alpha only admits owners
        // present in positions. This bootstrap is not measured tape work.
        const eligibility = Array.from({ length: 1000 }, (_, index) => ({
          coldkey: "bootstrap-owner",
          hotkey: account(index),
          netuid: 1,
          shares: "1",
          share_fraction: 1,
          captured_at: stamp - 1000,
          source: "alpha",
        }));
        for (const statement of captureUpsertStatements(
          {
            table: "nominator_positions",
            columns: [
              "coldkey",
              "hotkey",
              "netuid",
              "shares",
              "share_fraction",
              "captured_at",
              "source",
            ],
            conflict: NOMINATOR_POSITIONS_CONFLICT,
          },
          eligibility,
        ))
          await db
            .prepare(statement.text)
            .bind(...statement.values)
            .run();
        assert.equal(
          await db
            .prepare(
              "SELECT count(*) n FROM nominator_positions WHERE coldkey='bootstrap-owner'",
            )
            .first<number>("n"),
          1000,
        );
        const tape: Array<{
          lane: string;
          round: number;
          body: unknown;
          rows: number;
          enqueued_ms: number;
          pass_at?: number;
        }> = [];
        // Finite synthetic round-robin arrival tape, including a wide admitted
        // chain block. One real native queue invocation per message. This is
        // an explicit driver order, not Cloudflare scheduler/fairness parity.
        const chainArguments = new Map<number, string>();
        for (let round = 0; round < 4; round++) {
          const capturedAt = stamp + round * 1000;
          for (const laneName of lanes) {
            const lane = laneName as SyncBatchLane;
            if (lane === "chain-detail") {
              const chainMessage = payload(
                "objects-admitted",
                9_100_001 + round,
              );
              chainArguments.set(
                9_100_001 + round,
                hash(
                  Buffer.from(
                    String(chainMessage.families.extrinsicRows[0].call_args),
                  ),
                ),
              );
              const body = await compressSyncBatchMessage(
                chainMessage,
                SYNC_BATCH_MAX_BYTES,
              );
              tape.push({
                lane,
                round,
                body,
                rows: 5000,
                enqueued_ms: performance.now(),
              });
              continue;
            }
            const rows: Record<string, unknown>[] = Array.from(
              { length: lane === "nominator-positions" ? 100 : 1000 },
              (_, index) => {
                const key = account(index);
                switch (lane) {
                  case "account-balances":
                    return {
                      ss58: key,
                      free_tao: round + 1,
                      reserved_tao: 0,
                      captured_at: capturedAt,
                    };
                  case "hotkey-alpha":
                    return {
                      hotkey: key,
                      netuid: 1,
                      total_alpha: round + 1,
                      captured_at: capturedAt,
                    };
                  case "validator-nominator-counts":
                    return {
                      hotkey: key,
                      nominator_count: round + 1,
                      captured_at: capturedAt,
                    };
                  case "nominator-positions":
                    return {
                      coldkey: account(9999),
                      hotkey: key,
                      netuid: 1,
                      shares: String(index + 1),
                      share_fraction: 0.01,
                      captured_at: capturedAt,
                    };
                  default:
                    throw new Error("configured lane lacks diagnostic rows");
                }
              },
            );
            const delivery = makeSyncDelivery(
              lane,
              capturedAt,
              rows.length,
              rows,
            );
            const messages = packSyncBatchMessages({
              lane,
              capturedAt,
              passTotal: rows.length,
              delivery,
              rows,
            });
            assert.ok(messages.length > 0);
            for (const body of messages)
              tape.push({
                lane,
                round,
                body,
                rows: body.rows.length,
                enqueued_ms: performance.now(),
                pass_at: capturedAt,
              });
          }
        }
        report.mixed_tape = {
          messages: tape.length,
          rows: tape.reduce((sum, item) => sum + item.rows, 0),
          configured_lanes: lanes,
          rounds: 4,
          serial_native_calls: 1,
          native_batch_size: 1,
          scheduling:
            "driver round-robin; native Cloudflare scheduling/fairness not established",
          arrival_model:
            "all finite messages queued in driver before serial drain; no production arrival rate supplied",
        };
        await save();
        const drainStarted = performance.now();
        const retry: typeof tape = [];
        for (const [index, item] of tape.entries()) {
          const fail =
            item.lane === "account-balances" &&
            item.round === 1 &&
            !retry.length;
          if (fail)
            await db
              .prepare(
                "CREATE TRIGGER resource_mixed_reject BEFORE INSERT ON account_balances BEGIN SELECT RAISE(ABORT,'synthetic mixed failure'); END",
              )
              .run();
          const start = performance.now();
          const result = await deadline(
            worker.queue("sync-batches", [
              {
                id: `mixed-${index}`,
                timestamp: new Date(stamp),
                attempts: 1,
                body: item.body,
              },
            ]),
            120_000,
          );
          const end = performance.now();
          if (fail) {
            assert.equal(result.explicitAcks.length, 0);
            assert.equal(result.retryMessages.length, 1);
            const credited = await db
              .prepare(
                "SELECT count(*) n FROM sync_delivery_receipts WHERE lane=? AND captured_at=?",
              )
              .bind(item.lane, item.pass_at)
              .first<number>("n");
            assert.equal(
              credited,
              0,
              "failed transaction must not claim receipt credit",
            );
            const unchanged = await db
              .prepare(
                "SELECT count(*) rows,sum(free_tao) amount,min(captured_at) oldest,max(captured_at) newest FROM account_balances",
              )
              .first();
            assert.deepEqual(
              unchanged,
              { rows: 1000, amount: 1000, oldest: stamp, newest: stamp },
              "injected failed transaction must preserve prior business rows",
            );
            await db.prepare("DROP TRIGGER resource_mixed_reject").run();
            retry.push(item);
          } else {
            assert.ok(result.ackAll || result.explicitAcks.length === 1);
            assert.equal(result.retryMessages.length, 0);
          }
          observations.push({
            shape,
            phase: "serial-drain",
            lane: item.lane,
            round: item.round,
            rows: item.rows,
            queued_before_drain_ms: item.enqueued_ms,
            started_ms: start,
            finished_ms: end,
            driver_wait_ms: start - item.enqueued_ms,
            service_wall_ms: end - start,
            driver_remaining: tape.length - index - 1,
            result,
            deliberate_retry: fail,
            native_limits: await nativeLimits(),
          });
          await save();
        }
        const primaryDrainWallMs = performance.now() - drainStarted;
        assert.equal(
          retry.length,
          1,
          "finite tape must include exactly one failed message",
        );
        for (const item of retry) {
          const result = await deadline(
            worker.queue("sync-batches", [
              {
                id: "mixed-repair",
                timestamp: new Date(stamp),
                attempts: 2,
                body: item.body,
              },
            ]),
            120_000,
          );
          assert.ok(result.ackAll || result.explicitAcks.length === 1);
          assert.equal(result.retryMessages.length, 0);
          observations.push({
            shape,
            phase: "retry-repair",
            lane: item.lane,
            round: item.round,
            result,
          });
          await save();
        }
        // Exact receipt replay must not double credit a pass, even after newer
        // observations have arrived. Then check all16 business-pass totals.
        for (const item of tape.filter(
          (entry) => entry.lane !== "chain-detail",
        )) {
          const result = await deadline(
            worker.queue("sync-batches", [
              {
                id: "mixed-replay",
                timestamp: new Date(stamp),
                attempts: 2,
                body: item.body,
              },
            ]),
            120_000,
          );
          assert.ok(result.ackAll || result.explicitAcks.length === 1);
          assert.equal(result.retryMessages.length, 0);
        }
        const passes = [];
        for (let round = 0; round < 4; round++)
          for (const lane of lanes.filter(
            (value: string) => value !== "chain-detail",
          )) {
            const expected = lane === "nominator-positions" ? 100 : 1000;
            const row = await db
              .prepare(
                `SELECT expected_rows,received_rows,completed_at FROM ${PASS_TABLES[lane]} WHERE captured_at=?`,
              )
              .bind(stamp + round * 1000)
              .first<{
                expected_rows: number;
                received_rows: number;
                completed_at: number;
              }>();
            assert.ok(row);
            assert.equal(row.expected_rows, expected);
            assert.equal(row.received_rows, expected);
            assert.ok(row.completed_at);
            passes.push({ lane, round, ...row });
          }
        const chain = await db
          .prepare(
            "SELECT (SELECT count(*) FROM chain_detail_blocks) blocks,(SELECT count(*) FROM chain_detail_extrinsics) extrinsics,(SELECT count(*) FROM chain_detail_chain_events) events,(SELECT count(*) FROM chain_detail_account_events) accounts",
          )
          .first();
        assert.deepEqual(chain, {
          blocks: 4,
          extrinsics: 4,
          events: 19992,
          accounts: 4,
        });
        for (const [block, expectedHash] of chainArguments) {
          const row = await db
            .prepare(
              "SELECT call_args FROM chain_detail_extrinsics WHERE block_number=? AND extrinsic_index=0",
            )
            .bind(block)
            .first<Record<string, unknown>>();
          assert.ok(row);
          const [restored] = await restoreChainDetailPayloads(
            { D1_STATE: db },
            [row],
          );
          assert.equal(
            hash(Buffer.from(String(restored.call_args))),
            expectedHash,
            "each mixed chain block must retain exact full argument bytes",
          );
        }
        const business = [];
        for (const [table, value] of [
          ["account_balances", "free_tao"],
          ["hotkey_alpha", "total_alpha"],
          ["validator_nominator_counts", "nominator_count"],
        ]) {
          const latest = await db
            .prepare(
              `SELECT count(*) rows,sum(${value}) amount,min(captured_at) oldest,max(captured_at) newest FROM ${table}`,
            )
            .first();
          assert.deepEqual(
            latest,
            {
              rows: 1000,
              amount: 4000,
              oldest: stamp + 3000,
              newest: stamp + 3000,
            },
            "late retry/replay must preserve latest business values",
          );
          business.push({ table, ...latest });
        }
        const positions = await db
          .prepare(
            "SELECT count(*) rows,sum(CAST(shares AS INTEGER)) shares,min(captured_at) oldest,max(captured_at) newest FROM nominator_positions WHERE coldkey=?",
          )
          .bind(account(9999))
          .first();
        assert.deepEqual(positions, {
          rows: 100,
          shares: 5050,
          oldest: stamp + 3000,
          newest: stamp + 3000,
        });
        assert.equal(
          await db
            .prepare(
              "SELECT count(*) n FROM nominator_positions WHERE coldkey='bootstrap-owner'",
            )
            .first<number>("n"),
          1000,
        );
        report.mixed_completed = {
          passes,
          chain,
          business,
          measured_positions: positions,
          eligible_bootstrap_positions: 1000,
          deliberate_failures: 1,
          repaired: 1,
          replay_credit_unchanged: true,
          serial_drain_wall_ms: primaryDrainWallMs,
          total_including_repair_replay_verification_ms:
            performance.now() - drainStarted,
          workerd_process: await processMemory(),
          driver_memory: process.memoryUsage(),
          native_limits: await nativeLimits(),
          production_freshness_or_fairness_qualified: false,
        };
        await save();
        continue;
      }
      let retainedOriginal = message;
      if (shape === "objects" || shape === "objects-max") {
        await assert.rejects(
          compressSyncBatchMessage(message, 128 * 1024),
          SyncBatchSizeError,
        );
        const packed = gzipSync(JSON.stringify(message));
        assert.ok(packed.length <= 128 * 1024);
        const envelope = [
          {
            id: `retained-${shape}`,
            timestamp: new Date(stamp),
            attempts: 6,
            body: packed,
          },
        ];
        const refused = await deadline(
          worker.queue("sync-batches", envelope),
          30_000,
        );
        assert.equal(refused.explicitAcks.length, 0);
        assert.equal(refused.retryMessages.length, 1);
        const untouched = await databaseState(db);
        assert.ok(untouched.every((table) => table.rows === 0));
        const quarantined = await deadline(
          worker.queue("sync-batches-dlq", envelope),
          30_000,
        );
        assert.ok(quarantined.ackAll || quarantined.explicitAcks.length === 1);
        const receipt = await db
          .prepare(
            "SELECT body_sha256,encoding,payload FROM sync_dead_letters WHERE message_id=?",
          )
          .bind(envelope[0].id)
          .first<{ body_sha256: string; encoding: string; payload: string }>();
        assert.equal(receipt?.body_sha256, hash(packed));
        assert.equal(receipt.encoding, "base64");
        assert.deepEqual(Buffer.from(receipt.payload, "base64"), packed);
        retainedOriginal = JSON.parse(
          gunzipSync(Buffer.from(receipt.payload, "base64"), {
            maxOutputLength: SYNC_BATCH_MAX_DECODED_BYTES,
          }).toString("utf8"),
        );
        assert.deepEqual(retainedOriginal, message);
        observations.push({
          shape,
          phase: "row-admission-refusal",
          decoded_bytes: decoded,
          wire_bytes: packed.length,
          detail_rows:
            Object.values(message.families).reduce(
              (n, rows) => n + rows.length,
              0,
            ) - message.families.blockRows.length,
          producer_refused: true,
          retry_without_ack: true,
          exact_dlq_sha256: receipt.body_sha256,
          business_tables_untouched: true,
          indivisible_original_retained_unresolved: true,
          isolate,
          driver_memory: process.memoryUsage(),
          driver_high_water_kib: process.resourceUsage().maxRSS,
          workerd_process: await processMemory(),
          native_limits: await nativeLimits(),
        });
        await save();
      }
      const direct =
        shape === "objects" ||
        shape === "objects-max" ||
        shape.startsWith("http-") ||
        shape === "chunks-http";
      let originalChunkDigest: string | undefined;
      const originalArgument = message.families.extrinsicRows[0].call_args;
      const originalChunkHash =
        typeof originalArgument === "string"
          ? hash(Buffer.from(originalArgument))
          : null;
      const chunkDigest = async (key: string) => {
        const rows = (
          await db
            .prepare(
              "SELECT * FROM chain_detail_payload_chunks WHERE sha256=? ORDER BY part LIMIT 13",
            )
            .bind(key)
            .all()
        ).results;
        assert.ok(rows.length > 0, "nonempty native payload chunks required");
        return hash(Buffer.from(JSON.stringify(rows)));
      };
      let priorRows: unknown;
      for (const phase of [
        "first",
        "fresh-insert",
        "late-failure",
        "repair-replay",
      ]) {
        report.current_phase = phase;
        await save();
        const current =
          phase === "fresh-insert"
            ? payload(shape, 9_000_002)
            : structuredClone(retainedOriginal);
        if (phase === "late-failure" || phase === "repair-replay") {
          for (const rows of Object.values(current.families))
            for (const row of rows) row.observed_at = stamp + 1;
        }
        if (
          shape.startsWith("chunks") &&
          (phase === "late-failure" || phase === "repair-replay")
        ) {
          for (const row of current.families.extrinsicRows)
            row.call_args = JSON.stringify({ changed: originalArgument });
        }
        const admitted = direct
          ? undefined
          : await compressSyncBatchMessage(current, 128 * 1024);
        if (phase === "late-failure")
          await db
            .prepare(
              "CREATE TRIGGER resource_reject BEFORE INSERT ON chain_detail_blocks BEGIN SELECT RAISE(ABORT,'synthetic late failure'); END",
            )
            .run();
        if (phase === "repair-replay")
          await db.prepare("DROP TRIGGER resource_reject").run();
        const samples: Array<Record<string, unknown>> = [];
        const helperHeapsBefore = await helperHeaps();
        const before = await cdp.request("Runtime.getHeapUsage");
        assert.ok(
          typeof before.usedSize === "number" && before.usedSize > 0,
          "actual isolate heap statistics required",
        );
        if (cpuProfiles) await cdp.request("Profiler.start");
        let finished = false;
        let samplingError: unknown;
        const sampling = (async () => {
          while (!finished) {
            assert.ok(samples.length < 5_000, "heap observation count bound");
            samples.push({
              request_started_ms: performance.now(),
              ...(await cdp!.request("Runtime.getHeapUsage")),
              reply_received_ms: performance.now(),
            });
            if (!finished)
              await new Promise((resolve) => setTimeout(resolve, 25));
          }
        })().catch((error: unknown) => {
          samplingError = error;
        });
        const start = performance.now();
        let results: Awaited<ReturnType<typeof worker.queue>>[] = [];
        let httpResult: { status: number; body: unknown } | undefined;
        let httpRequestBytes: number | undefined;
        try {
          if (direct) {
            // Recover the indivisible original through the existing authenticated
            // HTTP writer, keeping every family in the one native transaction.
            const messages =
              shape === "http-concurrent"
                ? current.families.blockRows.map((block) => ({
                    ...current,
                    families: Object.fromEntries(
                      Object.entries(current.families).map(([name, rows]) => [
                        name,
                        rows.filter(
                          (row) => row.block_number === block.block_number,
                        ),
                      ]),
                    ) as typeof current.families,
                  }))
                : [current];
            const requestBodies = messages.map(httpBody);
            httpRequestBytes = Math.max(
              ...requestBodies.map((body) => Buffer.byteLength(body)),
            );
            if (shape.startsWith("http-"))
              for (const body of requestBodies)
                assert.equal(
                  Buffer.byteLength(body),
                  CHAIN_DETAIL_SYNC_MAX_BODY_BYTES,
                );
            const responses = await deadline(
              Promise.all(
                requestBodies.map(async (body) => {
                  const started_ms = performance.now();
                  const response = await worker.fetch(
                    "https://d/api/v1/internal/chain-detail-sync",
                    {
                      method: "POST",
                      headers: {
                        "x-chain-detail-sync-token": "synthetic-only",
                      },
                      body,
                    },
                  );
                  const result = {
                    status: response.status,
                    body: await response.json(),
                    started_ms,
                    finished_ms: performance.now(),
                  };
                  assert.equal(
                    response.status,
                    phase === "late-failure" ? 502 : 200,
                  );
                  if (phase !== "late-failure")
                    assert.deepEqual(
                      (result.body as { stores: string[] }).stores,
                      ["d1"],
                    );
                  return result;
                }),
              ),
              120_000,
            );
            const driverWindowsOverlap =
              responses.length === 2
                ? Math.max(...responses.map((result) => result.started_ms)) <
                  Math.min(...responses.map((result) => result.finished_ms))
                : null;
            if (shape === "http-concurrent")
              assert.equal(
                driverWindowsOverlap,
                true,
                "driver request windows must overlap; this does not prove synchronous API execution overlap",
              );
            httpResult = {
              status: responses[0].status,
              body: {
                simultaneous_requests: responses.length,
                driver_request_windows_overlap: driverWindowsOverlap,
                actual_api_execution_overlap_qualified: false,
                responses,
              },
            };
          } else {
            results = [
              await deadline(
                worker.queue("sync-batches", [
                  {
                    id: `${shape}-${phase}`,
                    timestamp: new Date(stamp),
                    attempts: 1,
                    body: admitted,
                  },
                ]),
                120_000,
              ),
            ];
          }
        } finally {
          finished = true;
          await sampling;
        }
        if (samplingError) throw samplingError;
        const wall_ms = performance.now() - start;
        let profileName: string | undefined;
        if (cpuProfiles) {
          const profile = await cdp.request("Profiler.stop");
          profileName = `${shape}-${phase}.cpuprofile`;
          const profileText = JSON.stringify(profile.profile);
          assert.ok(
            Buffer.byteLength(profileText) <= 32 * 1024 * 1024,
            "CPU profile byte bound",
          );
          await writeFile(path.join(output, profileName), profileText);
        }
        const after = await cdp.request("Runtime.getHeapUsage");
        const resultsExpected = phase === "late-failure" ? "retry" : "ack";
        for (const result of results) {
          if (resultsExpected === "retry")
            assert.equal(result.retryMessages.length, 1);
          else assert.ok(result.ackAll || result.explicitAcks.length === 1);
        }
        const actualRows = await databaseState(db);
        if (phase === "late-failure") {
          assert.deepEqual(
            actualRows,
            priorRows,
            "failed changed-row transaction must preserve all prior rows and chunks",
          );
        }
        if (shape.startsWith("chunks")) {
          assert.ok(originalChunkHash);
          const digest = await chunkDigest(originalChunkHash);
          if (originalChunkDigest !== undefined)
            assert.equal(
              digest,
              originalChunkDigest,
              "prior immutable chunks must survive unchanged",
            );
          originalChunkDigest = digest;
          if (phase === "late-failure") {
            const changed = String(current.families.extrinsicRows[0].call_args);
            assert.equal(
              await db
                .prepare(
                  "SELECT count(*) n FROM chain_detail_payload_chunks WHERE sha256=?",
                )
                .bind(hash(Buffer.from(changed)))
                .first<number>("n"),
              0,
              "failed publication must roll back every new chunk",
            );
          }
          if (phase === "repair-replay") {
            const changed = String(current.families.extrinsicRows[0].call_args);
            await chunkDigest(hash(Buffer.from(changed)));
            assert.ok(
              actualRows.at(-1)!.rows > 1,
              "successful repair commits new chunks with its rows",
            );
          }
        }
        if (phase === "repair-replay") {
          const blocks = message.families.blockRows.map(
            (row) => row.block_number,
          );
          for (const table of chainDetailTables()) {
            const unmatched = await db
              .prepare(
                `SELECT count(*) n FROM ${table} WHERE block_number IN (${blocks.map(() => "?").join(",")}) AND observed_at IS NOT ?`,
              )
              .bind(...blocks, stamp + 1)
              .first("n");
            assert.equal(
              unmatched,
              0,
              "repaired changed rows must publish atomically",
            );
          }
        }
        priorRows = actualRows;
        const census = await db
          .prepare(
            "SELECT (SELECT count(*) FROM chain_detail_blocks) blocks,(SELECT count(*) FROM chain_detail_extrinsics) extrinsics,(SELECT count(*) FROM chain_detail_chain_events) events,(SELECT count(*) FROM chain_detail_account_events) accounts",
          )
          .first();
        assert.deepEqual(
          census,
          {
            blocks:
              message.families.blockRows.length * (phase === "first" ? 1 : 2),
            extrinsics:
              message.families.extrinsicRows.length *
              (phase === "first" ? 1 : 2),
            events:
              message.families.chainEventRows.length *
              (phase === "first" ? 1 : 2),
            accounts:
              message.families.accountEventRows.length *
              (phase === "first" ? 1 : 2),
          },
          "an ACK must correspond to the actual four-family durable census",
        );
        const [restored] = await restoreChainDetailPayloads({ D1_STATE: db }, [
          (await db
            .prepare(
              "SELECT call_args FROM chain_detail_extrinsics WHERE block_number=9000001 AND extrinsic_index=0",
            )
            .first<Record<string, unknown>>()) ?? {},
        ]);
        assert.equal(
          restored.call_args,
          shape.startsWith("chunks") && phase === "repair-replay"
            ? current.families.extrinsicRows[0].call_args
            : message.families.extrinsicRows[0].call_args,
          "exact original or atomically repaired argument bytes survive replay",
        );
        if (shape.startsWith("chunks") && phase === "repair-replay") {
          const freshRow = await db
            .prepare(
              "SELECT call_args FROM chain_detail_extrinsics WHERE block_number=9000002 AND extrinsic_index=0",
            )
            .first<Record<string, unknown>>();
          assert.ok(freshRow);
          const [fresh] = await restoreChainDetailPayloads({ D1_STATE: db }, [
            freshRow,
          ]);
          assert.equal(
            fresh.call_args,
            originalArgument,
            "repair must not change the distinct fresh block's payload",
          );
        }
        const health = await db
          .prepare(
            "SELECT verdict FROM lane_health_current WHERE lane='neon:chain-detail'",
          )
          .first<{ verdict: string }>();
        assert.equal(
          health?.verdict,
          phase === "late-failure" ? "stale" : "ok",
        );
        observations.push({
          shape,
          phase,
          isolate,
          target_id: applicationTargetId,
          wire_bytes: admitted?.byteLength,
          decoded_bytes: direct ? undefined : decoded,
          http_request_bytes: httpRequestBytes,
          retained_normalized_message_bytes: direct ? decoded : undefined,
          family_rows: Object.fromEntries(
            Object.entries(message.families).map(([key, value]) => [
              key,
              value.length,
            ]),
          ),
          wall_ms,
          results,
          http_result: httpResult,
          recovery: direct ? "indivisible-original-http-atomic" : undefined,
          http_simultaneous_requests:
            shape === "http-concurrent" ? 2 : direct ? 1 : 0,
          immutable_chunks: shape.startsWith("chunks")
            ? {
                original_sha256: originalChunkHash,
                original_chunks_digest: originalChunkDigest,
                new_chunks_persist_before_row_transaction: false,
                failed_row_transaction_retains_new_chunks: false,
                published_and_in_flight_original_chunks_retained: true,
                published_argument_sha256:
                  typeof restored.call_args === "string"
                    ? hash(Buffer.from(restored.call_args))
                    : null,
              }
            : undefined,
          census,
          four_family_and_chunk_digests: actualRows,
          health,
          argument_sha256:
            typeof restored.call_args === "string"
              ? hash(Buffer.from(restored.call_args))
              : null,
          before,
          after,
          native_helper_heaps_before: helperHeapsBefore,
          native_helper_heaps_after_verification: await helperHeaps(),
          samples,
          profile: profileName,
          observed_heap_max: Math.max(
            Number(before.usedSize),
            Number(after.usedSize),
            ...samples.map((sample) => Number(sample.usedSize)),
          ),
          changed_rows_rolled_back: phase === "late-failure" ? true : null,
          driver_memory: process.memoryUsage(),
          driver_high_water_kib: process.resourceUsage().maxRSS,
          workerd_process: await processMemory(),
          native_limits: await nativeLimits(),
          true_peak_qualified: false,
        });
        await save();
      }
      if (shape === "small") {
        // An older sender accepted two whole blocks as one oversized expansion.
        // Quarantine preserves that exact transport; repair splits only between
        // blocks and keeps every block's four families together.
        for (const kind of ["bytes", "rows"]) {
          const first = kind === "bytes" ? 9_000_003 : 9_000_005;
          const priorBlocks = kind === "bytes" ? 2 : 4;
          const id = `oversized-${kind}`;
          const originals = [
            payload(kind === "bytes" ? "string" : "objects-repair", first),
            payload(kind === "bytes" ? "string" : "objects-repair", first + 1),
          ];
          for (const original of originals) {
            original.families.extrinsicRows[0].call_args = JSON.stringify({
              s: "q".repeat(kind === "bytes" ? 2_100_000 : 100),
            });
            if (kind === "bytes")
              original.families.chainEventRows.push({
                block_number: original.families.blockRows[0].block_number,
                event_index: 0,
                pallet: "System",
                method: "ExtrinsicSuccess",
                args: null,
                phase: "Initialization",
                extrinsic_index: null,
                observed_at: stamp,
              });
            original.families.blockRows[0].chain_event_count =
              original.families.chainEventRows.length;
          }
          const oversized = {
            lane: "chain-detail",
            captured_at: stamp,
            families: Object.fromEntries(
              Object.keys(message.families).map((name) => [
                name,
                originals.flatMap(
                  (original) =>
                    original.families[name as keyof typeof original.families],
                ),
              ]),
            ),
          };
          const raw = JSON.stringify(oversized);
          assert.equal(
            Buffer.byteLength(raw) > SYNC_BATCH_MAX_DECODED_BYTES,
            kind === "bytes",
          );
          await assert.rejects(
            compressSyncBatchMessage(oversized, 128 * 1024),
            SyncBatchSizeError,
          );
          const refused = gzipSync(raw);
          assert.ok(refused.length < 128 * 1024);
          const envelope = [
            {
              id,
              timestamp: new Date(stamp),
              attempts: 6,
              body: refused,
            },
          ];
          const refusal = await deadline(
            worker.queue("sync-batches", envelope),
            30_000,
          );
          assert.equal(refusal.retryMessages.length, 1);
          assert.equal(refusal.explicitAcks.length, 0);
          assert.equal(
            await db
              .prepare("SELECT count(*) n FROM chain_detail_blocks")
              .first("n"),
            priorBlocks,
          );
          const quarantined = await deadline(
            worker.queue("sync-batches-dlq", envelope),
            30_000,
          );
          assert.ok(
            quarantined.ackAll || quarantined.explicitAcks.length === 1,
          );
          const receipt = await db
            .prepare(
              "SELECT body_sha256,encoding,payload FROM sync_dead_letters WHERE message_id=?",
            )
            .bind(id)
            .first<{
              body_sha256: string;
              encoding: string;
              payload: string;
            }>();
          assert.equal(receipt?.body_sha256, hash(refused));
          assert.equal(receipt.encoding, "base64");
          assert.deepEqual(Buffer.from(receipt.payload, "base64"), refused);
          const retained = JSON.parse(
            gunzipSync(Buffer.from(receipt.payload, "base64"), {
              maxOutputLength: 2 * SYNC_BATCH_MAX_DECODED_BYTES,
            }).toString("utf8"),
          ) as typeof oversized;
          assert.deepEqual(retained, oversized);
          for (const original of originals) {
            const block = original.families.blockRows[0].block_number;
            const repaired = {
              lane: retained.lane,
              captured_at: retained.captured_at,
              families: Object.fromEntries(
                Object.entries(retained.families).map(([family, rows]) => [
                  family,
                  rows.filter((row) => row.block_number === block),
                ]),
              ),
            };
            const result = await deadline(
              worker.queue("sync-batches", [
                {
                  id: `repaired-${original.families.blockRows[0].block_number}`,
                  timestamp: new Date(stamp),
                  attempts: 1,
                  body: await compressSyncBatchMessage(repaired, 128 * 1024),
                },
              ]),
              30_000,
            );
            assert.ok(result.ackAll || result.explicitAcks.length === 1);
            const [restored] = await restoreChainDetailPayloads(
              { D1_STATE: db },
              [
                (await db
                  .prepare(
                    "SELECT call_args FROM chain_detail_extrinsics WHERE block_number=? AND extrinsic_index=0",
                  )
                  .bind(original.families.blockRows[0].block_number)
                  .first<Record<string, unknown>>()) ?? {},
              ],
            );
            assert.equal(
              restored.call_args,
              original.families.extrinsicRows[0].call_args,
            );
          }
          assert.equal(
            await db
              .prepare("SELECT count(*) n FROM chain_detail_blocks")
              .first("n"),
            priorBlocks + 2,
          );
          const expectedFamilies = {
            blockRows: "chain_detail_blocks",
            extrinsicRows: "chain_detail_extrinsics",
            chainEventRows: "chain_detail_chain_events",
            accountEventRows: "chain_detail_account_events",
          };
          for (const [family, table] of Object.entries(expectedFamilies)) {
            const actual = (
              await db
                .prepare(
                  `SELECT * FROM ${table} WHERE block_number IN (?,?) ORDER BY 1,2`,
                )
                .bind(first, first + 1)
                .all()
            ).results;
            const expected = retained.families[family];
            assert.equal(actual.length, expected.length);
            for (let index = 0; index < expected.length; index++) {
              const row = { ...actual[index] };
              if (family === "extrinsicRows") {
                const [restored] = await restoreChainDetailPayloads(
                  { D1_STATE: db },
                  [row],
                );
                row.call_args = restored.call_args;
              }
              for (const [field, value] of Object.entries(expected[index]))
                assert.deepEqual(row[field], value);
            }
          }
          const stillRetained = await db
            .prepare(
              "SELECT body_sha256,payload FROM sync_dead_letters WHERE message_id=?",
            )
            .bind(id)
            .first();
          assert.equal(stillRetained?.body_sha256, hash(refused));
          assert.equal(stillRetained?.payload, receipt.payload);
          observations.push({
            shape: `oversized-${kind}`,
            admitted_block_detail_rows: originals.map(
              (original) =>
                original.families.chainEventRows.length +
                original.families.extrinsicRows.length +
                original.families.accountEventRows.length,
            ),
            retry_without_ack: true,
            exact_dlq_sha256: receipt.body_sha256,
            repaired_whole_blocks: 2,
            original_retained: true,
            driver_memory: process.memoryUsage(),
            driver_high_water_kib: process.resourceUsage().maxRSS,
            workerd_process: await processMemory(),
            native_limits: await nativeLimits(),
          });
          await save();
        }
      }
    } finally {
      cdp?.close();
      for (const helper of helpers) helper.client.close();
      await deadline(runtime.dispose(), 10_000);
    }
  }
  report.native_limits_end = await nativeLimits();
  report.status = "bounded-native-observations";
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await save();
  await rm(temporary, { recursive: true, force: true });
}
