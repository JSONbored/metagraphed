// Finite synthetic Workerd measurements. No production bindings or RPCs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Miniflare } from "miniflare";
import { parseChainDetailSync } from "../src/chain-detail-sync-payload.ts";
import { restoreChainDetailPayloads } from "../src/chain-detail-payloads.ts";
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
    "full16MB/80000-row HTTP envelope and concurrent fallback backpressure",
  ],
  batches: {
    messages: 1,
    simultaneous_calls: 1,
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

function payload(shape: string, block = 9_000_001) {
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
                shape === "objects-max"
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
  const message = { lane: "chain-detail", captured_at: stamp, families };
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

async function databaseState(db: VerificationDb) {
  const state = [];
  for (const table of [...chainDetailTables(), "chain_detail_payload_chunks"]) {
    const digest = createHash("sha256");
    let count = 0;
    for (;;) {
      const rows = (
        await db
          .prepare(`SELECT * FROM ${table} ORDER BY 1,2 LIMIT 128 OFFSET ?`)
          .bind(count)
          .all()
      ).results;
      for (const row of rows) digest.update(JSON.stringify(row) + "\n");
      count += rows.length;
      assert.ok(count <= 100_000, "finite verification row bound");
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
        "combined",
      ].includes(shape),
    "one explicit finite diagnostic shape required",
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
    const message = payload(shape);
    const decoded = Buffer.byteLength(JSON.stringify(message));
    assert.ok(decoded <= SYNC_BATCH_MAX_DECODED_BYTES);
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
        D1_STATE_TABLES: [...chainDetailTables(), "lane_health"].join(","),
        D1_EXPORT_REVISIONS: "enabled",
        ARCHIVE_OBJECT_STORAGE: "native",
        CHAIN_DETAIL_SYNC_SECRET: "synthetic-only",
        SYNC_QUEUE_LANES: "chain-detail",
      },
      // No network service, credentials, external store or live queue binding.
      outboundService: { network: { allow: [] } },
    };
    // The optional oracle runs the SAME SQL through an ordinary native binding.
    // It avoids thousands of temporary Node prepared-statement proxies whose
    // native strong-reference release otherwise depends on Node finalization.
    // This is a local fixture only; the production entry and writer are intact.
    const runtime = new Miniflare(
      nativeOracle
        ? {
            inspectorPort: 0,
            workers: [
              apiOptions,
              {
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
              },
            ],
          }
        : apiOptions,
    );
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
    try {
      const oracle = nativeOracle
        ? await deadline(runtime.getWorker("chain-detail-oracle"), 30_000)
        : undefined;
      const db: VerificationDb = oracle
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
      for (const migration of [
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
      const worker = await runtime.getWorker();
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
        1,
        "must identify exactly the actual data-api isolate",
      );
      cdp = await inspector(subjects[0].webSocketDebuggerUrl);
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
      const isolate = await cdp.request("Runtime.getIsolateId");
      if (cpuProfiles) {
        await cdp.request("Profiler.enable");
        await cdp.request("Profiler.setSamplingInterval", { interval: 1_000 });
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
      const direct = shape === "objects" || shape === "objects-max";
      let priorRows: unknown;
      for (const phase of [
        "first",
        "fresh-insert",
        "late-failure",
        "repair-replay",
      ]) {
        const current =
          phase === "fresh-insert"
            ? payload(shape, 9_000_002)
            : structuredClone(retainedOriginal);
        if (phase === "late-failure" || phase === "repair-replay") {
          for (const rows of Object.values(current.families))
            for (const row of rows) row.observed_at = stamp + 1;
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
            const blocks = current.families.blockRows.map((block) => ({
              ...block,
              extrinsics: current.families.extrinsicRows
                .filter((row) => row.block_number === block.block_number)
                .map((row) => ({
                  ...row,
                  success: row.success === null ? null : Boolean(row.success),
                })),
              chain_events: current.families.chainEventRows.filter(
                (row) => row.block_number === block.block_number,
              ),
              account_events: current.families.accountEventRows.filter(
                (row) => row.block_number === block.block_number,
              ),
            }));
            const requestBody = JSON.stringify({ blocks });
            httpRequestBytes = Buffer.byteLength(requestBody);
            const response = await deadline(
              worker.fetch("https://d/api/v1/internal/chain-detail-sync", {
                method: "POST",
                headers: { "x-chain-detail-sync-token": "synthetic-only" },
                body: requestBody,
              }),
              120_000,
            );
            httpResult = {
              status: response.status,
              body: await response.json(),
            };
            assert.equal(response.status, phase === "late-failure" ? 502 : 200);
            if (phase !== "late-failure")
              assert.deepEqual(
                (httpResult.body as { stores: string[] }).stores,
                ["d1"],
              );
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
        if (phase === "late-failure")
          assert.deepEqual(
            actualRows,
            priorRows,
            "failed changed-row transaction must preserve every prior family value",
          );
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
          message.families.extrinsicRows[0].call_args,
          "exact original argument bytes survive replay",
        );
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
          target_id: subjects[0].id,
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
