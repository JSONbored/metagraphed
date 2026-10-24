import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { createD1Store } from "../src/d1-store.ts";
import {
  alphaCountAnchorSchema,
  writeAlphaCountsD1,
} from "../src/alpha-counts-d1.ts";
import { writeAlphaSnapshotD1 } from "../src/alpha-snapshot-d1.ts";
import {
  parseSelfStakeSnapshot,
  writeSelfStakeSnapshotD1,
  type SelfStakeSnapshot,
} from "../src/self-stake-snapshot-d1.ts";
import { writeNominatorPositionsD1 } from "../src/ledger-d1.ts";
import { mirrorNominatorPositionsToNeon } from "../src/nominator-positions-neon-write.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
import worker from "../workers/data-api.ts";
import * as captureFamily from "../src/capture-family-d1.ts";
import type { Row } from "./row-type.ts";

let runtime: Miniflare, db: D1Database;
const stamp = 1790090000000;
const row = (coldkey = "a", hotkey = "h", at = stamp, netuid = 1) => ({
  coldkey,
  hotkey,
  netuid,
  share_fraction: 0.5,
  captured_at: at,
});
const snapshot = (
  index = 0,
  total_rows = 1,
  total_chunks = 1,
  at = stamp,
): SelfStakeSnapshot => ({
  captured_at: at,
  scanned_pairs: 10,
  total_rows,
  total_chunks,
  index,
});
const write = (rows: Record<string, unknown>[], meta = snapshot()) =>
  writeSelfStakeSnapshotD1(createD1Store(db), rows, meta, stamp + 20);
const rowsOf = async () =>
  (
    await db
      .prepare(
        "SELECT coldkey,hotkey,netuid,source,captured_at FROM nominator_positions ORDER BY coldkey,hotkey,netuid",
      )
      .all()
  ).results;
const pass = async (at = stamp) =>
  db
    .prepare("SELECT * FROM self_stake_snapshot_passes WHERE captured_at=?")
    .bind(at)
    .first<Record<string, number | null>>();
const seed = async (coldkey: string, source = "self-stake", at = stamp - 1) =>
  db
    .prepare(
      "INSERT INTO nominator_positions(coldkey,hotkey,netuid,share_fraction,captured_at,source) VALUES(?,?,1,0.5,?,?)",
    )
    .bind(coldkey, "old", at, source)
    .run();
const sendSelfStake = (body: unknown, database = db) =>
  worker.fetch(
    new Request("https://d/api/v1/internal/self-stake-sync", {
      method: "POST",
      headers: { "x-self-stake-sync-token": "test" },
      body: JSON.stringify(body),
    }),
    dataApiEnv({
      D1_STATE: database,
      D1_STATE_TABLES:
        "nominator_positions,nominator_positions_passes,nominator_scan_receipts",
      SELF_STAKE_SYNC_SECRET: "test",
    }),
    { waitUntil: () => {} } as unknown as ExecutionContext,
  );
beforeAll(async () => {
  vi.useRealTimers();
  runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('test')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
  });
  db = await runtime.getD1Database("DB");
  for (const file of [
    "0010_ledger_state.sql",
    "0039_alpha_runtime_receiver.sql",
  ])
    for (const sql of readFileSync(
      new URL("../migrations/d1/" + file, import.meta.url),
      "utf8",
    ).split("-- statement-breakpoint"))
      if (sql.trim()) await db.prepare(sql).run();
});
afterAll(() => runtime.dispose());
beforeEach(async () => {
  vi.useRealTimers();
  for (const name of ["reject_retirement", "reject_receipt"])
    await db.prepare("DROP TRIGGER IF EXISTS " + name).run();
  for (const name of [
    "self_stake_snapshot_chunks",
    "self_stake_snapshot_passes",
    "nominator_positions",
  ])
    await db.prepare("DELETE FROM " + name).run();
});

test("receipts without an ownership census survive exact replay without inventing counts", async () => {
  for (const complete of [false, true]) {
    const native = createD1Store(db);
    // Simulate an exact legacy receipt retained during recovery. Its writer
    // predates the ownership census, so defaults are not observations.
    const original = await writeSelfStakeSnapshotD1(
      {
        ...native,
        first: async <Result>(text: string, values: unknown[] = []) =>
          text.includes("sqlite_master")
            ? null
            : native.first<Result>(text, values),
      },
      [row()],
      snapshot(0, complete ? 1 : 2, complete ? 1 : 2),
      stamp + 20,
    );
    assert.equal(original.snapshot.complete, complete);
    const before = await db
      .prepare("SELECT * FROM self_stake_snapshot_chunks")
      .first();
    const replay = await writeSelfStakeSnapshotD1(
      native,
      [row()],
      snapshot(0, complete ? 1 : 2, complete ? 1 : 2),
      stamp + 21,
    );
    assert.equal(replay.snapshot.sha256, original.snapshot.sha256);
    assert.equal(replay.snapshot.complete, complete);
    assert.equal(replay.snapshot.received_rows, 1);
    assert.equal(replay.snapshot.received_chunks, 1);
    assert.equal(Object.hasOwn(replay.snapshot, "source_rows"), false);
    assert.equal(Object.hasOwn(replay.snapshot, "shadowed_rows"), false);
    assert.equal(Object.hasOwn(replay.snapshot, "alpha_captured_at"), false);
    assert.deepEqual(
      await db.prepare("SELECT * FROM self_stake_snapshot_chunks").first(),
      before,
    );
    if (!complete) {
      const next = await writeSelfStakeSnapshotD1(
        native,
        [row("b")],
        snapshot(1, 2, 2),
        stamp + 22,
      );
      assert.equal(next.snapshot.complete, true);
      assert.equal(next.snapshot.received_rows, 2);
      assert.equal(next.snapshot.source_rows, 1);
      assert.equal(next.snapshot.shadowed_rows, 0);
    }
    for (const table of [
      "self_stake_snapshot_chunks",
      "self_stake_snapshot_passes",
      "nominator_positions",
    ])
      await db.prepare("DELETE FROM " + table).run();
  }
});

test("only a completely delivered snapshot retires absent and zero-stake owners; Alpha and newer positions survive", async () => {
  await seed("departed");
  await seed("a");
  await seed("alpha", "alpha");
  await seed("newer", "self-stake", stamp + 1);
  const first = await write([row("a")], snapshot(0, 2, 2));
  assert.equal(first.snapshot.complete, false);
  assert((await rowsOf()).some((r) => r.coldkey === "departed"));
  assert(
    !(await rowsOf()).some((r) => r.coldkey === "a" && r.hotkey === "old"),
  );
  const last = await write([row("b")], snapshot(1, 2, 2));
  assert.equal(last.snapshot.complete, true);
  assert.equal(last.snapshot.positions_retired, 1);
  assert.deepEqual(
    (await rowsOf()).map((r) => r.coldkey),
    ["a", "alpha", "b", "newer"],
  );
  assert.equal((await pass())!.received_rows, 2);
  assert.equal((await pass())!.received_chunks, 2);
});

test("a lost committed reply can be replayed exactly without recounting rows or chunks", async () => {
  const native = createD1Store(db);
  let lost = true;
  const intercepted = {
    ...native,
    async transaction(statements: Parameters<typeof native.transaction>[0]) {
      const result = await native.transaction(statements);
      if (lost) {
        lost = false;
        throw new Error("D1_ERROR: Network connection lost.");
      }
      return result;
    },
  };
  await assert.rejects(
    writeSelfStakeSnapshotD1(intercepted, [row()], snapshot(), stamp + 20),
    /Network connection lost/,
  );
  const before = await pass();
  const retry = await write([row()]);
  assert.equal(retry.snapshot.complete, true);
  assert.deepEqual(await pass(), before);
  assert.equal((await rowsOf()).length, 1);
});

test("a late completed replay cannot resurrect a position deleted by a newer complete empty snapshot", async () => {
  const original = await write([row()]);
  await write([], snapshot(0, 0, 1, stamp + 1));
  assert.equal((await rowsOf()).length, 0);
  const retry = await write([row()]);
  assert.equal(retry.snapshot.sha256, original.snapshot.sha256);
  assert.equal((await rowsOf()).length, 0);
});

test("an older unfinished pass arriving after a newer full snapshot cannot recreate obsolete positions", async () => {
  await write([row("a")], snapshot(0, 2, 2));
  await write([], snapshot(0, 0, 1, stamp + 1));
  const late = await write([row("b")], snapshot(1, 2, 2));
  assert.equal(late.snapshot.complete, true);
  assert.equal((await rowsOf()).length, 0);
});

test("out-of-order disjoint owner chunks complete the same exact full snapshot", async () => {
  await seed("departed");
  await write([row("z")], snapshot(1, 2, 2));
  assert((await rowsOf()).some((r) => r.coldkey === "departed"));
  const result = await write([row("a")], snapshot(0, 2, 2));
  assert.equal(result.snapshot.complete, true);
  assert.deepEqual(
    (await rowsOf()).map((r) => r.coldkey),
    ["a", "z"],
  );
});

test("a real full scan with no self-stake positions retires only older rows in its own source domain", async () => {
  await seed("zero");
  await seed("alpha", "alpha");
  await seed("newer", "self-stake", stamp + 1);
  const result = await write([], snapshot(0, 0, 1));
  assert.equal(result.snapshot.complete, true);
  assert.equal(result.snapshot.positions_retired, 1);
  assert.deepEqual(
    (await rowsOf()).map((r) => r.coldkey),
    ["alpha", "newer"],
  );
});

test("an incomplete owner chunk retains every absent owner until the remaining chunk arrives", async () => {
  await seed("missing");
  await write([row("a")], snapshot(0, 2, 2));
  assert((await rowsOf()).some((r) => r.coldkey === "missing"));
  assert.equal((await pass())!.completed_at, null);
});

test("changed chunk content or pass census is a conflict, preserving the original committed snapshot", async () => {
  await write([row()]);
  const before = await rowsOf();
  const prior = await pass();
  await assert.rejects(write([{ ...row(), share_fraction: 0.7 }]), /NOT NULL/);
  await assert.rejects(
    write([row()], { ...snapshot(), scanned_pairs: 11 }),
    /NOT NULL/,
  );
  await assert.rejects(write([row()], snapshot(0, 2, 2)), /NOT NULL/);
  assert.deepEqual(await rowsOf(), before);
  assert.deepEqual(await pass(), prior);
});

test("owners cannot overlap across chunks or count the same position twice", async () => {
  await write([row("same", "h1")], snapshot(0, 2, 2));
  const before = await rowsOf();
  await assert.rejects(
    write([row("same", "h2")], snapshot(1, 2, 2)),
    /NOT NULL/,
  );
  assert.deepEqual(await rowsOf(), before);
  assert.equal((await pass())!.received_chunks, 1);
  assert.throws(
    () => parseSelfStakeSnapshot(snapshot(0, 2), [row(), row()]),
    /repeats a position/,
  );
});

test("overshooting a declared census rolls back the last chunk and its pruning", async () => {
  await seed("departed");
  await write([row("a", "h1"), row("a", "h2")], snapshot(0, 3, 2));
  const before = await rowsOf();
  await assert.rejects(
    write([row("b", "h1"), row("b", "h2")], snapshot(1, 3, 2)),
    /CHECK constraint/,
  );
  assert.deepEqual(await rowsOf(), before);
  assert.equal((await pass())!.received_rows, 2);
});

test("a failed final retirement rolls back data, receipt, counters and completion together", async () => {
  await seed("departed");
  await write([row("a")], snapshot(0, 2, 2));
  const before = await rowsOf();
  await db
    .prepare(
      "CREATE TRIGGER reject_retirement BEFORE DELETE ON nominator_positions WHEN OLD.coldkey='departed' BEGIN SELECT RAISE(ABORT,'retirement failed'); END",
    )
    .run();
  await assert.rejects(
    write([row("b")], snapshot(1, 2, 2)),
    /retirement failed/,
  );
  assert.deepEqual(await rowsOf(), before);
  assert.equal((await pass())!.received_chunks, 1);
  assert.equal((await pass())!.completed_at, null);
  await db.prepare("DROP TRIGGER reject_retirement").run();
  assert.equal(
    (await write([row("b")], snapshot(1, 2, 2))).snapshot.complete,
    true,
  );
});

test("receipt failure cannot commit any data or pass metadata", async () => {
  await seed("existing");
  await db
    .prepare(
      "CREATE TRIGGER reject_receipt BEFORE INSERT ON self_stake_snapshot_chunks BEGIN SELECT RAISE(ABORT,'receipt failed'); END",
    )
    .run();
  await assert.rejects(write([row()]), /receipt failed/);
  assert.equal(await pass(), null);
  assert.deepEqual(
    (await rowsOf()).map((r) => r.coldkey),
    ["existing"],
  );
});

test("receipt acknowledgement fails closed on a missing, changed or unapplied receipt", async () => {
  const native = createD1Store(db);
  const original = await write([row()]);
  for (const receipt of [
    null,
    { sha256: "wrong", applied: 1 },
    { sha256: original.snapshot.sha256, applied: 0 },
  ])
    await assert.rejects(
      writeSelfStakeSnapshotD1(
        {
          ...native,
          first: async <Result>(text: string, values: unknown[] = []) =>
            text.includes("sqlite_master")
              ? native.first<Result>(text, values)
              : (receipt as Result | null),
        },
        [row()],
        snapshot(),
        stamp + 20,
      ),
      /durably acknowledged/,
    );
});

test("a delayed legacy partial-owner update cannot recreate positions retired by a newer complete snapshot", async () => {
  await write([row()]);
  await write([], snapshot(0, 0, 1, stamp + 1));
  const result = await writeNominatorPositionsD1(createD1Store(db), {
    rows: [row("old-owner"), row("new-owner", "h", stamp + 2)],
    coldkeyMaxCapturedAt: new Map([
      ["old-owner", stamp],
      ["new-owner", stamp + 2],
    ]),
    source: "self-stake",
  });
  assert.equal(result.write!.ok, true);
  assert.deepEqual(
    (await rowsOf()).map((r) => r.coldkey),
    ["new-owner"],
  );
});

test("future capture stamps cannot retire older data before the capture has occurred", async () => {
  await seed("existing");
  await assert.rejects(
    writeSelfStakeSnapshotD1(createD1Store(db), [], snapshot(0, 0), stamp - 1),
    /completion precedes/,
  );
  assert.equal(await pass(), null);
  assert.equal((await rowsOf()).length, 1);
  await assert.rejects(
    writeSelfStakeSnapshotD1(createD1Store(db), [], snapshot(0, 0), NaN),
    /completion precedes/,
  );
});

test("an oversized atomic capture is rejected before the native store receives a transaction", async () => {
  const native = createD1Store(db);
  const transaction = vi.fn(native.transaction);
  const builder = vi
    .spyOn(captureFamily, "captureUpsertStatements")
    .mockReturnValue(
      Array.from({ length: 901 }, () => ({
        text: "SELECT 1",
        values: ["[]"] as [string],
      })),
    );
  try {
    await assert.rejects(
      writeSelfStakeSnapshotD1(
        { ...native, transaction },
        [row()],
        snapshot(),
        stamp + 1,
      ),
      /atomic statement budget/,
    );
    assert.equal(transaction.mock.calls.length, 0);
    assert.equal(await pass(), null);
  } finally {
    builder.mockRestore();
  }
});

test("snapshot hashing preserves optional raw shares and handles every deterministic row ordering", async () => {
  const rows = [
    row("b"),
    { ...row("a"), shares: "340282366920938463463374607431768211455" },
    row("c"),
  ];
  const result = await write(rows, snapshot(0, 3));
  assert.equal(result.snapshot.complete, true);
  assert.equal(
    await db
      .prepare("SELECT shares FROM nominator_positions WHERE coldkey='a'")
      .first("shares"),
    "340282366920938463463374607431768211455",
  );
});

test("metadata and row ordering do not change an exact replay's digest", async () => {
  const rows = [row("a", "z"), row("a", "A")];
  const original = await write(rows, snapshot(0, 2));
  const reverse = {
    index: 0,
    total_chunks: 1,
    total_rows: 2,
    scanned_pairs: 10,
    captured_at: stamp,
  };
  const retry = await write([...rows].reverse(), reverse);
  assert.equal(retry.snapshot.sha256, original.snapshot.sha256);
  assert.equal((await pass())!.received_rows, 2);
});

test("Unicode owner ranges and receipt hashes use the same UTF-8 byte order as SQLite", async () => {
  const firstOwner = "\ue000",
    lastOwner = "\u{10000}",
    nextOwner = "\u{10001}";
  const rows = [row(lastOwner), row(firstOwner)];
  const meta = { ...snapshot(0, 3, 2), digest_version: 2 as const };
  const original = await write(rows, meta);
  const expected = createHash("sha256")
    .update(
      JSON.stringify([
        [stamp, 10, 3, 2, 0],
        [firstOwner, lastOwner].map((coldkey) => [
          coldkey,
          "h",
          1,
          "f64:3fe0000000000000",
          null,
          stamp,
          "self-stake",
        ]),
      ]),
    )
    .digest("hex");
  assert.equal(original.snapshot.sha256, expected);
  assert.deepEqual(
    await db
      .prepare(
        "SELECT first_owner,last_owner FROM self_stake_snapshot_chunks WHERE batch_index=0",
      )
      .first(),
    { first_owner: firstOwner, last_owner: lastOwner },
  );
  assert.equal(
    (await write([...rows].reverse(), meta)).snapshot.sha256,
    expected,
  );
  await assert.rejects(
    write([row(lastOwner, "overlap")], { ...meta, index: 1 }),
    /NOT NULL/,
  );
  assert.equal((await pass())!.received_chunks, 1);
  const last = await write([row(nextOwner)], { ...meta, index: 1 });
  assert.equal(last.snapshot.complete, true);
  assert.deepEqual(
    (await rowsOf()).map((position) => position.coldkey),
    [firstOwner, lastOwner, nextOwner],
  );
});

const invalid = [
  null,
  [],
  0,
  {},
  { ...snapshot(), extra: true },
  { ...snapshot(), digest_version: 1 },
  { ...snapshot(), digest_version: "2" },
  { ...snapshot(), captured_at: 0 },
  { ...snapshot(), scanned_pairs: 0 },
  { ...snapshot(), scanned_pairs: 10_000_001 },
  { ...snapshot(), scanned_pairs: 0.5 },
  { ...snapshot(), total_rows: -1 },
  { ...snapshot(), total_rows: 11 },
  { ...snapshot(), total_chunks: 0 },
  { ...snapshot(), total_chunks: 1001 },
  { ...snapshot(), index: -1 },
  { ...snapshot(), index: 1 },
  { ...snapshot(), captured_at: Number.MAX_SAFE_INTEGER + 1 },
  { ...snapshot(), total_rows: 1, total_chunks: 2 },
  {
    ...snapshot(),
    total_rows: 50_001,
    total_chunks: 2,
    scanned_pairs: 100_000,
  },
];
test.each(invalid)(
  "invalid full-snapshot declarations are rejected before a write: %j",
  (value) => {
    assert.throws(() => parseSelfStakeSnapshot(value, [row()]));
  },
);
test("a missing or mixed timestamp, empty partial declaration, impossible zero pass and oversized chunk fail closed", () => {
  assert.throws(
    () => parseSelfStakeSnapshot(snapshot(), [row("a", "h", stamp + 1)]),
    /timestamps/,
  );
  assert.throws(() => parseSelfStakeSnapshot(snapshot(), []), /impossible/);
  assert.throws(
    () => parseSelfStakeSnapshot(snapshot(0, 0, 2), []),
    /impossible/,
  );
  assert.throws(
    () => parseSelfStakeSnapshot(snapshot(0, 2), [row()]),
    /row census/,
  );
  assert.throws(
    () =>
      parseSelfStakeSnapshot(
        { ...snapshot(), total_rows: 25_001, scanned_pairs: 30_000 },
        Array(25_001).fill(row()),
      ),
    /bounds/,
  );
});

test("snapshot metadata cannot borrow Alpha's prune domain or fall back to legacy Neon", async () => {
  const input = {
    rows: [row()],
    coldkeyMaxCapturedAt: new Map([["a", stamp]]),
    selfStakeSnapshot: snapshot(),
    source: "alpha",
  };
  const direct = await writeNominatorPositionsD1(createD1Store(db), input);
  assert.equal(direct.write!.ok, false);
  const mixed = await mirrorNominatorPositionsToNeon(
    dataApiEnv({
      D1_STATE: db,
      D1_STATE_TABLES:
        "nominator_positions,nominator_positions_passes,nominator_scan_receipts",
    }),
    null,
    input,
  );
  assert.equal(mixed.write!.ok, false);
  const legacy = await mirrorNominatorPositionsToNeon(dataApiEnv(), null, {
    ...input,
    source: "self-stake",
  });
  assert.equal(legacy.write!.ok, false);
  assert.equal((await rowsOf()).length, 0);
});

test("legacy partial self-stake remains writable before the additive receiver migration", async () => {
  const isolated = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('test')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
  });
  try {
    const previous = await isolated.getD1Database("DB");
    for (const sql of readFileSync(
      new URL("../migrations/d1/0010_ledger_state.sql", import.meta.url),
      "utf8",
    ).split("-- statement-breakpoint"))
      if (sql.trim()) await previous.prepare(sql).run();
    const native = createD1Store(previous);
    const result = await writeNominatorPositionsD1(native, {
      rows: [row()],
      coldkeyMaxCapturedAt: new Map([["a", stamp]]),
      source: "self-stake",
    });
    assert.equal(result.write?.ok, true);
    assert.equal(
      await previous
        .prepare("SELECT COUNT(*) n FROM nominator_positions")
        .first("n"),
      1,
    );
    const full = await writeNominatorPositionsD1(native, {
      rows: [],
      coldkeyMaxCapturedAt: new Map(),
      source: "self-stake",
      selfStakeSnapshot: snapshot(0, 0),
    });
    assert.equal(full.write?.ok, false);
    assert.equal(
      await previous
        .prepare("SELECT COUNT(*) n FROM nominator_positions")
        .first("n"),
      1,
    );
  } finally {
    await isolated.dispose();
  }
});

test("ownership capability lookup failures cannot downgrade either self-stake writer", async () => {
  const native = createD1Store(db);
  const transaction = vi.fn(native.transaction);
  const broken = {
    ...native,
    first: async <Result>(): Promise<Result | null> => {
      throw new Error("ownership lookup failed");
    },
    transaction,
  };
  await assert.rejects(
    writeSelfStakeSnapshotD1(broken, [row()], snapshot(), stamp + 1),
    /ownership lookup failed/,
  );
  const partial = await writeNominatorPositionsD1(broken, {
    rows: [row()],
    coldkeyMaxCapturedAt: new Map([["a", stamp]]),
    source: "self-stake",
  });
  assert.equal(partial.write?.ok, false);
  assert.match(partial.write!.reason!, /ownership lookup failed/);
  assert.equal(transaction.mock.calls.length, 0);
  assert.equal((await rowsOf()).length, 0);
});

test("full-snapshot receipts use the existing write/prune health lanes without creating a fictitious producer", async () => {
  const verdicts: unknown[][] = [];
  const result = await mirrorNominatorPositionsToNeon(
    dataApiEnv({
      D1_STATE: db,
      D1_STATE_TABLES:
        "nominator_positions,nominator_positions_passes,nominator_scan_receipts",
    }),
    null,
    {
      rows: [row()],
      coldkeyMaxCapturedAt: new Map([["a", stamp]]),
      selfStakeSnapshot: snapshot(),
      source: "self-stake",
      lane: "self-stake",
    },
    {
      now: () => Date.now(),
      laneHealthDb: {
        async query() {
          return [];
        },
        async run(text, values) {
          if (text.startsWith("INSERT INTO lane_health "))
            verdicts.push(values ?? []);
          return { changes: 1 };
        },
      },
    },
  );
  assert.equal(result.snapshot!.complete, true);
  assert.equal(verdicts.length, 2);
  assert.deepEqual(verdicts.map((values) => values[0]).sort(), [
    "neon:self-stake",
    "neon:self-stake-prune",
  ]);
});

test("the real sync handler validates metadata and returns the exact durable snapshot acknowledgement", async () => {
  const coldkey = "5DvTpiniW9s3APmHRYn8FroUWyfnLtrsid5Mtn5EwMXHN2ed",
    hotkey = "5FTsvUZk3aoFdaAKAvWr1XVLmnEnEs5MoTM4nXtCUCu7yPQ7";
  const nullMetadata = await sendSelfStake({
    rows: [row(coldkey, hotkey)],
    snapshot: null,
  });
  assert.equal(nullMetadata.status, 400);
  const missingMetadata = await sendSelfStake({
    rows: [row(coldkey, hotkey)],
    snapshot: {},
  });
  assert.equal(missingMetadata.status, 400);
  const response = await sendSelfStake({
    rows: [row(coldkey, hotkey)],
    snapshot: snapshot(),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(body.self_stake_snapshot!.complete, true);
  assert.equal(body.self_stake_snapshot!.received_rows, 1);
  assert.equal(body.self_stake_snapshot!.positions_retired, 0);
  assert.equal((await rowsOf()).length, 1);
});

test("empty HTTP snapshot receipts retire only older self-stake and replay without changing Alpha evidence or anchors", async () => {
  const isolated = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('test')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
  });
  try {
    const database = await isolated.getD1Database("DB");
    for (const file of [
      "0010_ledger_state.sql",
      "0016_archive_export_revisions.sql",
      "0039_alpha_runtime_receiver.sql",
    ]) {
      const source = readFileSync(
        new URL(`../migrations/d1/${file}`, import.meta.url),
        "utf8",
      );
      for (const sql of source.split("-- statement-breakpoint")) {
        if (sql.trim()) await database.prepare(sql).run();
      }
    }
    // Synthetic ownership and census retain unchanged historical originals.
    const frozen = JSON.parse(
      readFileSync(
        new URL("./fixtures/alpha-runtime/frozen-478.json", import.meta.url),
        "utf8",
      ),
    ) as Row;
    const { metadata_scale_hex, ...identity } = frozen.alpha_snapshot;
    const anchor = alphaCountAnchorSchema.parse({
      ...identity,
      captured_at: stamp - 2,
      scanned_legacy: 0,
      scanned_v2: 1,
      distinct_members: 1,
      excluded_root_members: 0,
    });
    const captured = await writeAlphaSnapshotD1(
      database,
      {
        alpha_snapshot: {
          ...anchor,
          metadata_scale_hex,
          total_rows: 1,
          total_chunks: 1,
          index: 0,
        },
        rows: [
          {
            coldkey: "alpha",
            hotkey: "alpha-hotkey",
            netuid: 23,
            evidence: frozen.members[0].evidence,
          },
        ],
      },
      stamp,
    );
    assert.equal(captured.alpha_snapshot.current, true);
    const native = createD1Store(database);
    await writeAlphaCountsD1(
      native,
      [
        {
          hotkey: "alpha-hotkey",
          nominator_count: 1,
          captured_at: anchor.captured_at,
        },
      ],
      anchor,
      1,
      stamp,
    );
    for (const [coldkey, at] of [
      ["departed", stamp - 1],
      ["newer", stamp + 1],
    ] as const) {
      await database
        .prepare(
          "INSERT INTO nominator_positions(coldkey,hotkey,netuid,share_fraction,captured_at,source) VALUES(?,'self',1,0.5,?,'self-stake')",
        )
        .bind(coldkey, at)
        .run();
    }
    const protectedState = async () => {
      const state: Record<string, unknown> = {};
      for (const table of [
        "alpha_runtime_metadata",
        "alpha_snapshot_passes",
        "alpha_snapshot_chunks",
        "alpha_snapshot_rows",
        "alpha_snapshot_pools",
        "nominator_positions_passes",
        "nominator_scan_receipts",
        "validator_nominator_counts",
        "validator_nominator_counts_passes",
      ]) {
        state[table] = (
          await database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()
        ).results;
      }
      state.positions = (
        await database
          .prepare("SELECT * FROM nominator_positions WHERE source='alpha'")
          .all()
      ).results;
      return state;
    };
    const before = await protectedState();
    const request = {
      rows: [],
      snapshot: { ...snapshot(0, 0), digest_version: 2 },
    };
    const response = await sendSelfStake(request, database);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Row;
    const receipt = body.self_stake_snapshot;
    assert.equal(receipt.complete, true);
    assert.equal(receipt.received_rows, 0);
    assert.equal(receipt.received_chunks, 1);
    assert.equal(receipt.positions_retired, 1);
    assert.equal(receipt.digest_version, 2);
    const remaining = (
      await database
        .prepare("SELECT coldkey FROM nominator_positions ORDER BY coldkey")
        .all()
    ).results;
    assert.deepEqual(remaining, [{ coldkey: "alpha" }, { coldkey: "newer" }]);
    assert.deepEqual(await protectedState(), before);
    const repeated = await sendSelfStake(request, database);
    assert.equal(repeated.status, 200);
    const replay = ((await repeated.json()) as Row).self_stake_snapshot;
    assert.deepEqual(replay, { ...receipt, positions_retired: 0 });
    assert.deepEqual(await protectedState(), before);
    const afterReplay = (
      await database
        .prepare("SELECT coldkey FROM nominator_positions ORDER BY coldkey")
        .all()
    ).results;
    assert.deepEqual(afterReplay, remaining);
  } finally {
    await isolated.dispose();
  }
});

test("bare empty HTTP batches and malformed empty receipts cannot write or retire positions", async () => {
  await seed("departed");
  await seed("alpha", "alpha");
  await write([row()], snapshot(0, 2, 2));
  const positions = await rowsOf();
  const receipt = await pass();
  const chunks = (
    await db.prepare("SELECT * FROM self_stake_snapshot_chunks").all()
  ).results;
  const empty = { ...snapshot(0, 0), digest_version: 2 };
  const invalidBodies = [
    [],
    { rows: [] },
    { rows: [], snapshot: null },
    { rows: [], snapshot: {} },
    { rows: [], snapshot: { captured_at: stamp } },
    { rows: [], snapshot: { ...empty, total_rows: 1 } },
    { rows: [], snapshot: { ...empty, total_chunks: 2 } },
    { rows: [], snapshot: { ...empty, scanned_pairs: 0 } },
    { rows: [], snapshot: { ...empty, total_rows: -1 } },
    { rows: [], snapshot: { ...empty, index: 1 } },
    { rows: [], snapshot: { ...empty, digest_version: 1 } },
    { rows: [], snapshot: { ...empty, digest_version: "2" } },
    { rows: [], snapshot: { ...empty, extra: true } },
  ];
  for (const body of invalidBodies) {
    assert.equal((await sendSelfStake(body)).status, 400);
    assert.deepEqual(await rowsOf(), positions);
    assert.deepEqual(await pass(), receipt);
    const afterChunks = (
      await db.prepare("SELECT * FROM self_stake_snapshot_chunks").all()
    ).results;
    assert.deepEqual(afterChunks, chunks);
  }
});
