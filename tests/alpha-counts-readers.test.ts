import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, test, vi } from "vitest";
import { createD1Store } from "../src/d1-store.ts";
import { ALPHA_RECEIVER_OWNER_TABLES } from "../src/alpha-capture-reader.ts";
import {
  alphaCountAnchorSchema,
  writeAlphaCountsD1,
  type AlphaCountAnchor,
} from "../src/alpha-counts-d1.ts";
import {
  readCanonicalNominatorCounts,
  readCanonicalNominatorCountCoverage,
} from "../src/alpha-counts-reader.ts";
import {
  ALPHA_GENESIS,
  ALPHA_RUNTIMES,
} from "../src/alpha-runtime-identity.ts";
import { readDirectoryNominatorCounts } from "../src/neuron-snapshot-read.ts";
import {
  fillConfirmedZeros,
  nominatorCountsByHotkey,
} from "../src/validator-nominator-summary.ts";
import {
  runValidatorNominatorCountsStalenessWatchdog,
} from "../src/validator-nominator-counts-staleness-watchdog.ts";
import type { PgSql } from "../src/pg-sql.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";

const STAMP = 1_790_090_000_000;
const owners = [
  ...ALPHA_RECEIVER_OWNER_TABLES,
  "validator_nominator_counts",
  "validator_nominator_counts_passes",
  "neurons",
];
const runtimes: Miniflare[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

async function fixture(migrated = true) {
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
  });
  runtimes.push(runtime);
  const db = await runtime.getD1Database("DB");
  const files = ["0010_ledger_state.sql"];
  if (migrated) files.push("0039_alpha_runtime_receiver.sql");
  for (const file of files) {
    const source = readFileSync(
      new URL("../migrations/d1/" + file, import.meta.url),
      "utf8",
    );
    for (const statement of source.split("-- statement-breakpoint")) {
      if (statement.trim()) await db.prepare(statement).run();
    }
  }
  return db;
}

function environment(db: D1Database, tables = owners) {
  return dataApiEnv({
    D1_STATE: db,
    D1_STATE_TABLES: tables.join(","),
    HYPERDRIVE: undefined,
  });
}

function anchor(at = STAMP, block = 100): AlphaCountAnchor {
  return {
    captured_at: at,
    block_number: block,
    block_hash: "0x" + block.toString(16).padStart(64, "0"),
    genesis_hash: ALPHA_GENESIS,
    spec_version: 479,
    code_hash: ALPHA_RUNTIMES[479].code,
    metadata_sha256: ALPHA_RUNTIMES[479].metadata,
    scanned_legacy: 0,
    scanned_v2: 5,
    distinct_members: 5,
    excluded_root_members: 5,
  };
}

async function capture(db: D1Database, value = anchor()) {
  await db
    .prepare(
      "INSERT OR IGNORE INTO alpha_runtime_metadata(sha256,code_hash,spec_version,scale_hex) VALUES(?,?,?,?)",
    )
    .bind(
      value.metadata_sha256,
      value.code_hash,
      value.spec_version,
      readFileSync(
        new URL("./fixtures/alpha-runtime/metadata-479.hex", import.meta.url),
        "utf8",
      ).trim(),
    )
    .run();
  const columns = Object.keys(value);
  const positions = value.distinct_members - value.excluded_root_members;
  await db
    .prepare(
      `INSERT INTO alpha_snapshot_passes(${columns.join(",")},expected_rows,
      expected_chunks,received_rows,received_chunks,completed_at,selected)
      VALUES(${columns.map(() => "?").join(",")},?,1,?,1,?,1)`,
    )
    .bind(...Object.values(value), positions, positions, value.captured_at + 1)
    .run();
}

function row(hotkey = "kept", count = 3, at = STAMP) {
  return { hotkey, nominator_count: count, captured_at: at };
}

async function counts(
  db: D1Database,
  value = anchor(),
  rows = [row("kept", 3, value.captured_at)],
  expected = rows.length,
) {
  return writeAlphaCountsD1(
    createD1Store(db),
    rows,
    value,
    expected,
    value.captured_at + 10,
  );
}

function forbiddenSql() {
  const fallback = vi.fn(async () => {
    throw new Error("cross-store count fallback is forbidden");
  });
  return Object.assign(fallback, { unsafe: fallback }) as unknown as PgSql;
}

test("raw root membership does not need valued positions", async () => {
  const db = await fixture();
  const value = anchor();
  await capture(db, value);
  await counts(db, value, [row("kept", 5)]);
  const rows = await readCanonicalNominatorCounts(environment(db), ["kept"]);
  assert.deepEqual(rows, [
    { hotkey: "kept", nominator_count: 5, scan_at: STAMP },
  ]);
});

test("unvalued originals retain raw membership counts", async () => {
  const db = await fixture();
  const value = { ...anchor(), excluded_root_members: 0 };
  await capture(db, value);
  for (let member = 0; member < 5; member++) {
    await db
      .prepare(
        "INSERT INTO alpha_snapshot_rows(captured_at,coldkey,hotkey,netuid,alpha_evidence) VALUES(?,?,'kept',1,'{}')",
      )
      .bind(STAMP, "member-" + member)
      .run();
  }
  await counts(db, value, [row("kept", 5)]);
  const rows = await readCanonicalNominatorCounts(environment(db), ["kept"]);
  assert.deepEqual(rows, [
    { hotkey: "kept", nominator_count: 5, scan_at: STAMP },
  ]);
});

test("a complete empty raw census permits confirmed zeros", async () => {
  const db = await fixture();
  const value = {
    ...anchor(),
    scanned_v2: 0,
    distinct_members: 0,
    excluded_root_members: 0,
  };
  await capture(db, value);
  await counts(db, value, [], 0);
  const rows = await readCanonicalNominatorCounts(environment(db), ["missing"]);
  assert.deepEqual(rows, [
    { hotkey: "missing", nominator_count: null, scan_at: STAMP },
  ]);
  const confirmed = fillConfirmedZeros(
    rows,
    nominatorCountsByHotkey(rows),
    STAMP + 20,
    1000,
  );
  assert.equal(confirmed.get("missing"), 0);
});

test("canonical counts ignore older clocks and hotkeys", async () => {
  const db = await fixture();
  const older = anchor(STAMP + 1000, 100);
  await capture(db, older);
  await counts(db, older, [
    row("kept", 3, older.captured_at),
    row("left", 2, older.captured_at),
  ]);
  const current = anchor(STAMP, 101);
  await capture(db, current);
  await counts(db, current, [row("kept", 2)]);
  const env = environment(db);
  const rows = await readDirectoryNominatorCounts(forbiddenSql(), env, [
    "kept",
    "left",
    "missing",
  ]);
  assert.deepEqual(rows, [
    { hotkey: "kept", nominator_count: 2, scan_at: STAMP },
    { hotkey: "left", nominator_count: null, scan_at: STAMP },
    { hotkey: "missing", nominator_count: null, scan_at: STAMP },
  ]);
  const confirmed = fillConfirmedZeros(
    rows,
    nominatorCountsByHotkey(rows),
    STAMP + 20,
    1000,
  );
  assert.equal(confirmed.get("kept"), 2);
  assert.equal(confirmed.get("left"), 0);
  assert.equal(confirmed.get("missing"), 0);
  assert.deepEqual(await readCanonicalNominatorCountCoverage(env), {
    latest: STAMP,
    covered: 1,
    total: 1,
  });
});

test("incomplete canonical counts stay unknown", async () => {
  const db = await fixture();
  const older = anchor(STAMP + 1000, 100);
  await capture(db, older);
  await counts(db, older, [row("kept", 3, older.captured_at)]);
  const current = anchor(STAMP, 101);
  await capture(db, current);
  await counts(db, current, [row("kept", 1)], 2);
  const env = environment(db);
  const rows = await readCanonicalNominatorCounts(env, ["kept", "missing"]);
  assert.deepEqual(rows, [
    { hotkey: "kept", nominator_count: null, scan_at: null },
    { hotkey: "missing", nominator_count: null, scan_at: null },
  ]);
  const confirmed = fillConfirmedZeros(
    rows,
    nominatorCountsByHotkey(rows),
    STAMP + 20,
    1000,
  );
  assert.equal(confirmed.size, 0);
  assert.deepEqual(await readCanonicalNominatorCountCoverage(env), {
    latest: STAMP,
    covered: 0,
    total: 1,
  });
  const verdict = await runValidatorNominatorCountsStalenessWatchdog(
    { ...env, VALIDATOR_NOMINATOR_COUNTS_COVERAGE_FLOOR_ROWS: 1 },
    { now: () => STAMP + 20, recordException: async () => false },
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.stale, true);
  assert.equal(verdict.covered_rows, 0);
});

test("terminal receipts require actual unique rows", async () => {
  const db = await fixture();
  const value = anchor();
  await capture(db, value);
  await db
    .prepare(
      "INSERT INTO validator_nominator_counts_passes(captured_at,expected_rows,received_rows,completed_at,alpha_snapshot) VALUES(?,2,2,?,?)",
    )
    .bind(
      STAMP,
      STAMP + 10,
      JSON.stringify(alphaCountAnchorSchema.parse(value)),
    )
    .run();
  await db
    .prepare("INSERT INTO validator_nominator_counts VALUES('kept',3,?)")
    .bind(STAMP)
    .run();
  const env = environment(db);
  assert.deepEqual(await readCanonicalNominatorCounts(env, ["kept"]), [
    { hotkey: "kept", nominator_count: null, scan_at: null },
  ]);
  assert.equal((await readCanonicalNominatorCountCoverage(env))?.covered, 0);
});

test("nonempty raw census cannot certify an empty count pass", async () => {
  const db = await fixture();
  await capture(db);
  await assert.rejects(
    db
      .prepare(
        "INSERT INTO validator_nominator_counts_passes(captured_at,expected_rows,received_rows,completed_at,alpha_snapshot) VALUES(?,0,0,?,?)",
      )
      .bind(STAMP, STAMP + 10, JSON.stringify(anchor()))
      .run(),
    /outside its census/,
  );
  const rows = await readCanonicalNominatorCounts(environment(db), ["kept"]);
  assert.deepEqual(rows, [
    { hotkey: "kept", nominator_count: null, scan_at: null },
  ]);
});

test("legacy count receipts cannot certify Alpha", async () => {
  const db = await fixture();
  await db
    .prepare(
      "INSERT INTO validator_nominator_counts_passes(captured_at,expected_rows,received_rows,completed_at) VALUES(?,1,1,?)",
    )
    .bind(STAMP, STAMP + 10)
    .run();
  await db
    .prepare("INSERT INTO validator_nominator_counts VALUES('kept',3,?)")
    .bind(STAMP)
    .run();
  await capture(db);
  const rows = await readCanonicalNominatorCounts(environment(db), ["kept"]);
  assert.deepEqual(rows, [
    { hotkey: "kept", nominator_count: null, scan_at: null },
  ]);
});

test("malformed newest identity prevents fallback", async () => {
  const db = await fixture();
  await capture(db);
  await counts(db);
  await capture(db, {
    ...anchor(STAMP + 1000, 101),
    code_hash: "0x" + "b".repeat(64),
  });
  const rows = await readCanonicalNominatorCounts(environment(db), ["kept"]);
  assert.deepEqual(rows, []);
  assert.deepEqual(await readCanonicalNominatorCountCoverage(environment(db)), {
    latest: null,
    covered: 0,
    total: 0,
  });
});

test("capture changes cannot race the count read", async () => {
  const db = await fixture();
  await capture(db);
  await counts(db);
  let changed = false;
  const raced = {
    prepare(text: string) {
      let statement = db.prepare(text);
      const wrapper = {
        bind(...values: unknown[]) {
          statement = statement.bind(...values);
          return wrapper;
        },
        async all() {
          const result = await statement.all();
          if (!changed && text.startsWith("SELECT captured_at,block_number")) {
            changed = true;
            await capture(db, anchor(STAMP + 1000, 101));
          }
          return result;
        },
      };
      return wrapper;
    },
    batch: db.batch.bind(db),
  } as unknown as D1Database;
  const rows = await readCanonicalNominatorCounts(environment(raced), ["kept"]);
  assert.deepEqual(rows, [
    { hotkey: "kept", nominator_count: null, scan_at: null },
  ]);
  assert.equal(changed, true);
});

test("split owners and native failures cannot fall back", async () => {
  const db = await fixture();
  await capture(db);
  await counts(db);
  const tables = owners.filter(
    (table) => table !== "validator_nominator_counts_passes",
  );
  const env = environment(db, tables);
  const rows = await readDirectoryNominatorCounts(forbiddenSql(), env, [
    "kept",
  ]);
  assert.deepEqual(rows, []);
  await assert.rejects(readCanonicalNominatorCountCoverage(env), /D1 and Neon/);
  const failed = environment({
    prepare() {
      throw new Error("native count discovery failed");
    },
    batch: db.batch.bind(db),
  } as unknown as D1Database);
  assert.deepEqual(await readCanonicalNominatorCounts(failed, ["kept"]), []);
  await assert.rejects(
    readCanonicalNominatorCountCoverage(failed),
    /discovery failed/,
  );
});

test("pre-migration native count reads still work", async () => {
  const db = await fixture(false);
  await db
    .prepare("INSERT INTO validator_nominator_counts VALUES('kept',3,?)")
    .bind(STAMP)
    .run();
  const env = environment(db);
  assert.equal(await readCanonicalNominatorCounts(env, ["kept"]), null);
  assert.equal(await readCanonicalNominatorCountCoverage(env), null);
  const rows = await readDirectoryNominatorCounts(forbiddenSql(), env, [
    "kept",
  ]);
  assert.deepEqual(rows, [
    { hotkey: "kept", nominator_count: 3, scan_at: STAMP },
  ]);
});

test("empty Alpha state supplies no count or stamp", async () => {
  const db = await fixture();
  const rows = await readCanonicalNominatorCounts(environment(db), ["kept"]);
  assert.deepEqual(rows, []);
  assert.deepEqual(await readCanonicalNominatorCountCoverage(environment(db)), {
    latest: null,
    covered: 0,
    total: 0,
  });
  assert.equal(await readCanonicalNominatorCounts({}, ["kept"]), null);
});
