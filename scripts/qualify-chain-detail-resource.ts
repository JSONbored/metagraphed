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
} from "../src/sync-batch-compress.ts";

const output = path.resolve("reports/chain-detail-resource");
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(tmpdir(), "chain-detail-resource-"));
const report: Record<string, unknown> = {
  source_head: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  status: "incomplete",
  scope: "synthetic native Workerd, actual dry-run data-api bundle and D1",
  exclusions: [
    "true synchronous heap peak",
    "production CPU/memory limit enforcement",
    "Cloudflare billed CPU",
    "native queue scheduling/concurrency parity",
    "production workload representativeness",
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
    "memory.events",
    "pids.max",
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
              success: null,
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
  if (shape === "objects-max") {
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

async function databaseState(db: D1Database) {
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
  for (const shape of [
    "small",
    "string",
    "objects",
    "objects-max",
    "blocks16",
  ]) {
    const message = payload(shape);
    const decoded = Buffer.byteLength(JSON.stringify(message));
    assert.ok(decoded <= SYNC_BATCH_MAX_DECODED_BYTES);
    const runtime = new Miniflare({
      name: "chain-detail-resource",
      modules: nativeModules,
      modulesRoot: temporary,
      compatibilityDate: "2026-06-06",
      compatibilityFlags: ["nodejs_compat"],
      inspectorPort: 0,
      d1Databases: ["D1_STATE"],
      bindings: {
        D1_STATE_TABLES: [...chainDetailTables(), "lane_health"].join(","),
        D1_EXPORT_REVISIONS: "enabled",
        ARCHIVE_OBJECT_STORAGE: "native",
      },
      // No network service, credentials, external store or live queue binding.
      outboundService: { network: { allow: [] } },
    });
    let cdp: Awaited<ReturnType<typeof inspector>> | undefined;
    try {
      const db = await deadline(runtime.getD1Database("D1_STATE"), 30_000);
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
      const subjects = targets.filter((target) =>
        target.title.includes("chain-detail-resource"),
      );
      assert.equal(
        subjects.length,
        1,
        "must identify exactly the actual data-api isolate",
      );
      cdp = await inspector(subjects[0].webSocketDebuggerUrl);
      const isolate = await cdp.request("Runtime.getIsolateId");
      await cdp.request("Profiler.enable");
      await cdp.request("Profiler.setSamplingInterval", { interval: 1_000 });
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
            : structuredClone(message);
        if (phase === "late-failure" || phase === "repair-replay") {
          for (const rows of Object.values(current.families))
            for (const row of rows) row.observed_at = stamp + 1;
        }
        const admitted = await compressSyncBatchMessage(current, 128 * 1024);
        if (phase === "late-failure")
          await db
            .prepare(
              "CREATE TRIGGER resource_reject BEFORE INSERT ON chain_detail_blocks BEGIN SELECT RAISE(ABORT,'synthetic late failure'); END",
            )
            .run();
        if (phase === "repair-replay")
          await db.prepare("DROP TRIGGER resource_reject").run();
        const samples: Array<Record<string, unknown>> = [];
        const before = await cdp.request("Runtime.getHeapUsage");
        assert.ok(
          typeof before.usedSize === "number" && before.usedSize > 0,
          "actual isolate heap statistics required",
        );
        await cdp.request("Profiler.start");
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
        let results;
        try {
          results = await deadline(
            Promise.all(
              Array.from({ length: 1 }, (_, batch) =>
                worker.queue(
                  "sync-batches",
                  Array.from({ length: 1 }, (_, i) => ({
                    id: `${shape}-${phase}-${batch}-${i}`,
                    timestamp: new Date(stamp),
                    attempts: 1,
                    body: admitted,
                  })),
                ),
              ),
            ),
            120_000,
          );
        } finally {
          finished = true;
          await sampling;
        }
        if (samplingError) throw samplingError;
        const wall_ms = performance.now() - start;
        const profile = await cdp.request("Profiler.stop");
        const profileName = `${shape}-${phase}.cpuprofile`;
        const profileText = JSON.stringify(profile.profile);
        assert.ok(
          Buffer.byteLength(profileText) <= 32 * 1024 * 1024,
          "CPU profile byte bound",
        );
        await writeFile(path.join(output, profileName), profileText);
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
          wire_bytes: admitted.byteLength,
          decoded_bytes: decoded,
          family_rows: Object.fromEntries(
            Object.entries(message.families).map(([key, value]) => [
              key,
              value.length,
            ]),
          ),
          wall_ms,
          results,
          census,
          four_family_and_chunk_digests: actualRows,
          health,
          argument_sha256:
            typeof restored.call_args === "string"
              ? hash(Buffer.from(restored.call_args))
              : null,
          before,
          after,
          samples,
          profile: profileName,
          observed_heap_max: Math.max(
            Number(before.usedSize),
            Number(after.usedSize),
            ...samples.map((sample) => Number(sample.usedSize)),
          ),
          changed_rows_rolled_back: phase === "late-failure" ? true : null,
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
        const originals = [
          payload("string", 9_000_003),
          payload("string", 9_000_004),
        ];
        for (const original of originals) {
          original.families.extrinsicRows[0].call_args = JSON.stringify({
            s: "q".repeat(2_100_000),
          });
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
          original.families.blockRows[0].chain_event_count = 1;
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
        assert.ok(Buffer.byteLength(raw) > SYNC_BATCH_MAX_DECODED_BYTES);
        const refused = gzipSync(raw);
        assert.ok(refused.length < 128 * 1024);
        const envelope = [
          {
            id: "oversized-original",
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
          2,
        );
        const quarantined = await deadline(
          worker.queue("sync-batches-dlq", envelope),
          30_000,
        );
        assert.ok(quarantined.ackAll || quarantined.explicitAcks.length === 1);
        const receipt = await db
          .prepare(
            "SELECT body_sha256,encoding,payload FROM sync_dead_letters WHERE message_id='oversized-original'",
          )
          .first<{ body_sha256: string; encoding: string; payload: string }>();
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
          4,
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
                `SELECT * FROM ${table} WHERE block_number IN (9000003,9000004) ORDER BY block_number`,
              )
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
            "SELECT body_sha256,payload FROM sync_dead_letters WHERE message_id='oversized-original'",
          )
          .first();
        assert.equal(stillRetained?.body_sha256, hash(refused));
        assert.equal(stillRetained?.payload, receipt.payload);
        observations.push({
          shape: "oversized-expansion",
          retry_without_ack: true,
          exact_dlq_sha256: receipt.body_sha256,
          repaired_whole_blocks: 2,
          original_retained: true,
          workerd_process: await processMemory(),
          native_limits: await nativeLimits(),
        });
        await save();
      }
    } finally {
      cdp?.close();
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
