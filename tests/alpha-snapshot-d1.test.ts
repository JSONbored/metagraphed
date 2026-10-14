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
    "0039_self_stake_snapshot_receipts.sql",
    ...(includeAlpha ? ["0042_alpha_runtime_snapshots.sql"] : []),
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
const packet = (rows = [row()], overrides: Row = {}) => ({
  alpha_snapshot: {
    ...frozen.alpha_snapshot,
    scanned_legacy: 0,
    scanned_v2: 10,
    total_rows: rows.length,
    total_chunks: 1,
    index: 0,
    ...overrides,
  },
  rows,
});
const rowsOf = async (db: D1Database) =>
  (
    await db
      .prepare("SELECT * FROM nominator_positions ORDER BY coldkey")
      .all<Row>()
  ).results;
const write = (db: D1StoreBinding, p: Row) =>
  writeAlphaSnapshotD1(db, p, baseAt + 100000);

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
    0,
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
    D1_STATE_TABLES: "nominator_positions",
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
  await write(bounded as D1StoreBinding, packet(rows, { scanned_v2: 2500 }));
  assert.ok(Math.max(...lengths) < 2_000_000);
  assert.equal(
    (await db.prepare("SELECT COUNT(*) AS n FROM alpha_snapshot_pools").first())
      ?.n,
    0,
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
    D1_STATE_TABLES: "nominator_positions",
    D1_EXPORT_REVISIONS: "enabled",
    STATE_EXPORT_SECRET: "secret",
  };
  assert.equal((await handleD1StateExport(request(), env)).status, 200);
  for (const sql of readFileSync(
    new URL(
      "../migrations/d1/0042_alpha_runtime_snapshots.sql",
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
    D1_STATE_TABLES: "nominator_positions",
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
