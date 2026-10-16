import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, test, vi } from "vitest";
import { handleD1StateExport } from "../src/d1-state-export.ts";
import { D1_EXPORT_COLUMNS } from "../src/d1-export-columns.ts";
import { createD1Store } from "../src/d1-store.ts";
import { writeSelfStakeSnapshotD1 } from "../src/self-stake-snapshot-d1.ts";
import { NOMINATOR_POSITIONS_COVERAGE_SQL } from "../src/nominator-scan-coverage.ts";
import { writeNominatorPositionsD1 } from "../src/ledger-d1.ts";
import { alphaCaptureState } from "../src/alpha-capture-reader.ts";
import { ALPHA_RUNTIMES } from "../src/alpha-runtime-identity.ts";
import * as ownerSplit from "../src/owner-capture-positions.ts";
import {
  writeAlphaSnapshotD1,
  readAlphaSnapshotResumeD1,
} from "../src/alpha-snapshot-d1.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
import worker from "../workers/data-api.ts";
import type { D1StoreBinding } from "../src/d1-store.ts";
import type { Row } from "./row-type.ts";

const frozen = JSON.parse(
  readFileSync(
    new URL("./fixtures/alpha-runtime/frozen-478.json", import.meta.url),
    "utf8",
  ),
) as Row;
const runtimes: Miniflare[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of runtimes.splice(0)) await r.dispose();
});
async function fixture(includeAlpha = true) {
  vi.useRealTimers();
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
  });
  runtimes.push(runtime);
  const db = await runtime.getD1Database("DB");
  for (const name of [
    "0010_ledger_state.sql",
    "0016_archive_export_revisions.sql",
    ...(includeAlpha ? ["0039_alpha_runtime_receiver.sql"] : []),
  ])
    for (const statement of readFileSync(
      new URL(`../migrations/d1/${name}`, import.meta.url),
      "utf8",
    ).split("-- statement-breakpoint"))
      if (statement.trim()) await db.prepare(statement).run();
  return db;
}
const baseAt = frozen.alpha_snapshot.captured_at;
const row = (coldkey = "alice", hotkey = "hot") => ({
  coldkey,
  hotkey,
  netuid: 23,
  evidence: structuredClone(frozen.members[0].evidence),
});
const packet = (rows = [row()], overrides: Row = {}) => {
  const total = overrides.total_rows ?? rows.length;
  const excluded = overrides.excluded_root_members ?? 0;
  const distinct = overrides.distinct_members ?? total + excluded;
  return {
    alpha_snapshot: {
      ...frozen.alpha_snapshot,
      scanned_legacy: 0,
      scanned_v2: distinct,
      distinct_members: distinct,
      excluded_root_members: excluded,
      total_rows: rows.length,
      total_chunks: 1,
      index: 0,
      ...overrides,
    },
    rows,
  };
};
const packet479 = (rows = [row()], overrides: Row = {}) =>
  packet(rows, {
    spec_version: 479,
    code_hash: ALPHA_RUNTIMES[479].code,
    metadata_sha256: ALPHA_RUNTIMES[479].metadata,
    metadata_scale_hex: undefined,
    ...overrides,
  });
const rowsOf = async (db: D1Database) =>
  (
    await db
      .prepare("SELECT * FROM nominator_positions ORDER BY coldkey")
      .all<Row>()
  ).results;
const write = (db: D1StoreBinding, p: Row) =>
  writeAlphaSnapshotD1(db, p, baseAt + 100000);

test("legacy-only originals survive exact native hashing and reversed owner order cannot change a receipt", async () => {
  const db = await fixture();
  const rows = [row("bob"), row("alice")];
  for (const item of rows) {
    item.evidence.share = { legacy_bits: (1n << 64n).toString(), v2: null };
    item.evidence.denominator = {
      legacy_bits: (1n << 64n).toString(),
      v2: null,
    };
  }
  const value = packet(rows, { scanned_legacy: 2, scanned_v2: 0 });
  const accepted = await write(db, value);
  const replay = await write(db, { ...value, rows: [...rows].reverse() });
  assert.equal(replay.alpha_snapshot.sha256, accepted.alpha_snapshot.sha256);
  assert.equal(replay.alpha_snapshot.received_rows, 2);
  assert.equal(replay.alpha_snapshot.received_chunks, 1);
  for (const stored of await rowsOf(db)) {
    assert.equal(stored.alpha_rao, rows[0].evidence.total_alpha_rao);
    const original = JSON.parse(stored.alpha_evidence);
    assert.equal(original.share.v2, null);
    assert.equal(original.denominator.v2, null);
  }
});

test("missing or corrupt post-commit chunk readback never acknowledges or recounts a native capture", async () => {
  for (const corrupt of [null, { sha256: "wrong" }, { applied: 0 }]) {
    const db = await fixture();
    let interceptedReadbacks = 0;
    const binding = {
      batch: db.batch.bind(db),
      prepare(sql: string) {
        const statement = db.prepare(sql);
        if (sql.startsWith("SELECT c.sha256,c.applied,p.received_rows")) {
          // The native statement is an RPC proxy. Return a readback adapter
          // instead of assigning methods on that proxy; the commit stays native.
          return {
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return {
                async all<T>() {
                  interceptedReadbacks++;
                  const result = await bound.all<T>();
                  return {
                    ...result,
                    results:
                      corrupt === null
                        ? []
                        : [
                            {
                              ...(result.results[0] as Record<string, unknown>),
                              ...corrupt,
                            } as T,
                          ],
                  };
                },
              } as D1PreparedStatement;
            },
          } as D1PreparedStatement;
        }
        return statement;
      },
    } as D1StoreBinding;
    await assert.rejects(write(binding, packet()), /not durably acknowledged/);
    assert.equal(interceptedReadbacks, 1);
    assert.equal(
      (await rowsOf(db)).length,
      1,
      "the original native commit remains durable",
    );
    const replay = await write(db, packet());
    assert.equal(replay.alpha_snapshot.received_rows, 1);
    assert.equal(replay.alpha_snapshot.received_chunks, 1);
  }
});

test("resume and capture require their declared owner and report storage errors as unacknowledged", async () => {
  const db = await fixture(false);
  const send = (body: Row, environment: ReturnType<typeof dataApiEnv>) =>
    worker.fetch(
      new Request(
        "https://api.metagraph.sh/api/v1/internal/nominator-positions-sync",
        {
          method: "POST",
          headers: { "x-nominator-positions-sync-token": "fixture-token" },
          body: JSON.stringify(body),
        },
      ),
      environment,
      {} as ExecutionContext,
    );
  const environment = dataApiEnv({
    D1_STATE: db,
    D1_STATE_TABLES:
      "nominator_positions,nominator_positions_passes,nominator_scan_receipts",
    NOMINATOR_POSITIONS_SYNC_SECRET: "fixture-token",
  });
  for (const body of [{ alpha_snapshot_resume: true }, packet()]) {
    const absent = dataApiEnv({ ...environment, D1_STATE_TABLES: undefined });
    assert.equal((await send(body, absent)).status, 503);
    assert.equal(
      (await send(body, environment)).status,
      502,
      "missing native tables are storage failures, never a successful ACK",
    );
  }
});

test("partial and replayed chunks do not expose new serving rows or invent a complete pass", async () => {
  const db = await fixture();
  await db
    .prepare(
      "INSERT INTO nominator_positions(coldkey,hotkey,netuid,share_fraction,captured_at,source) VALUES('old','hot',23,1,?,'alpha'),('owner','other',23,1,?,'self-stake')",
    )
    .bind(baseAt - 1, baseAt - 1)
    .run();
  const first = packet([row("alice")], {
    total_rows: 2,
    total_chunks: 2,
    index: 0,
  });
  const a = await write(db, first);
  assert.equal(a.alpha_snapshot.complete, false);
  assert.deepEqual(
    (await rowsOf(db)).map((r) => r.coldkey),
    ["old", "owner"],
  );
  const replay = await write(db, first);
  assert.equal(replay.alpha_snapshot.received_rows, 1);
  const last = packet([row("bob")], {
    total_rows: 2,
    total_chunks: 2,
    index: 1,
    metadata_scale_hex: undefined,
  });
  const b = await write(db, last);
  assert.equal(b.alpha_snapshot.complete, true);
  assert.equal(b.alpha_snapshot.selected, 1);
  const rows = await rowsOf(db);
  assert.deepEqual(
    rows.map((r) => r.coldkey),
    ["alice", "bob", "owner"],
  );
  assert.equal(rows[0].alpha_rao, "1633251152");
  assert.equal(rows[0].shares, null);
  assert.deepEqual(JSON.parse(rows[0].alpha_evidence), first.rows[0].evidence);
  assert.equal(
    (
      await db
        .prepare(
          "SELECT received_rows,completed_at FROM nominator_positions_passes",
        )
        .first()
    )?.received_rows,
    2,
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) AS n FROM alpha_snapshot_rows").first())
      ?.n,
    2,
  );
  await write(db, first);
  assert.deepEqual(
    (await rowsOf(db)).map((r) => r.coldkey),
    ["alice", "bob", "owner"],
  );
});

test("conflicting replay, overlapping owner ranges and inconsistent same-block pool context roll back", async () => {
  const db = await fixture();
  const first = packet([row("alice")], {
    total_rows: 2,
    total_chunks: 2,
    index: 0,
  });
  await write(db, first);
  const changed = structuredClone(first);
  changed.rows[0].evidence.total_alpha_rao = "42";
  await assert.rejects(write(db, changed));
  await assert.rejects(
    write(
      db,
      packet([row("alice", "different")], {
        total_rows: 2,
        total_chunks: 2,
        index: 1,
      }),
    ),
  );
  const last = packet([row("bob")], {
    total_rows: 2,
    total_chunks: 2,
    index: 1,
  });
  last.rows[0].evidence.total_alpha_rao = "42";
  await assert.rejects(write(db, last));
  assert.equal(
    (
      await db
        .prepare("SELECT received_rows FROM alpha_snapshot_passes")
        .first()
    )?.received_rows,
    1,
  );
  assert.deepEqual(await rowsOf(db), []);
});

test("a lower finalized block cannot replace a selected higher snapshot despite a newer wall clock", async () => {
  const db = await fixture();
  await write(db, packet([row("new")], { block_number: 9277300 }));
  const stale = await write(
    db,
    packet([row("old")], { captured_at: baseAt + 1, block_number: 9277292 }),
  );
  assert.equal(stale.alpha_snapshot.complete, true);
  assert.equal(stale.alpha_snapshot.selected, 0);
  assert.deepEqual(
    (await rowsOf(db)).map((r) => r.coldkey),
    ["new"],
  );
});

test("complete empty source retires only Alpha and old writers cannot erase qualified evidence", async () => {
  const db = await fixture();
  await write(db, packet());
  await assert.rejects(
    db
      .prepare(
        "INSERT INTO nominator_positions(coldkey,hotkey,netuid,share_fraction,captured_at,source) VALUES('alice','hot',23,1,?,'alpha') ON CONFLICT(coldkey,hotkey,netuid) DO UPDATE SET share_fraction=excluded.share_fraction",
      )
      .bind(baseAt + 1)
      .run(),
  );
  await assert.rejects(
    db
      .prepare(
        "INSERT INTO nominator_positions(coldkey,hotkey,netuid,share_fraction,captured_at,source) VALUES('alice','hot',23,1,?,'self-stake') ON CONFLICT(coldkey,hotkey,netuid) DO UPDATE SET source=excluded.source",
      )
      .bind(baseAt + 1)
      .run(),
  );
  await db
    .prepare(
      "INSERT INTO nominator_positions(coldkey,hotkey,netuid,share_fraction,captured_at,source) VALUES('owner','other',23,1,?,'self-stake')",
    )
    .bind(baseAt + 1)
    .run();
  await write(
    db,
    packet([], { captured_at: baseAt + 2, block_number: 9277300 }),
  );
  assert.deepEqual(
    (await rowsOf(db)).map((r) => r.coldkey),
    ["owner"],
  );
});

test("ignored promotion writes cannot publish a receipt; failed transaction preserves prior serving state", async () => {
  const db = await fixture();
  await db
    .prepare(
      "CREATE TRIGGER refuse_alpha BEFORE INSERT ON nominator_positions BEGIN SELECT RAISE(IGNORE); END",
    )
    .run();
  await assert.rejects(write(db, packet()));
  assert.deepEqual(await rowsOf(db), []);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM alpha_snapshot_passes")
        .first()
    )?.n,
    0,
  );
});

test("lost committed response is resolved by exact receipts without recounting or restoring retired rows", async () => {
  const db = await fixture();
  let lose = true;
  const binding = {
    prepare: db.prepare.bind(db),
    async batch(statements: D1PreparedStatement[]) {
      const result = await db.batch(statements);
      if (lose) {
        lose = false;
        throw new Error("commit reply lost");
      }
      return result;
    },
  } as unknown as D1StoreBinding;
  await assert.rejects(write(binding, packet()));
  assert.equal((await rowsOf(db))[0].alpha_rao, "1633251152");
  const result = await write(db, packet());
  assert.equal(result.alpha_snapshot.received_rows, 1);
  assert(result.alpha_snapshot.complete);
});

test("internal route enforces its existing secret and native owner; code/metadata/census mismatches refuse acknowledgment", async () => {
  const db = await fixture();
  const p = packet();
  const env = dataApiEnv({
    D1_STATE: db,
    D1_STATE_TABLES:
      "nominator_positions,nominator_positions_passes,nominator_scan_receipts",
    NOMINATOR_POSITIONS_SYNC_SECRET: "fixture-token",
  });
  const request = (body: Row, secret = "fixture-token") =>
    new Request(
      "https://api.metagraph.sh/api/v1/internal/nominator-positions-sync",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-nominator-positions-sync-token": secret,
        },
        body: JSON.stringify(body),
      },
    );
  assert.equal(
    (await worker.fetch(request(p, "wrong"), env, {} as never)).status,
    401,
  );
  assert.equal(
    (
      await worker.fetch(
        request(p),
        dataApiEnv({ ...env, D1_STATE_TABLES: "" }),
        {} as never,
      )
    ).status,
    503,
  );
  for (const fields of [
    { code_hash: "0x" + "f".repeat(64) },
    { metadata_sha256: "f".repeat(64) },
    {
      metadata_scale_hex:
        p.alpha_snapshot.metadata_scale_hex.slice(0, -2) + "00",
    },
    { index: 1 },
    { total_rows: 2 },
    { genesis_hash: "0x" + "f".repeat(64) },
  ])
    assert.equal(
      (await worker.fetch(request(packet([row()], fields)), env, {} as never))
        .status,
      400,
    );
  const response = await worker.fetch(request(p), env, {} as never);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Row;
  assert(body.alpha_snapshot.complete);
});

test("partial staging reserves bounded census and never purges uncompleted originals to admit another pass", async () => {
  const db = await fixture();
  await write(
    db,
    packet([row()], {
      scanned_v2: 1000000,
      total_rows: 1000000,
      total_chunks: 1000,
    }),
  );
  await assert.rejects(
    write(
      db,
      packet([row("next")], { captured_at: baseAt + 1, block_number: 9277300 }),
    ),
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) AS n FROM alpha_snapshot_rows").first())
      ?.n,
    1,
  );
  assert.deepEqual(await rowsOf(db), []);
});

test("native receiver matches the shared producer digest/census golden and exports only at full selection", async () => {
  const db = await fixture();
  const golden = JSON.parse(
    readFileSync(
      new URL("./fixtures/alpha-runtime/receiver-golden.json", import.meta.url),
      "utf8",
    ),
  ) as Row;
  const body = {
    ...golden.packet,
    alpha_snapshot: {
      ...golden.packet.alpha_snapshot,
      metadata_scale_hex: frozen.alpha_snapshot.metadata_scale_hex,
    },
  };
  const reply = await write(db, body);
  assert.deepEqual(JSON.parse(JSON.stringify(reply)), golden.reply);
  const revision = (
    await db
      .prepare(
        "SELECT revision FROM archive_export_revisions WHERE table_name='nominator_positions'",
      )
      .first()
  )?.revision;
  await write(db, body);
  assert.equal(
    (
      await db
        .prepare(
          "SELECT revision FROM archive_export_revisions WHERE table_name='nominator_positions'",
        )
        .first()
    )?.revision,
    revision,
    "receipt replay does not trigger another unchanged serving export",
  );
});

test("complete promotion owns coverage receipts and mixed self-stake delivery preserves canonical Alpha", async () => {
  const db = await fixture();
  await write(db, packet([row("alice"), row("bob")]));
  const coverage = await db
    .prepare(NOMINATOR_POSITIONS_COVERAGE_SQL)
    .bind(baseAt - 86400000)
    .first<Row>();
  assert.equal(coverage?.covered, 2);
  assert.equal(coverage?.received_rows, 2);
  assert.equal(coverage?.expected_rows, 2);
  assert.notEqual(coverage?.completed_at, null);
  const at = baseAt + 1;
  const incoming = [
    {
      coldkey: "alice",
      hotkey: "hot",
      netuid: 23,
      share_fraction: 1,
      shares: null,
      captured_at: at,
    },
    {
      coldkey: "carol",
      hotkey: "other",
      netuid: 23,
      share_fraction: 1,
      shares: null,
      captured_at: at,
    },
  ];
  const meta = {
    captured_at: at,
    scanned_pairs: 2,
    total_rows: 2,
    total_chunks: 1,
    index: 0,
  };
  const reply = await writeSelfStakeSnapshotD1(
    createD1Store(db),
    incoming,
    meta,
    at + 1,
  );
  assert.equal(reply.snapshot.complete, true);
  assert.equal(reply.snapshot.source_rows, 1);
  assert.equal(reply.snapshot.shadowed_rows, 1);
  assert.equal(reply.snapshot.alpha_captured_at, baseAt);
  const current = await rowsOf(db);
  assert.deepEqual(
    current.map((r) => [r.coldkey, r.source, r.captured_at]),
    [
      ["alice", "alpha", baseAt],
      ["bob", "alpha", baseAt],
      ["carol", "self-stake", at],
    ],
  );
  const again = await writeSelfStakeSnapshotD1(
    createD1Store(db),
    incoming,
    meta,
    at + 2,
  );
  assert.equal(again.snapshot.shadowed_rows, 1);
  assert.equal(again.snapshot.source_rows, 1);
});
test("max-width positions stay inside native binding limits and use one pool owner", async () => {
  const db = await fixture();
  const rows = Array.from({ length: 2500 }, (_, i) =>
    row(String(i).padStart(8, "0") + "x".repeat(120), "y".repeat(128)),
  );
  const maximum = {
    legacy_bits: ((1n << 128n) - 1n).toString(),
    v2: { mantissa: "1000000000000000000000", exponent: "9223372036854775807" },
  };
  for (const item of rows)
    item.evidence = {
      share: structuredClone(maximum),
      denominator: structuredClone(maximum),
      total_alpha_rao: "18446744073709551615",
      pool_epoch: "18446744073709551615",
      member_epoch: "18446744073709551615",
    };
  const lengths: number[] = [];
  const bounded = {
    prepare: db.prepare.bind(db),
    batch: async (parts: D1PreparedStatement[]) => db.batch(parts),
  };
  // Capture binds while preserving the native statement implementation.
  bounded.prepare = (sql: string) => {
    const statement = db.prepare(sql);
    const bind = statement.bind.bind(statement);
    statement.bind = (...values: unknown[]) => {
      for (const value of values)
        if (typeof value === "string")
          lengths.push(new TextEncoder().encode(value).byteLength);
      return bind(...values);
    };
    return statement;
  };
  const census = { scanned_legacy: 2500, scanned_v2: 2500 };
  await write(bounded as D1StoreBinding, packet(rows, census));
  assert.ok(Math.max(...lengths) < 2_000_000);
  assert.equal(
    (await db.prepare("SELECT COUNT(*) AS n FROM alpha_snapshot_pools").first())
      ?.n,
    1,
  );
  assert.equal((await rowsOf(db)).length, 2500);
  const duplicate = packet([row(), row()]);
  await assert.rejects(() => write(db, duplicate), /repeats a position/);
});

test("exporter upgrade precedes DDL and rollback is unsafe before first selection", async () => {
  const db = await fixture(false);
  const request = () =>
    new Request("https://example.com/api/v1/internal/state-export", {
      method: "POST",
      headers: { "x-state-export-token": "secret" },
      body: JSON.stringify({ table: "nominator_positions", kind: "schema" }),
    });
  const env = {
    D1_STATE: db,
    D1_STATE_TABLES:
      "nominator_positions,nominator_positions_passes,nominator_scan_receipts",
    D1_EXPORT_REVISIONS: "enabled",
    STATE_EXPORT_SECRET: "secret",
  };
  assert.equal((await handleD1StateExport(request(), env)).status, 200);
  for (const sql of readFileSync(
    new URL(
      "../migrations/d1/0039_alpha_runtime_receiver.sql",
      import.meta.url,
    ),
    "utf8",
  ).split("-- statement-breakpoint"))
    if (sql.trim()) await db.prepare(sql).run();
  assert.equal(
    (
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM alpha_snapshot_passes WHERE selected=1",
        )
        .first()
    )?.n,
    0,
  );
  const policy = D1_EXPORT_COLUMNS as Record<string, string>;
  const current = policy.nominator_positions;
  try {
    policy.nominator_positions = current.replace(
      " alpha_rao alpha_evidence",
      "",
    );
    assert.equal((await handleD1StateExport(request(), env)).status, 503);
  } finally {
    policy.nominator_positions = current;
  }
  const upgraded = await handleD1StateExport(request(), env);
  assert.equal(upgraded.status, 200);
  assert.ok(
    (await upgraded.json<Row>()).columns.some(
      (c: Row) => c.name === "alpha_rao",
    ),
  );
});

test("a multi-chunk packet cannot exceed its whole-pass row census before native I/O", async () => {
  const db = await fixture();
  const read = vi.spyOn(db, "prepare");
  await assert.rejects(
    () =>
      write(
        db,
        packet([row("a"), row("b"), row("c")], {
          total_rows: 2,
          total_chunks: 2,
        }),
      ),
    /census/,
  );
  assert.equal(read.mock.calls.length, 0);
});

test("partial self-stake owners preserve Alpha and refresh disjoint owners without claiming a full census", async () => {
  const db = await fixture();
  await write(db, packet([row("alice"), row("bob")]));
  const at = baseAt + 1;
  const incoming = [
    {
      coldkey: "alice",
      hotkey: "hot",
      netuid: 23,
      share_fraction: 1,
      captured_at: at,
    },
    {
      coldkey: "carol",
      hotkey: "other",
      netuid: 23,
      share_fraction: 1,
      captured_at: at,
    },
  ];
  const payload = {
    rows: incoming,
    source: "self-stake" as const,
    coldkeyMaxCapturedAt: new Map([
      ["alice", at],
      ["carol", at],
    ]),
  };
  const result = await writeNominatorPositionsD1(createD1Store(db), payload);
  assert.equal(result.write?.ok, true);
  assert.deepEqual(
    (await rowsOf(db)).map((r) => [r.coldkey, r.source, r.captured_at]),
    [
      ["alice", "alpha", baseAt],
      ["bob", "alpha", baseAt],
      ["carol", "self-stake", at],
    ],
  );
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM self_stake_snapshot_passes")
        .first()
    )?.n,
    0,
  );
  assert.equal(
    (await writeNominatorPositionsD1(createD1Store(db), payload)).write?.ok,
    true,
  );
});

test("receiver-owned pending identity survives restart and lost acknowledgements until exact replay completes", async () => {
  const db = await fixture();
  const first = packet([row("alice")], { total_rows: 2, total_chunks: 2 });
  await write(db, first);
  const saved = await readAlphaSnapshotResumeD1(db);
  assert.equal(saved.alpha_snapshot_resume?.captured_at, baseAt);
  assert.equal(saved.alpha_snapshot_resume?.expected_rows, 2);
  assert.equal(saved.alpha_snapshot_resume?.expected_chunks, 2);
  for (let restart = 0; restart < 4; restart++) {
    assert.deepEqual(await readAlphaSnapshotResumeD1(db), saved);
    const replay = await write(db, first);
    assert.equal(replay.alpha_snapshot.received_rows, 1);
    assert.equal(replay.alpha_snapshot.received_chunks, 1);
  }
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM alpha_snapshot_passes")
        .first()
    )?.n,
    1,
  );
  await write(
    db,
    packet([row("bob")], { total_rows: 2, total_chunks: 2, index: 1 }),
  );
  assert.deepEqual(await readAlphaSnapshotResumeD1(db), {
    ok: true,
    alpha_snapshot_resume: null,
  });
  const env = dataApiEnv({
    D1_STATE: db,
    D1_STATE_TABLES:
      "nominator_positions,nominator_positions_passes,nominator_scan_receipts",
    NOMINATOR_POSITIONS_SYNC_SECRET: "fixture-token",
  });
  const ctx = {} as ExecutionContext;
  const request = (body: Row, secret = "fixture-token") =>
    new Request(
      "https://api.metagraph.sh/api/v1/internal/nominator-positions-sync",
      {
        method: "POST",
        headers: { "x-nominator-positions-sync-token": secret },
        body: JSON.stringify(body),
      },
    );
  assert.equal(
    (
      await worker.fetch(
        request({ alpha_snapshot_resume: true }, "wrong"),
        env,
        ctx,
      )
    ).status,
    401,
  );
  assert.equal(
    (await worker.fetch(request({ alpha_snapshot_resume: false }), env, ctx))
      .status,
    400,
  );
  assert.equal(
    (
      await worker.fetch(
        request({ alpha_snapshot_resume: true, rows: [] }),
        env,
        ctx,
      )
    ).status,
    400,
  );
  assert.deepEqual(
    await (
      await worker.fetch(request({ alpha_snapshot_resume: true }), env, ctx)
    ).json(),
    { ok: true, alpha_snapshot_resume: null },
  );
  assert.equal(
    (
      await worker.fetch(
        request({ alpha_snapshot_resume: true }),
        dataApiEnv({ NOMINATOR_POSITIONS_SYNC_SECRET: "fixture-token" }),
        ctx,
      )
    ).status,
    503,
  );
});

test("cross-language v2 receipts match actual native receiver for empty and float-format boundaries, including lost ACK replay", async () => {
  const vectors = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/alpha-runtime/self-stake-receipt-v2.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Row[];
  for (const { body, reply } of vectors) {
    const db = await fixture();
    for (let attempt = 0; attempt < 2; attempt++) {
      const actual = await writeSelfStakeSnapshotD1(
        createD1Store(db),
        body.rows,
        body.snapshot,
        body.snapshot.captured_at + 1,
      );
      for (const [field, value] of Object.entries(reply.self_stake_snapshot))
        assert.deepEqual(
          actual.snapshot[field as keyof typeof actual.snapshot],
          value,
          field,
        );
    }
  }
});

test("reordered legacy-only packets share one durable digest and preserve absent V2 evidence", async () => {
  const db = await fixture();
  const legacy = JSON.parse(
    readFileSync(
      new URL("./fixtures/alpha-runtime/frozen-454.json", import.meta.url),
      "utf8",
    ),
  ) as Row;
  const evidence = legacy.members[0].evidence;
  assert.equal(evidence.share.v2, null);
  assert.equal(evidence.denominator.v2, null);
  const observations = [row("bob"), row("alice")];
  for (const observation of observations)
    observation.evidence = structuredClone(evidence);
  const body = packet(observations, {
    ...legacy.alpha_snapshot,
    captured_at: baseAt,
    scanned_legacy: 2,
    scanned_v2: 0,
  });
  const acknowledged = await write(db, body);
  assert.equal(acknowledged.alpha_snapshot.complete, true);
  assert.equal(acknowledged.alpha_snapshot.selected, 1);
  assert.equal(acknowledged.alpha_snapshot.received_rows, 2);
  const originalRows = await rowsOf(db);
  assert.deepEqual(
    originalRows.map((position) => position.coldkey),
    ["alice", "bob"],
  );
  for (const position of originalRows) {
    assert.equal(position.alpha_rao, legacy.members[0].expected_alpha_rao);
    assert.equal(position.shares, evidence.share.legacy_bits);
    assert.deepEqual(JSON.parse(position.alpha_evidence), evidence);
  }
  const revision = await db
    .prepare(
      "SELECT revision FROM archive_export_revisions WHERE table_name='nominator_positions'",
    )
    .first();
  const replay = await write(db, {
    ...body,
    rows: [...observations].reverse(),
  });
  assert.equal(
    replay.alpha_snapshot.sha256,
    acknowledged.alpha_snapshot.sha256,
  );
  assert.equal(replay.alpha_snapshot.received_rows, 2);
  assert.equal(replay.alpha_snapshot.received_chunks, 1);
  assert.deepEqual(await rowsOf(db), originalRows);
  assert.deepEqual(
    await db
      .prepare(
        "SELECT revision FROM archive_export_revisions WHERE table_name='nominator_positions'",
      )
      .first(),
    revision,
  );
});

test("missing, mismatched or unapplied receipt readbacks refuse ACK without losing committed originals", async () => {
  const db = await fixture();
  const body = packet();
  const acknowledged = await write(db, body);
  const originalRows = await rowsOf(db);
  for (const fault of ["missing", "digest", "unapplied"] as const) {
    // Only the post-commit readback is faulted; the transaction and subsequent
    // recovery read use the real native database and its durable originals.
    const binding: D1StoreBinding = {
      prepare(sql) {
        if (sql.startsWith("SELECT c.sha256,c.applied,")) {
          if (fault === "missing")
            sql = sql.replace(
              "WHERE c.captured_at=?",
              "WHERE 0=1 AND c.captured_at=?",
            );
          else if (fault === "digest")
            sql = sql.replace("c.sha256,", "'wrong' AS sha256,");
          else sql = sql.replace("c.applied,", "0 AS applied,");
        }
        return db.prepare(sql);
      },
      batch: db.batch.bind(db),
    };
    await assert.rejects(
      write(binding, body),
      /Alpha snapshot chunk was not durably acknowledged/,
    );
    assert.deepEqual(await rowsOf(db), originalRows);
    const replay = await write(db, body);
    assert.equal(
      replay.alpha_snapshot.sha256,
      acknowledged.alpha_snapshot.sha256,
    );
    assert.equal(replay.alpha_snapshot.applied, 1);
    assert.equal(replay.alpha_snapshot.received_rows, 1);
    assert.equal(replay.alpha_snapshot.received_chunks, 1);
    assert.equal(replay.alpha_snapshot.complete, true);
  }
});

test("runtime479 qualifies exact V2 originals under its pinned identity without borrowing an older quantity", async () => {
  const db = await fixture();
  await write(db, packet());
  const evidence = structuredClone(frozen.members[0].evidence);
  evidence.share.v2 = { mantissa: "300000000000000000000", exponent: "-21" };
  evidence.denominator.v2 = {
    mantissa: "1000000000000000000000",
    exponent: "-20",
  };
  evidence.total_alpha_rao = "101";
  evidence.pool_epoch = "5";
  evidence.member_epoch = "5";
  const body = packet([{ ...row("new"), evidence }], {
    captured_at: baseAt + 1,
    block_number: frozen.alpha_snapshot.block_number + 1,
    spec_version: 479,
    code_hash: ALPHA_RUNTIMES[479].code,
    metadata_sha256: ALPHA_RUNTIMES[479].metadata,
    scanned_v2: 1,
    metadata_scale_hex: readFileSync(
      new URL("./fixtures/alpha-runtime/metadata-479.hex", import.meta.url),
      "utf8",
    ).trim(),
  });
  const accepted = await write(db, body);
  assert.equal(accepted.alpha_snapshot.selected, 1);
  assert.equal(accepted.alpha_snapshot.complete, true);
  const stored = (await rowsOf(db))[0];
  assert.equal(stored.coldkey, "new");
  assert.ok(Math.abs(Number(stored.share_fraction) - 0.03) < Number.EPSILON);
  assert.equal(stored.alpha_rao, "3");
  assert.equal(stored.shares, null);
  assert.deepEqual(JSON.parse(stored.alpha_evidence), evidence);
  const state = await alphaCaptureState(createD1Store(db));
  assert.equal(state.capture?.captured_at, baseAt + 1);
  assert.equal(state.capture?.spec_version, 479);
  assert.equal(state.capture?.quantityQualified, true);
  const replay = await write(db, body);
  assert.equal(replay.alpha_snapshot.sha256, accepted.alpha_snapshot.sha256);
  assert.equal(replay.alpha_snapshot.received_rows, 1);
  const originals = (
    await db
      .prepare("SELECT * FROM alpha_snapshot_rows ORDER BY captured_at")
      .all<Row>()
  ).results;
  assert.equal(originals.length, 2);
  assert.equal(originals[0].alpha_rao, "1633251152");
  assert.deepEqual(JSON.parse(originals[1].alpha_evidence), evidence);
  assert.equal(originals[1].alpha_rao, "3");
});

test("runtime479 refuses a legacy census or original legacy lane before native I/O", async () => {
  const db = await fixture();
  const prepare = vi.spyOn(db, "prepare");
  for (const legacy of ["census", "share", "denominator"]) {
    const body = packet([row()], {
      spec_version: 479,
      code_hash: ALPHA_RUNTIMES[479].code,
      metadata_sha256: ALPHA_RUNTIMES[479].metadata,
      scanned_v2: 1,
      metadata_scale_hex: undefined,
    });
    if (legacy === "census") body.alpha_snapshot.scanned_legacy = 1;
    else body.rows[0].evidence[legacy].legacy_bits = "0";
    await assert.rejects(write(db, body), /empty original legacy lanes/);
  }
  assert.equal(prepare.mock.calls.length, 0);
});

test("runtime479 rejects empty or truncated member censuses before native I/O", async () => {
  const db = await fixture();
  await write(db, packet());
  const priorRows = await rowsOf(db);
  const priorCapture = await alphaCaptureState(createD1Store(db));
  const next = {
    captured_at: baseAt + 1,
    block_number: frozen.alpha_snapshot.block_number + 1,
  };
  const prepare = vi.spyOn(db, "prepare");
  for (const body of [
    packet479([], { ...next, scanned_v2: 96252 }),
    packet479([row("truncated")], { ...next, scanned_v2: 96252 }),
    packet479([row("truncated")], {
      ...next,
      scanned_v2: 96252,
      total_rows: 2,
      total_chunks: 2,
    }),
    packet479([row("omitted-member")], { ...next, scanned_v2: 2 }),
    packet479([row("undercounted")], { ...next, scanned_v2: 0 }),
    packet479([row("wrong-scope")], {
      ...next,
      distinct_members: 1,
      excluded_root_members: 2,
    }),
  ])
    await assert.rejects(write(db, body), /census/);
  const missingCensus: Row = packet479([row("missing-census")], next);
  delete missingCensus.alpha_snapshot.distinct_members;
  await assert.rejects(write(db, missingCensus));
  const root = row("root-position");
  root.netuid = 0;
  const rootPosition = packet479([root], {
    ...next,
    distinct_members: 2,
    scanned_v2: 2,
    excluded_root_members: 1,
  });
  await assert.rejects(write(db, rootPosition));
  const wrongMetadata = packet479([row("unqualified")], {
    ...next,
    metadata_scale_hex: frozen.alpha_snapshot.metadata_scale_hex,
  });
  await assert.rejects(write(db, wrongMetadata), /unqualified/);
  assert.equal(prepare.mock.calls.length, 0);
  prepare.mockRestore();
  assert.deepEqual(await rowsOf(db), priorRows);
  const capture = await alphaCaptureState(createD1Store(db));
  assert.deepEqual(capture, priorCapture);
  const countSql = "SELECT COUNT(*) AS n FROM alpha_snapshot_rows";
  const originals = await db.prepare(countSql).first();
  assert.equal(originals?.n, 1);
});

test("runtime479 empty rows require an empty or explicitly root-only census", async () => {
  const db = await fixture();
  await write(db, packet());
  const metadataPath = "./fixtures/alpha-runtime/metadata-479.hex";
  const metadataUrl = new URL(metadataPath, import.meta.url);
  const body = packet479([], {
    captured_at: baseAt + 1,
    block_number: frozen.alpha_snapshot.block_number + 1,
    metadata_scale_hex: readFileSync(metadataUrl, "utf8").trim(),
  });
  const accepted = await write(db, body);
  assert.equal(accepted.alpha_snapshot.scanned_legacy, 0);
  assert.equal(accepted.alpha_snapshot.scanned_v2, 0);
  assert.equal(accepted.alpha_snapshot.received_rows, 0);
  assert.equal(accepted.alpha_snapshot.received_chunks, 1);
  assert.equal(accepted.alpha_snapshot.complete, true);
  assert.equal(accepted.alpha_snapshot.selected, 1);
  assert.deepEqual(await rowsOf(db), []);
  const state = await alphaCaptureState(createD1Store(db));
  assert.equal(state.capture?.captured_at, baseAt + 1);
  assert.equal(state.capture?.quantityQualified, true);
  const rootOnly = packet479([], {
    ...body.alpha_snapshot,
    captured_at: baseAt + 2,
    block_number: frozen.alpha_snapshot.block_number + 2,
    scanned_v2: 2,
    distinct_members: 2,
    excluded_root_members: 2,
    metadata_scale_hex: undefined,
  });
  const excluded = await write(db, rootOnly);
  assert.equal(excluded.alpha_snapshot.current, true);
  assert.equal(excluded.alpha_snapshot.total_rows, 0);
  assert.equal(excluded.alpha_snapshot.scanned_v2, 2);
  assert.equal(excluded.alpha_snapshot.distinct_members, 2);
  assert.equal(excluded.alpha_snapshot.excluded_root_members, 2);
  assert.deepEqual(await rowsOf(db), []);
  const countSql = "SELECT COUNT(*) AS n FROM alpha_snapshot_rows";
  const originals = await db.prepare(countSql).first();
  assert.equal(originals?.n, 1);
});

test("runtime479 retains raw and excluded-root census in every retry identity", async () => {
  const db = await fixture();
  const metadataPath = "./fixtures/alpha-runtime/metadata-479.hex";
  const metadataUrl = new URL(metadataPath, import.meta.url);
  const body = packet479([row("non-root")], {
    scanned_v2: 3,
    distinct_members: 3,
    excluded_root_members: 2,
    metadata_scale_hex: readFileSync(metadataUrl, "utf8").trim(),
  });
  const accepted = await write(db, body);
  assert.equal(accepted.alpha_snapshot.current, true);
  assert.equal(accepted.alpha_snapshot.scanned_v2, 3);
  assert.equal(accepted.alpha_snapshot.distinct_members, 3);
  assert.equal(accepted.alpha_snapshot.excluded_root_members, 2);
  assert.equal(accepted.alpha_snapshot.received_rows, 1);
  const originals = await rowsOf(db);
  assert.equal(originals.length, 1);
  const retained = JSON.parse(originals[0].alpha_evidence);
  assert.deepEqual(retained, body.rows[0].evidence);
  const changed = structuredClone(body);
  changed.alpha_snapshot.scanned_v2 = 4;
  changed.alpha_snapshot.distinct_members = 4;
  changed.alpha_snapshot.excluded_root_members = 3;
  await assert.rejects(write(db, changed));
  assert.deepEqual(await rowsOf(db), originals);
  const replay = await write(db, body);
  assert.equal(replay.alpha_snapshot.sha256, accepted.alpha_snapshot.sha256);
  assert.equal(replay.alpha_snapshot.current, true);
});

test("runtime479 census includes stored zero and retired originals across chunks", async () => {
  const db = await fixture();
  await write(db, packet());
  const priorRows = await rowsOf(db);
  const zero = row("zero");
  zero.evidence.share.v2 = { mantissa: "0", exponent: "-17" };
  zero.evidence.denominator.v2 = {
    mantissa: "1000000000000000000000",
    exponent: "-20",
  };
  zero.evidence.total_alpha_rao = "101";
  zero.evidence.pool_epoch = "5";
  zero.evidence.member_epoch = "4";
  const retired = row("retired");
  retired.evidence = structuredClone(zero.evidence);
  retired.evidence.share.v2 = {
    mantissa: "300000000000000000000",
    exponent: "-21",
  };
  const metadataPath = "./fixtures/alpha-runtime/metadata-479.hex";
  const metadataUrl = new URL(metadataPath, import.meta.url);
  const first = packet479([zero], {
    captured_at: baseAt + 1,
    block_number: frozen.alpha_snapshot.block_number + 1,
    metadata_scale_hex: readFileSync(metadataUrl, "utf8").trim(),
    total_rows: 2,
    total_chunks: 2,
  });
  const staged = await write(db, first);
  assert.equal(staged.alpha_snapshot.complete, false);
  assert.equal(staged.alpha_snapshot.received_rows, 1);
  assert.equal(staged.alpha_snapshot.scanned_v2, 2);
  assert.deepEqual(await rowsOf(db), priorRows);
  const last = packet479([retired], {
    ...first.alpha_snapshot,
    metadata_scale_hex: undefined,
    index: 1,
  });
  const inconsistent = structuredClone(last);
  inconsistent.alpha_snapshot.scanned_v2 = 3;
  const prepare = vi.spyOn(db, "prepare");
  await assert.rejects(write(db, inconsistent), /census/);
  assert.equal(prepare.mock.calls.length, 0);
  prepare.mockRestore();
  assert.deepEqual(await rowsOf(db), priorRows);
  const pending = await readAlphaSnapshotResumeD1(db);
  assert.equal(pending.alpha_snapshot_resume?.expected_rows, 2);
  assert.equal(pending.alpha_snapshot_resume?.scanned_v2, 2);
  assert.equal(pending.alpha_snapshot_resume?.distinct_members, 2);
  assert.equal(pending.alpha_snapshot_resume?.excluded_root_members, 0);
  const accepted = await write(db, last);
  assert.equal(accepted.alpha_snapshot.complete, true);
  assert.equal(accepted.alpha_snapshot.selected, 1);
  assert.equal(accepted.alpha_snapshot.received_rows, 2);
  const current = await rowsOf(db);
  assert.equal(current.length, 2);
  for (const original of [retired, zero]) {
    const stored = current.find((item) => item.coldkey === original.coldkey);
    assert.ok(stored);
    assert.equal(stored.alpha_rao, "0");
    assert.equal(stored.shares, null);
    assert.deepEqual(JSON.parse(stored.alpha_evidence), original.evidence);
  }
  const countSql = "SELECT COUNT(*) AS n FROM alpha_snapshot_rows";
  const originals = await db.prepare(countSql).first();
  assert.equal(originals?.n, 3);
});

test("capture admission requires a retained member original for every row", async () => {
  const db = await fixture();
  const prepare = vi.spyOn(db, "prepare");
  for (const spec of [454, 478, 479] as const) {
    const missing = row();
    missing.evidence.share = { legacy_bits: null, v2: null };
    const body = packet([missing], {
      spec_version: spec,
      code_hash: ALPHA_RUNTIMES[spec].code,
      metadata_sha256: ALPHA_RUNTIMES[spec].metadata,
      metadata_scale_hex: undefined,
    });
    await assert.rejects(write(db, body), /member original is absent/);
  }
  assert.equal(prepare.mock.calls.length, 0);
});

test("completion proves both original member lane counts before any promotion", async () => {
  const db = await fixture();
  await write(db, packet());
  const priorRows = await rowsOf(db);
  const priorCapture = await alphaCaptureState(createD1Store(db));
  const legacyOnly = row("legacy-only");
  legacyOnly.evidence.share = {
    legacy_bits: (1n << 64n).toString(),
    v2: null,
  };
  for (const original of [row("v2-only"), legacyOnly]) {
    const body = packet([original], {
      captured_at: baseAt + 1,
      block_number: frozen.alpha_snapshot.block_number + 1,
      scanned_legacy: 1,
      scanned_v2: 1,
    });
    await assert.rejects(write(db, body));
    assert.deepEqual(await rowsOf(db), priorRows);
    const capture = await alphaCaptureState(createD1Store(db));
    assert.deepEqual(capture, priorCapture);
    const countSql = "SELECT COUNT(*) AS n FROM alpha_snapshot_rows";
    const originals = await db.prepare(countSql).first();
    assert.equal(originals?.n, 1);
    const resume = await readAlphaSnapshotResumeD1(db);
    assert.equal(resume.alpha_snapshot_resume, null);
  }
  const overlap = row("both-lanes");
  overlap.evidence.share.legacy_bits = (1n << 64n).toString();
  const body = packet([overlap], {
    captured_at: baseAt + 1,
    block_number: frozen.alpha_snapshot.block_number + 1,
    scanned_legacy: 1,
    scanned_v2: 1,
  });
  const accepted = await write(db, body);
  assert.equal(accepted.alpha_snapshot.complete, true);
  assert.equal(accepted.alpha_snapshot.selected, 1);
  const current = await rowsOf(db);
  assert.equal(current.length, 1);
  assert.deepEqual(JSON.parse(current[0].alpha_evidence), overlap.evidence);
  const impossibleRoot = packet([overlap], {
    captured_at: baseAt + 2,
    block_number: frozen.alpha_snapshot.block_number + 2,
    scanned_legacy: 1,
    scanned_v2: 1,
    distinct_members: 2,
    excluded_root_members: 1,
  });
  await assert.rejects(write(db, impossibleRoot));
  assert.deepEqual(await rowsOf(db), current);
  const scoped = packet([row("v2-after-root-exclusion")], {
    ...impossibleRoot.alpha_snapshot,
  });
  const excluded = await write(db, scoped);
  assert.equal(excluded.alpha_snapshot.current, true);
  assert.equal(excluded.alpha_snapshot.scanned_legacy, 1);
  assert.equal(excluded.alpha_snapshot.scanned_v2, 1);
  assert.equal(excluded.alpha_snapshot.distinct_members, 2);
  assert.equal(excluded.alpha_snapshot.excluded_root_members, 1);
});

test("a final lane mismatch preserves earlier staging until a complete replay succeeds", async () => {
  const db = await fixture();
  await write(db, packet());
  const priorRows = await rowsOf(db);
  const priorCapture = await alphaCaptureState(createD1Store(db));
  const first = packet([row("staged-v2")], {
    captured_at: baseAt + 1,
    block_number: frozen.alpha_snapshot.block_number + 1,
    scanned_legacy: 1,
    scanned_v2: 1,
    total_rows: 2,
    total_chunks: 2,
  });
  const staged = await write(db, first);
  const resume = await readAlphaSnapshotResumeD1(db);
  assert.equal(resume.alpha_snapshot_resume?.distinct_members, 2);
  assert.equal(resume.alpha_snapshot_resume?.excluded_root_members, 0);
  const wrong = packet([row("late-v2")], {
    ...first.alpha_snapshot,
    metadata_scale_hex: undefined,
    index: 1,
  });
  await assert.rejects(write(db, wrong));
  assert.deepEqual(await rowsOf(db), priorRows);
  const capture = await alphaCaptureState(createD1Store(db));
  assert.deepEqual(capture, priorCapture);
  assert.deepEqual(await readAlphaSnapshotResumeD1(db), resume);
  const stagedSql =
    "SELECT coldkey FROM alpha_snapshot_rows WHERE captured_at=?";
  const stagedStatement = db.prepare(stagedSql).bind(baseAt + 1);
  const stagedRows = await stagedStatement.all<Row>();
  assert.deepEqual(stagedRows.results, [{ coldkey: "staged-v2" }]);
  const replay = await write(db, first);
  assert.equal(replay.alpha_snapshot.sha256, staged.alpha_snapshot.sha256);
  assert.equal(replay.alpha_snapshot.received_rows, 1);
  assert.equal(replay.alpha_snapshot.received_chunks, 1);
  assert.equal(replay.alpha_snapshot.complete, false);
  const legacyOnly = row("late-legacy");
  legacyOnly.evidence.share = {
    legacy_bits: (1n << 64n).toString(),
    v2: null,
  };
  const last = { ...wrong, rows: [legacyOnly] };
  const accepted = await write(db, last);
  assert.equal(accepted.alpha_snapshot.complete, true);
  assert.equal(accepted.alpha_snapshot.selected, 1);
  assert.equal(accepted.alpha_snapshot.received_rows, 2);
  const current = await rowsOf(db);
  const owners = current.map((item) => item.coldkey);
  assert.deepEqual(owners, ["late-legacy", "staged-v2"]);
});

test("old completed replay acknowledges its receipt without claiming current selection", async () => {
  const db = await fixture();
  const old = packet();
  const first = await write(db, old);
  assert.equal(first.alpha_snapshot.selected, 1);
  const next = packet([row("new-canonical")], {
    captured_at: baseAt - 1,
    block_number: frozen.alpha_snapshot.block_number + 1,
  });
  const newerBlock = await write(db, next);
  assert.equal(newerBlock.alpha_snapshot.selected, 1);
  assert.equal(newerBlock.alpha_snapshot.current, true);
  const replay = await write(db, old);
  assert.equal(replay.alpha_snapshot.sha256, first.alpha_snapshot.sha256);
  assert.equal(replay.alpha_snapshot.complete, true);
  assert.equal(replay.alpha_snapshot.received_rows, 1);
  assert.equal(replay.alpha_snapshot.received_chunks, 1);
  assert.equal(replay.alpha_snapshot.selected, 1);
  assert.equal(replay.alpha_snapshot.current, false);
  const capture = await alphaCaptureState(createD1Store(db));
  assert.equal(capture.capture?.captured_at, baseAt - 1);
  assert.equal(capture.capture?.block_number, next.alpha_snapshot.block_number);
  const current = await rowsOf(db);
  assert.deepEqual(
    current.map((item) => item.coldkey),
    ["new-canonical"],
  );
  const selectedSql = "SELECT selected FROM alpha_snapshot_passes";
  const historical = await db.prepare(selectedSql).all<Row>();
  assert.deepEqual(
    historical.results.map((item) => item.selected),
    [1, 1],
  );
});

test("completed originals and receipts permit exact no-ops but reject mutation or deletion after promotion", async () => {
  const db = await fixture();
  await write(db, packet());
  for (const table of [
    "alpha_runtime_metadata",
    "alpha_snapshot_chunks",
    "alpha_snapshot_rows",
    "alpha_snapshot_pools",
  ]) {
    const column =
      table === "alpha_runtime_metadata"
        ? "code_hash"
        : table === "alpha_snapshot_chunks"
          ? "sha256"
          : table === "alpha_snapshot_rows"
            ? "alpha_evidence"
            : "evidence";
    await db.prepare(`UPDATE ${table} SET ${column}=${column}`).run();
    await assert.rejects(
      db.prepare(`UPDATE ${table} SET ${column}='changed'`).run(),
      /immutable/,
    );
    await assert.rejects(db.prepare(`DELETE FROM ${table}`).run(), /retained/);
  }
  await assert.rejects(
    db.prepare("UPDATE nominator_positions SET alpha_rao='1'").run(),
    /same capture/,
  );
  await assert.rejects(
    db.prepare("DELETE FROM nominator_positions").run(),
    /complete newer snapshot/,
  );
  assert.equal((await rowsOf(db))[0].alpha_rao, "1633251152");
});

test("synthetic supplementary and BMP owners use native UTF8 ranges and tuple hashing", async () => {
  const db = await fixture();
  const bmp = "\uE000",
    supplementary = "\u{10000}";
  const first = packet([row(supplementary), row(bmp)], {
    total_rows: 3,
    total_chunks: 2,
  });
  const accepted = await write(db, first);
  const replay = await write(db, {
    ...first,
    rows: [...first.rows].reverse(),
  });
  assert.equal(replay.alpha_snapshot.sha256, accepted.alpha_snapshot.sha256);
  assert.equal(replay.alpha_snapshot.received_rows, 2);
  const receipt = await db
    .prepare("SELECT first_owner,last_owner FROM alpha_snapshot_chunks")
    .first<Row>();
  assert.equal(receipt?.first_owner, bmp);
  assert.equal(receipt?.last_owner, supplementary);
  await assert.rejects(
    write(
      db,
      packet([row(bmp, "other")], {
        total_rows: 3,
        total_chunks: 2,
        index: 1,
      }),
    ),
  );
  const completed = await write(
    db,
    packet([row("\u{10001}")], {
      total_rows: 3,
      total_chunks: 2,
      index: 1,
    }),
  );
  assert.equal(completed.alpha_snapshot.selected, 1);
  assert.deepEqual(
    (await rowsOf(db)).map((r) => r.coldkey),
    [bmp, supplementary, "\u{10001}"],
  );
});

test("native receiver restore preserves serving and receipts", async () => {
  const source = await fixture();
  const restored = await fixture();
  const countModule = await import("../src/alpha-counts-d1.ts");
  const writeCounts = countModule.writeAlphaCountsD1;
  const readCounts = countModule.readAlphaCountStatusD1;
  const sourceStore = createD1Store(source);
  const anchorFor = (capture: Row) =>
    countModule.alphaCountAnchorSchema.parse({
      captured_at: capture.captured_at,
      block_number: capture.block_number,
      block_hash: capture.block_hash,
      genesis_hash: capture.genesis_hash,
      spec_version: capture.spec_version,
      code_hash: capture.code_hash,
      metadata_sha256: capture.metadata_sha256,
      scanned_legacy: capture.scanned_legacy,
      scanned_v2: capture.scanned_v2,
      distinct_members: capture.distinct_members,
      excluded_root_members: capture.excluded_root_members,
    });
  const legacy = JSON.parse(
    readFileSync(
      new URL("./fixtures/alpha-runtime/frozen-454.json", import.meta.url),
      "utf8",
    ),
  ) as Row;
  const maximumShares = ((1n << 128n) - 1n).toString();
  const legacyEvidence = structuredClone(legacy.members[0].evidence);
  legacyEvidence.share.legacy_bits = maximumShares;
  legacyEvidence.denominator.legacy_bits = maximumShares;
  legacyEvidence.total_alpha_rao = ((1n << 64n) - 1n).toString();
  const originalRows = [
    { ...row("legacy"), evidence: legacyEvidence },
    { ...row("legacy-stale", "old-only"), evidence: legacyEvidence },
  ];
  const original = packet(originalRows, {
    ...legacy.alpha_snapshot,
    captured_at: baseAt,
    scanned_legacy: 2,
    scanned_v2: 0,
  });
  await write(source, original);
  const oldAnchor = anchorFor(original.alpha_snapshot);
  const oldCounts = [
    { hotkey: "hot", nominator_count: 1, captured_at: baseAt },
    { hotkey: "old-only", nominator_count: 1, captured_at: baseAt },
  ];
  const oldCountReceipt = await writeCounts(
    sourceStore,
    oldCounts,
    oldAnchor,
    2,
    baseAt + 1,
  );
  assert.equal(oldCountReceipt.complete, true);

  const evidence = structuredClone(frozen.members[0].evidence);
  evidence.share.v2 = { mantissa: "300000000000000000000", exponent: "-21" };
  evidence.denominator.v2 = {
    mantissa: "1000000000000000000000",
    exponent: "-20",
  };
  evidence.total_alpha_rao = "101";
  evidence.pool_epoch = ((1n << 64n) - 1n).toString();
  evidence.member_epoch = evidence.pool_epoch;
  const metadataPath = "./fixtures/alpha-runtime/metadata-479.hex";
  const metadataUrl = new URL(metadataPath, import.meta.url);
  const metadata = readFileSync(metadataUrl, "utf8").trim();
  const currentAt = baseAt - 1;
  const currentRows = [
    { ...row("current"), evidence },
    { ...row("current-other", "other-hot"), evidence },
  ];
  const current = packet(currentRows, {
    captured_at: currentAt,
    block_number: frozen.alpha_snapshot.block_number + 1,
    spec_version: 479,
    code_hash: ALPHA_RUNTIMES[479].code,
    metadata_sha256: ALPHA_RUNTIMES[479].metadata,
    scanned_v2: 2,
    metadata_scale_hex: metadata,
  });
  const selected = await write(source, current);
  const countAnchor = anchorFor(current.alpha_snapshot);
  const firstCount = {
    hotkey: "hot",
    nominator_count: 1,
    captured_at: currentAt,
  };
  const firstCounts = [firstCount];
  const countReceipt = await writeCounts(
    sourceStore,
    firstCounts,
    countAnchor,
    2,
    baseAt + 2,
  );
  assert.equal(countReceipt.current, true);
  assert.equal(countReceipt.complete, false);
  assert.equal(countReceipt.applied_count, 1);
  assert.ok(currentAt < oldAnchor.captured_at);
  const pending = packet([{ ...row("pending-a"), evidence }], {
    ...current.alpha_snapshot,
    captured_at: baseAt + 2,
    block_number: frozen.alpha_snapshot.block_number + 2,
    metadata_scale_hex: undefined,
    scanned_v2: 2,
    distinct_members: 2,
    total_rows: 2,
    total_chunks: 2,
    index: 0,
  });
  const staged = await write(source, pending);
  const selfAt = baseAt + 3;
  const selfRows = [
    {
      coldkey: "current",
      hotkey: "hot",
      netuid: 23,
      share_fraction: 1 / 3,
      shares: null,
      captured_at: selfAt,
    },
    {
      coldkey: "self-only",
      hotkey: "self-hot",
      netuid: 24,
      share_fraction: 1e-7,
      shares: maximumShares,
      captured_at: selfAt,
    },
  ];
  const selfMeta = {
    captured_at: selfAt,
    scanned_pairs: 2,
    total_rows: 2,
    total_chunks: 1,
    index: 0,
    digest_version: 2 as const,
  };
  const selfReceipt = await writeSelfStakeSnapshotD1(
    createD1Store(source),
    selfRows,
    selfMeta,
    selfAt + 1,
  );

  // Fixed synthetic receiver tables only. This is an offline restore proof,
  // not a public exporter or an observation of production backup coverage.
  // Restore count rows before selection, then anchored receipts after their
  // immutable capture history; the single batch keeps the cut atomic.
  const tables = [
    "validator_nominator_counts",
    "alpha_runtime_metadata",
    "alpha_snapshot_passes",
    "alpha_snapshot_chunks",
    "alpha_snapshot_pools",
    "alpha_snapshot_rows",
    "self_stake_snapshot_passes",
    "self_stake_snapshot_chunks",
    "nominator_positions",
    "nominator_positions_passes",
    "nominator_scan_receipts",
    "validator_nominator_counts_passes",
    "archive_export_revisions",
  ] as const;
  type Column = { name: string; pk: number };
  type Cell = {
    storage: "integer" | "real" | "text" | "null";
    value: string | null;
  };
  const schemaStatements = tables.map((table) => {
    const sql = `PRAGMA table_info(${table})`;
    return source.prepare(sql);
  });
  const definitions = await source.batch<Column>(schemaStatements);
  const plans = definitions.map((definition, index) => {
    const columns = definition.results.map((column) => column.name);
    const keys = definition.results
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);
    assert.ok(columns.length > 0);
    assert.ok(keys.length > 0);
    return { table: tables[index]!, columns, keys };
  });
  const readCut = async (database: D1Database) => {
    const statements = plans.map((plan) => {
      const cells = plan.columns.map((column) => {
        const value =
          `CASE typeof(${column}) ` +
          `WHEN 'integer' THEN CAST(${column} AS TEXT) ` +
          `WHEN 'real' THEN printf('%!.26g',${column}) ` +
          `ELSE ${column} END`;
        const storage = `typeof(${column})`;
        return `json_object('storage',${storage},'value',${value})`;
      });
      const sql =
        `SELECT json_array(${cells.join(",")}) AS cells ` +
        `FROM ${plan.table} ORDER BY ${plan.keys.join(",")}`;
      return database.prepare(sql);
    });
    // One native batch pins all family reads to the same SQLite cut. Encode
    // integers and REALs before they cross JavaScript's numeric boundary.
    const results = await database.batch<{ cells: string }>(statements);
    return results.map((result) => {
      assert.ok(result.success);
      return result.results.map((entry) => JSON.parse(entry.cells) as Cell[]);
    });
  };
  const cut = await readCut(source);
  assert.ok(cut.every((rows) => rows.length > 0));
  const statements: D1PreparedStatement[] = [];
  for (const [index, plan] of plans.entries()) {
    for (const cells of cut[index]!) {
      const values = cells.map((cell) => {
        if (cell.storage === "integer") return "CAST(? AS INTEGER)";
        if (cell.storage === "real") return "CAST(? AS REAL)";
        return "?";
      });
      const sql =
        `INSERT INTO ${plan.table}(${plan.columns.join(",")}) ` +
        `VALUES(${values.join(",")})`;
      const statement = restored.prepare(sql);
      statements.push(statement.bind(...cells.map((cell) => cell.value)));
    }
  }
  await restored.batch(statements);
  assert.deepEqual(await readCut(restored), cut);

  const store = createD1Store(restored);
  const capture = (await alphaCaptureState(store)).capture;
  assert.equal(capture?.captured_at, currentAt);
  assert.equal(capture?.spec_version, 479);
  assert.equal(capture?.quantityQualified, true);
  const noLegacy = async (): Promise<Row[]> => {
    throw new Error("Restored canonical evidence must remain authoritative");
  };
  const { ownerCapturePositions } = ownerSplit;
  const positions = await ownerCapturePositions(store, 23, noLegacy);
  assert.equal(positions.length, 2);
  const owners = positions.map((position) => position.coldkey).sort();
  assert.deepEqual(owners, ["current", "current-other"]);
  const fraction = Number(positions[0]!.share_fraction);
  assert.ok(Math.abs(fraction - 0.03) < Number.EPSILON);
  assert.deepEqual(await ownerCapturePositions(store, 24, noLegacy), []);
  const resume = await readAlphaSnapshotResumeD1(source);
  assert.equal(resume.alpha_snapshot_resume?.captured_at, baseAt + 2);
  assert.deepEqual(await readAlphaSnapshotResumeD1(restored), resume);
  const restoredCounts = await readCounts(store, countAnchor, 2);
  assert.deepEqual(restoredCounts, countReceipt);
  const oldCountStatus = await readCounts(store, oldAnchor, 2);
  assert.equal(oldCountStatus.current, false);
  assert.equal(oldCountStatus.completed_at, oldCountReceipt.completed_at);
  const staleCountSql =
    "SELECT nominator_count,captured_at FROM validator_nominator_counts " +
    "WHERE hotkey='old-only'";
  const staleCount = await store.first(staleCountSql);
  assert.deepEqual(staleCount, { nominator_count: 1, captured_at: baseAt });

  const replay = await write(restored, current);
  assert.equal(replay.alpha_snapshot.sha256, selected.alpha_snapshot.sha256);
  assert.equal(replay.alpha_snapshot.received_rows, 2);
  const pendingReplay = await write(restored, pending);
  const pendingDigest = staged.alpha_snapshot.sha256;
  assert.equal(pendingReplay.alpha_snapshot.sha256, pendingDigest);
  assert.equal(pendingReplay.alpha_snapshot.received_rows, 1);
  assert.equal(pendingReplay.alpha_snapshot.received_chunks, 1);
  const selfReplay = await writeSelfStakeSnapshotD1(
    store,
    selfRows,
    selfMeta,
    selfAt + 2,
  );
  assert.equal(selfReplay.snapshot.sha256, selfReceipt.snapshot.sha256);
  assert.equal(selfReplay.snapshot.source_rows, 1);
  assert.equal(selfReplay.snapshot.shadowed_rows, 1);
  assert.equal(selfReplay.snapshot.received_rows, 2);
  assert.equal(selfReplay.snapshot.received_chunks, 1);
  const countReplay = await writeCounts(
    store,
    firstCounts,
    countAnchor,
    2,
    baseAt + 4,
  );
  assert.deepEqual(countReplay, countReceipt);
  const staleWrite = writeCounts(store, oldCounts, oldAnchor, 2, baseAt + 4);
  await assert.rejects(staleWrite);
  assert.deepEqual(await readCut(restored), cut);
  const lastCount = {
    hotkey: "other-hot",
    nominator_count: 1,
    captured_at: currentAt,
  };
  const lastCounts = [lastCount];
  const terminalCounts = await writeCounts(
    store,
    lastCounts,
    countAnchor,
    2,
    baseAt + 5,
  );
  assert.equal(terminalCounts.current, true);
  assert.equal(terminalCounts.complete, true);
  assert.equal(terminalCounts.applied_count, 2);
  const terminalCut = await readCut(restored);
  const terminalReplay = await writeCounts(
    store,
    lastCounts,
    countAnchor,
    2,
    baseAt + 6,
  );
  assert.deepEqual(terminalReplay, terminalCounts);
  assert.deepEqual(await readCut(restored), terminalCut);
  const last = {
    alpha_snapshot: { ...pending.alpha_snapshot, index: 1 },
    rows: [{ ...row("pending-b"), evidence }],
  };
  const completed = await write(restored, last);
  assert.equal(completed.alpha_snapshot.complete, true);
  assert.equal(completed.alpha_snapshot.selected, 1);
  assert.equal(completed.alpha_snapshot.received_rows, 2);
  assert.equal(completed.alpha_snapshot.received_chunks, 2);
  const latest = (await alphaCaptureState(store)).capture;
  assert.equal(latest?.captured_at, baseAt + 2);
  assert.equal(latest?.quantityQualified, true);
  assert.deepEqual(await readAlphaSnapshotResumeD1(restored), {
    ok: true,
    alpha_snapshot_resume: null,
  });
  const supersededCounts = await readCounts(store, countAnchor, 2);
  assert.equal(supersededCounts.current, false);
  assert.equal(supersededCounts.completed_at, terminalCounts.completed_at);
});
