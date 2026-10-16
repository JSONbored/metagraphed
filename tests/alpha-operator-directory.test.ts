import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, test, vi } from "vitest";
import { createD1Store } from "../src/d1-store.ts";
import { writeNeuronDocuments } from "../src/neuron-documents.ts";
import { neuronSnapshotWrite } from "../src/neurons-neon-write.ts";
import {
  writeAlphaCountsD1,
  type AlphaCountAnchor,
} from "../src/alpha-counts-d1.ts";
import {
  ALPHA_GENESIS,
  ALPHA_RUNTIMES,
} from "../src/alpha-runtime-identity.ts";
import { ValidatorOperatorDirectoryArtifactSchema } from "../schemas-src/routes/validator-operator-directory.ts";
import {
  explorerDirectoriesSnapshotKey,
  KV_EXPLORER_DIRECTORIES_CURRENT,
} from "../src/kv-keys.ts";
import worker, {
  refreshExplorerDirectoryMaterialization,
} from "../workers/data-api.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";

const STAMP = 1_790_090_000_000;
const runtimes: Miniflare[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

async function fixture() {
  vi.useRealTimers();
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
  });
  runtimes.push(runtime);
  const db = await runtime.getD1Database("DB");
  const root = new URL("../migrations/d1/", import.meta.url);
  for (const file of readdirSync(root)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const source = readFileSync(new URL(file, root), "utf8");
    const statements = source
      .split("-- statement-breakpoint")
      .filter((sql) => sql.trim())
      .map((sql) => db.prepare(sql));
    if (statements.length) await db.batch(statements);
  }
  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
    .all<{ name: string }>();
  const values = new Map<string, string>();
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
  } as unknown as ExecutionContext;
  const env = dataApiEnv({
    D1_STATE: db,
    D1_STATE_TABLES: tables.results.map((row) => row.name).join(","),
    HYPERDRIVE: undefined,
    METAGRAPH_CONTROL: {
      async get(key: string, type?: string) {
        const value = values.get(key) ?? null;
        return type === "json" && value !== null ? JSON.parse(value) : value;
      },
      async put(key: string, value: string) {
        values.set(key, value);
      },
      async delete(key: string) {
        values.delete(key);
      },
    },
  });
  const rows = ["kept", "new", "absent", "team-one", "team-two"].map(
    (hotkey, uid) => ({
      netuid: 7,
      uid,
      hotkey,
      coldkey: hotkey.startsWith("team-") ? "team" : hotkey + "-owner",
      captured_at: STAMP,
      block_number: 99,
      stake_tao: 10,
      emission_tao: 1,
      active: true,
      validator_permit: true,
    }),
  );
  await writeNeuronDocuments(createD1Store(db), {
    ...neuronSnapshotWrite(rows, STAMP + 1),
    pass: {
      capturedAt: STAMP,
      receivedRows: rows.length,
      expectedRows: rows.length,
      nowMs: STAMP + 1,
    },
  });
  vi.spyOn(Date, "now").mockReturnValue(STAMP + 20_000);
  const capture = async (at = STAMP, block = 100, members = 3) => {
    const anchor: AlphaCountAnchor = {
      captured_at: at,
      block_number: block,
      block_hash: "0x" + block.toString(16).padStart(64, "0"),
      genesis_hash: ALPHA_GENESIS,
      spec_version: 479,
      code_hash: ALPHA_RUNTIMES[479].code,
      metadata_sha256: ALPHA_RUNTIMES[479].metadata,
      scanned_legacy: 0,
      scanned_v2: members,
      distinct_members: members,
      excluded_root_members: members,
    };
    await db
      .prepare(
        "INSERT OR IGNORE INTO alpha_runtime_metadata(sha256,code_hash,spec_version,scale_hex) VALUES(?,?,?,?)",
      )
      .bind(
        anchor.metadata_sha256,
        anchor.code_hash,
        anchor.spec_version,
        readFileSync(
          new URL("./fixtures/alpha-runtime/metadata-479.hex", import.meta.url),
          "utf8",
        ).trim(),
      )
      .run();
    const columns = Object.keys(anchor);
    await db
      .prepare(
        `INSERT INTO alpha_snapshot_passes(${columns.join(",")},expected_rows,
        expected_chunks,received_rows,received_chunks,completed_at,selected)
        VALUES(${columns.map(() => "?").join(",")},0,1,0,1,?,1)`,
      )
      .bind(...Object.values(anchor), at + 1)
      .run();
    return anchor;
  };
  const counts = (
    anchor: AlphaCountAnchor,
    hotkey: string,
    count: number,
    expected = 1,
  ) =>
    writeAlphaCountsD1(
      createD1Store(db),
      [{ hotkey, nominator_count: count, captured_at: anchor.captured_at }],
      anchor,
      expected,
      STAMP + 10_000,
    );
  const read = async (environment = env) => {
    const response = await worker.fetch(
      new Request("https://api.metagraph.sh/api/v1/validators/operators"),
      environment,
      ctx,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const data = ValidatorOperatorDirectoryArtifactSchema.parse(
      await response.json(),
    );
    await Promise.all(pending.splice(0));
    return data;
  };
  const publish = async () => {
    const ready = await refreshExplorerDirectoryMaterialization(
      env,
      ctx,
      STAMP,
    );
    assert.equal(ready, true);
  };
  return { db, env, values, capture, counts, read, publish };
}

test("materialized operators requalify counts without a new neuron snapshot", async () => {
  const f = await fixture();
  const first = await f.capture();
  await f.counts(first, "kept", 3);
  await f.publish();
  const original = new Map(f.values);
  const initial = await f.read();
  const initialCounts = new Map(
    initial.operators.map((operator) => [
      operator.primary_hotkey,
      operator.nominator_count,
    ]),
  );
  assert.equal(initialCounts.get("kept"), 3);
  assert.equal(initialCounts.get("new"), 0);
  assert.equal(initialCounts.get("absent"), 0);
  assert.equal(initialCounts.get("team-one"), null);

  const current = await f.capture(STAMP + 1000, 101, 2);
  const pending = await f.read();
  assert.equal(pending.captured_at, initial.captured_at);
  assert.equal(pending.validator_count, initial.validator_count);
  assert.ok(pending.operators.every((row) => row.nominator_count === null));
  assert.deepEqual(f.values, original);

  await f.counts(current, "new", 1, 2);
  const partial = await f.read();
  assert.ok(partial.operators.every((row) => row.nominator_count === null));
  await f.counts(current, "team-one", 1, 2);
  const complete = await f.read();
  const currentCounts = new Map(
    complete.operators.map((operator) => [
      operator.primary_hotkey,
      operator.nominator_count,
    ]),
  );
  assert.equal(currentCounts.get("kept"), 0);
  assert.equal(currentCounts.get("new"), 1);
  assert.equal(currentCounts.get("absent"), 0);
  assert.equal(currentCounts.get("team-one"), null);
  assert.equal(complete.captured_at, initial.captured_at);
  assert.deepEqual(f.values, original);
  const pointer = JSON.parse(f.values.get(KV_EXPLORER_DIRECTORIES_CURRENT)!);
  assert.equal(pointer.captured_at, STAMP);
  const key = explorerDirectoriesSnapshotKey(STAMP);
  const stored = JSON.parse(f.values.get(key)!);
  assert.deepEqual(stored.validators, initial);
});

test.each(["query failure", "split ownership"])(
  "materialized operator counts stay unknown after %s",
  async (failure) => {
    const f = await fixture();
    const anchor = await f.capture();
    await f.counts(anchor, "kept", 3);
    await f.publish();
    let fallbackReads = 0;
    const env = dataApiEnv({
      ...f.env,
      D1_STATE: {
        prepare(sql: string) {
          if (failure === "query failure" && sql.startsWith("WITH canonical")) {
            throw new Error("synthetic native count read failure");
          }
          return f.db.prepare(sql);
        },
        batch: f.db.batch.bind(f.db),
      },
      D1_STATE_TABLES:
        failure === "split ownership"
          ? f.env.D1_STATE_TABLES!.split(",")
              .filter((table) => table !== "validator_nominator_counts_passes")
              .join(",")
          : f.env.D1_STATE_TABLES,
      HYPERDRIVE: {
        get connectionString() {
          fallbackReads++;
          return undefined;
        },
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const data = await f.read(env);
    assert.equal(data.validator_count, 5);
    assert.equal(data.operator_count, 4);
    assert.ok(data.operators.every((row) => row.nominator_count === null));
    assert.equal(fallbackReads, 0);
  },
);
