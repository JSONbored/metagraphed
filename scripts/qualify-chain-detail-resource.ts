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
    messages: 10,
    simultaneous_calls: 2,
    scheduling: "driver-imposed, not Miniflare max_concurrency",
  },
  load_identity:
    "all messages repeat the same synthetic block; no fresh-insert throughput claim",
  observations: [],
};
const observations = report.observations as unknown[];
const save = () =>
  writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const stamp = 1_790_090_000_000;

function payload(shape: string) {
  const block = 9_000_001;
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
            { length: shape === "objects" ? 12_000 : 0 },
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
  return message;
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
  // Same native bundler as deploy qualification; --dry-run never uploads.
  execFileSync(
    "npx",
    [
      "wrangler",
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
  // Workerd treats every export of the entry module as a service entrypoint.
  // The raw deploy bundle also exposes test constants. Import it unchanged as
  // a child module; this facade adds no handler or controller of its own.
  const facade = `export { default } from ${JSON.stringify(`./${modules[0]}`)};\n`;
  const facadePath = path.join(temporary, "measurement-entry.js");
  await writeFile(facadePath, facade);
  report.entry_facade = {
    source: facade,
    sha256: hash(Buffer.from(facade)),
    limitation:
      "raw configured entry rejected by pinned Workerd; production entrypoint parity is unqualified",
    raw_entry_failure_run: 38741940703,
  };
  const nativeModules = [
    { type: "ESModule" as const, path: facadePath },
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
  for (const shape of ["small", "string", "objects"]) {
    const message = payload(shape);
    const decoded = Buffer.byteLength(JSON.stringify(message));
    assert.ok(decoded <= SYNC_BATCH_MAX_DECODED_BYTES);
    const bytes = await compressSyncBatchMessage(message, 128 * 1024);
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
      for (const phase of ["first", "warm", "late-failure", "repair-replay"]) {
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
              at_ms: performance.now(),
              ...(await cdp!.request("Runtime.getHeapUsage")),
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
              Array.from({ length: 2 }, (_, batch) =>
                worker.queue(
                  "sync-batches",
                  Array.from({ length: 10 }, (_, i) => ({
                    id: `${shape}-${phase}-${batch}-${i}`,
                    timestamp: new Date(stamp),
                    attempts: 1,
                    body: bytes,
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
            assert.equal(result.retryMessages.length, 10);
          else assert.ok(result.ackAll || result.explicitAcks.length === 10);
        }
        const census = await db
          .prepare(
            "SELECT (SELECT count(*) FROM chain_detail_blocks) blocks,(SELECT count(*) FROM chain_detail_extrinsics) extrinsics,(SELECT count(*) FROM chain_detail_chain_events) events,(SELECT count(*) FROM chain_detail_account_events) accounts",
          )
          .first();
        assert.deepEqual(
          census,
          {
            blocks: 1,
            extrinsics: 1,
            events: message.families.chainEventRows.length,
            accounts: 1,
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
          wire_bytes: bytes.byteLength,
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
          true_peak_qualified: false,
        });
        await save();
      }
    } finally {
      cdp?.close();
      await deadline(runtime.dispose(), 10_000);
    }
  }
  report.status = "observed-not-capacity-qualified";
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await save();
  await rm(temporary, { recursive: true, force: true });
}
