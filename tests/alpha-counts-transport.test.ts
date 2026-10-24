import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, test, vi } from "vitest";
import worker from "../workers/data-api.ts";
import { ALPHA_RUNTIMES } from "../src/alpha-runtime-identity.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
import type { Row } from "./row-type.ts";

const frozen = JSON.parse(
  readFileSync(
    new URL("./fixtures/alpha-runtime/frozen-478.json", import.meta.url),
    "utf8",
  ),
) as Row;
const COUNT_PATH = "/api/v1/internal/validator-nominator-counts-sync";
const POSITION_PATH = "/api/v1/internal/nominator-positions-sync";
const SECRET = "synthetic-count-transport-token";
const STAMP = frozen.alpha_snapshot.captured_at as number;
const OWNER_TABLES = [
  "nominator_positions",
  "nominator_positions_passes",
  "nominator_scan_receipts",
  "validator_nominator_counts",
  "validator_nominator_counts_passes",
].join(",");
const ANCHOR_FIELDS = [
  "captured_at",
  "block_number",
  "block_hash",
  "genesis_hash",
  "spec_version",
  "code_hash",
  "metadata_sha256",
  "scanned_legacy",
  "scanned_v2",
  "distinct_members",
  "excluded_root_members",
] as const;
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
  for (const name of [
    "0010_ledger_state.sql",
    "0016_archive_export_revisions.sql",
    "0039_alpha_runtime_receiver.sql",
  ]) {
    const url = new URL(`../migrations/d1/${name}`, import.meta.url);
    const source = readFileSync(url, "utf8");
    for (const sql of source.split("-- statement-breakpoint")) {
      if (sql.trim()) await db.prepare(sql).run();
    }
  }
  const sent: Row[] = [];
  const background: Promise<unknown>[] = [];
  const context = {
    waitUntil(promise: Promise<unknown>) {
      background.push(promise);
    },
  } as unknown as ExecutionContext;
  const env = dataApiEnv({
    D1_STATE: db,
    D1_STATE_TABLES: OWNER_TABLES,
    NOMINATOR_POSITIONS_SYNC_SECRET: SECRET,
    VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET: SECRET,
    SYNC_QUEUE_LANES: "validator-nominator-counts",
    SYNC_BATCHES: {
      async send(body: Row) {
        sent.push(structuredClone(body));
      },
    },
  });
  const post = (
    body: unknown,
    environment = env,
    token: string | null = SECRET,
    path = COUNT_PATH,
  ) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (token !== null) {
      const header =
        path === COUNT_PATH
          ? "x-validator-nominator-counts-sync-token"
          : "x-nominator-positions-sync-token";
      headers[header] = token;
    }
    return worker.fetch(
      new Request(`https://api.metagraph.sh${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      environment,
      context,
    );
  };
  const capture = async (
    hotkeys = ["hot-a", "hot-b"],
    capturedAt = STAMP,
    block = 100,
  ) => {
    const snapshot = {
      ...frozen.alpha_snapshot,
      captured_at: capturedAt,
      block_number: block,
      block_hash: `0x${block.toString(16).padStart(64, "0")}`,
      scanned_legacy: 0,
      scanned_v2: hotkeys.length,
      distinct_members: hotkeys.length,
      excluded_root_members: 0,
      total_rows: hotkeys.length,
      total_chunks: 1,
      index: 0,
    };
    const rows = hotkeys.map((hotkey, index) => ({
      coldkey: `owner-${index}`,
      hotkey,
      netuid: 23,
      evidence: structuredClone(frozen.members[0].evidence),
    }));
    const response = await post(
      { alpha_snapshot: snapshot, rows },
      env,
      SECRET,
      POSITION_PATH,
    );
    const body = await json(response);
    assert.equal(body.alpha_snapshot.selected, 1);
    assert.equal(body.alpha_snapshot.current, true);
    return Object.fromEntries(
      ANCHOR_FIELDS.map((field) => [field, snapshot[field]]),
    );
  };
  const captureRoot = async (size: number) => {
    const snapshot = {
      ...frozen.alpha_snapshot,
      block_number: 100,
      block_hash: "0x" + "c".repeat(64),
      spec_version: 479,
      code_hash: ALPHA_RUNTIMES[479].code,
      metadata_sha256: ALPHA_RUNTIMES[479].metadata,
      metadata_scale_hex: readFileSync(
        new URL("./fixtures/alpha-runtime/metadata-479.hex", import.meta.url),
        "utf8",
      ).trim(),
      scanned_legacy: 0,
      scanned_v2: size,
      distinct_members: size,
      excluded_root_members: size,
      total_rows: 0,
      total_chunks: 1,
      index: 0,
    };
    const selected = await json(
      await post(
        { alpha_snapshot: snapshot, rows: [] },
        env,
        SECRET,
        POSITION_PATH,
      ),
    );
    assert.equal(selected.alpha_snapshot.selected, 1);
    assert.equal(selected.alpha_snapshot.current, true);
    return Object.fromEntries(
      ANCHOR_FIELDS.map((field) => [field, snapshot[field]]),
    );
  };
  const status = (anchor: Row, passTotal = 2, environment = env) =>
    post(
      {
        counts_status: true,
        alpha_snapshot: anchor,
        pass_total: passTotal,
      },
      environment,
    );
  const deliver = async (body: Row, environment = env) => {
    const calls: string[] = [];
    const message = {
      body,
      ack() {
        calls.push("ack");
      },
      retry() {
        calls.push("retry");
      },
    };
    await worker.queue(
      { queue: "sync-batches", messages: [message] } as never,
      environment,
      context,
    );
    await Promise.allSettled(background.splice(0));
    return calls;
  };
  const counts = async () => {
    const sql = "SELECT * FROM validator_nominator_counts ORDER BY hotkey";
    const result = await db.prepare(sql).all<Row>();
    return result.results;
  };
  const receipts = async () => {
    const sql =
      "SELECT * FROM validator_nominator_counts_passes ORDER BY captured_at";
    const result = await db.prepare(sql).all<Row>();
    return result.results;
  };
  return {
    db,
    env,
    sent,
    post,
    capture,
    captureRoot,
    status,
    deliver,
    counts,
    receipts,
  };
}

async function json(response: Response): Promise<Row> {
  assert.equal(response.status, 200);
  return (await response.json()) as Row;
}

function countRow(hotkey: string, anchor: Row, nominatorCount = 1) {
  return {
    hotkey,
    nominator_count: nominatorCount,
    captured_at: anchor.captured_at,
  };
}

test("bulk counts require queue admission", async () => {
  const f = await fixture();
  const size = 25_000;
  const anchor = await f.captureRoot(size);
  const rows = Array.from({ length: size }, (_, index) =>
    countRow(String(index).padStart(48, "x"), anchor),
  );
  const body = { rows, pass_total: size, alpha_snapshot: anchor };
  const bytes = Buffer.byteLength(JSON.stringify(body));
  assert.ok(bytes > 2_000_000 && bytes < 8_000_000);
  let batches = 0;
  const inline = dataApiEnv({
    ...f.env,
    SYNC_QUEUE_LANES: "",
    SYNC_BATCHES: undefined,
    D1_STATE: {
      prepare: f.db.prepare.bind(f.db),
      async batch(statements: D1PreparedStatement[]) {
        batches++;
        return f.db.batch(statements);
      },
    },
  });
  const refused = await f.post(body, inline);
  assert.equal(refused.status, 413);
  const error = (await refused.json()) as Row;
  assert.match(error.error, /1000 rows.*98304 UTF8 bytes.*projected rows JSON/);
  assert.match(error.error, /configure validator-nominator-counts queue/);
  assert.equal(batches, 0);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(await f.counts(), []);
  assert.deepEqual(await f.receipts(), []);
  const pending = await json(await f.status(anchor, size, inline));
  assert.equal(pending.current, true);
  assert.equal(pending.complete, false);
  assert.equal(pending.applied_count, 0);
  assert.equal(pending.completed_at, null);
  const queued = await json(await f.post(body));
  assert.deepEqual(queued, {
    ok: true,
    stores: ["queue"],
    queued: true,
    alpha_snapshot: anchor,
    pass_total: size,
  });
  assert.ok(f.sent.length > 1);
  for (const message of f.sent) {
    assert.ok(message.rows.length <= 5000);
    assert.ok(Buffer.byteLength(JSON.stringify(message)) <= 128 * 1024);
    assert.deepEqual(message.alpha_snapshot, anchor);
    assert.equal(message.pass_total, size);
  }
  assert.deepEqual(
    f.sent.flatMap((message) => message.rows),
    rows,
  );
  assert.deepEqual(await json(await f.status(anchor, size)), pending);
  assert.deepEqual(await f.counts(), []);
  assert.deepEqual(await f.receipts(), []);
});

test("inline count boundaries retain atomic durable completion", async () => {
  const f = await fixture();
  const size = 1000;
  const anchor = await f.captureRoot(size);
  const rows = Array.from({ length: size }, (_, index) =>
    countRow(String(index).padStart(32, "x"), anchor),
  );
  let padding = 96 * 1024 - Buffer.byteLength(JSON.stringify(rows));
  for (const row of rows) {
    const added = Math.min(padding, 128 - row.hotkey.length);
    row.hotkey += "p".repeat(added);
    padding -= added;
    if (!padding) break;
  }
  assert.equal(padding, 0);
  assert.equal(Buffer.byteLength(JSON.stringify(rows)), 96 * 1024);
  const body = { rows, pass_total: size, alpha_snapshot: anchor };
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let committed = false;
  let acknowledged = false;
  let batches = 0;
  const inline = dataApiEnv({
    ...f.env,
    SYNC_QUEUE_LANES: "",
    SYNC_BATCHES: undefined,
    D1_STATE: {
      prepare: f.db.prepare.bind(f.db),
      async batch(statements: D1PreparedStatement[]) {
        batches++;
        started.resolve();
        await gate.promise;
        const result = await f.db.batch(statements);
        committed = true;
        return result;
      },
    },
  });
  const response = f.post(body, inline).then((result) => {
    acknowledged = true;
    return result;
  });
  try {
    await started.promise;
    assert.deepEqual(await f.counts(), []);
    const pending = await json(await f.status(anchor, size, inline));
    assert.equal(pending.complete, false);
    assert.equal(pending.applied_count, 0);
    assert.equal(pending.completed_at, null);
    assert.equal(acknowledged, false);
    assert.equal(committed, false);
  } finally {
    gate.resolve();
  }
  const applied = await json(await response);
  assert.equal(committed, true);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(applied.stores, ["d1"]);
  assert.deepEqual(applied.alpha_snapshot, anchor);
  assert.equal(applied.queued, undefined);
  assert.equal(applied.current, true);
  assert.equal(applied.complete, true);
  assert.equal(applied.pass_total, size);
  assert.equal(applied.applied_count, size);
  assert.equal(typeof applied.completed_at, "number");
  assert.ok(applied.completed_at > 0);
  assert.equal((await f.counts()).length, size);
  assert.deepEqual(await json(await f.status(anchor, size, inline)), applied);
  const last = rows[rows.length - 1];
  const oversized = [
    ...rows.slice(0, -1),
    { ...last, hotkey: last.hotkey + "x" },
  ];
  assert.equal(Buffer.byteLength(JSON.stringify(oversized)), 96 * 1024 + 1);
  const refused = await f.post({ ...body, rows: oversized }, inline);
  assert.equal(refused.status, 413);
  assert.equal(batches, 1);
  assert.deepEqual(await json(await f.status(anchor, size, inline)), applied);
});

test("inline count row limits reject before a native write", async () => {
  const f = await fixture();
  const size = 1001;
  const anchor = await f.captureRoot(size);
  const rows = Array.from({ length: size }, (_, index) =>
    countRow(String(index), anchor),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(rows)) < 96 * 1024);
  const inline = dataApiEnv({
    ...f.env,
    SYNC_QUEUE_LANES: "",
    SYNC_BATCHES: undefined,
  });
  const body = { rows, pass_total: size, alpha_snapshot: anchor };
  assert.equal((await f.post(body, inline)).status, 413);
  assert.deepEqual(await f.counts(), []);
  assert.deepEqual(await f.receipts(), []);
});

test("queue admission is not a durable count receipt; partial delivery and retries tally unique hotkeys", async () => {
  const f = await fixture();
  const anchor = await f.capture();
  const first = {
    rows: [countRow("hot-a", anchor)],
    pass_total: 2,
    alpha_snapshot: anchor,
  };
  const admission = await json(await f.post(first));
  assert.deepEqual(admission, {
    ok: true,
    stores: ["queue"],
    queued: true,
    alpha_snapshot: anchor,
    pass_total: 2,
  });
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].alpha_snapshot, anchor);
  assert.equal(f.sent[0].pass_total, 2);
  assert.deepEqual(await f.counts(), []);
  const unconsumed = await json(await f.status(anchor));
  assert.deepEqual(unconsumed.stores, ["d1"]);
  assert.equal(unconsumed.current, true);
  assert.equal(unconsumed.complete, false);
  assert.equal(unconsumed.applied_count, 0);
  assert.equal(unconsumed.completed_at, null);
  assert.deepEqual(await f.deliver(f.sent[0]), ["ack"]);
  const partial = await json(await f.status(anchor));
  assert.equal(partial.complete, false);
  assert.equal(partial.applied_count, 1);
  assert.equal(partial.completed_at, null);
  assert.deepEqual(await f.deliver(f.sent[0]), ["ack"]);
  const duplicate = await json(await f.status(anchor));
  assert.equal(duplicate.applied_count, 1);
  assert.equal(duplicate.complete, false);
  const last = { ...first, rows: [countRow("hot-b", anchor)] };
  await json(await f.post(last));
  assert.deepEqual(await f.deliver(f.sent[1]), ["ack"]);
  const complete = await json(await f.status(anchor));
  assert.equal(complete.current, true);
  assert.equal(complete.complete, true);
  assert.equal(complete.applied_count, 2);
  assert.equal(typeof complete.completed_at, "number");
  assert.deepEqual(complete.alpha_snapshot, anchor);
  assert.deepEqual(complete.stores, ["d1"]);
  const stored = await f.counts();
  assert.deepEqual(
    stored.map((row) => row.hotkey),
    ["hot-a", "hot-b"],
  );
  await f.deliver(f.sent[1]);
  assert.deepEqual(await json(await f.status(anchor)), complete);
});

test("delayed queue delivery cannot write after a higher block with a lower capture clock", async () => {
  const f = await fixture();
  const old = await f.capture();
  const first = {
    rows: [countRow("hot-a", old)],
    pass_total: 2,
    alpha_snapshot: old,
  };
  await json(await f.post(first));
  const last = { ...first, rows: [countRow("hot-b", old)] };
  await json(await f.post(last));
  assert.deepEqual(await f.deliver(f.sent[0]), ["ack"]);
  const current = await f.capture(["hot-a", "hot-b"], STAMP - 1, 101);
  assert.deepEqual(await f.deliver(f.sent[1]), ["retry"]);
  const oldStatus = await json(await f.status(old));
  assert.equal(oldStatus.current, false);
  assert.equal(oldStatus.complete, false);
  assert.equal(oldStatus.applied_count, 1);
  const newRows = [countRow("hot-a", current), countRow("hot-b", current)];
  await json(
    await f.post({ rows: newRows, alpha_snapshot: current, pass_total: 2 }),
  );
  assert.deepEqual(await f.deliver(f.sent[2]), ["ack"]);
  const finished = await json(await f.status(current));
  assert.equal(finished.complete, true);
  assert.equal(finished.current, true);
  assert.equal(finished.applied_count, 2);
  const rows = await f.counts();
  assert.ok(rows.every((row) => row.captured_at === STAMP - 1));
  assert.deepEqual(await f.deliver(f.sent[0]), ["retry"]);
  assert.deepEqual(await f.counts(), rows);
});

test("the same POST handles an empty control pass inline and authenticates status", async () => {
  const f = await fixture();
  const anchor = await f.capture([]);
  const body = { rows: [], pass_total: 0, alpha_snapshot: anchor };
  const applied = await json(await f.post(body));
  assert.deepEqual(applied.stores, ["d1"]);
  assert.equal(applied.complete, true);
  assert.equal(applied.current, true);
  assert.equal(applied.applied_count, 0);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(await json(await f.status(anchor, 0)), applied);
  const request = {
    counts_status: true,
    alpha_snapshot: anchor,
    pass_total: 0,
  };
  assert.equal((await f.post(request, f.env, null)).status, 401);
  assert.equal((await f.post(request, f.env, "wrong")).status, 401);
  const disabled = dataApiEnv({
    ...f.env,
    VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET: undefined,
  });
  assert.equal((await f.post(request, disabled)).status, 503);
});

test("malformed anchors, missing anchors and rows for another capture never enter the queue", async () => {
  const f = await fixture();
  const anchor = await f.capture();
  const row = countRow("hot-a", anchor);
  for (const body of [
    { rows: [row], pass_total: 2 },
    { counts_status: true, pass_total: 2 },
    { rows: [row], pass_total: 2, alpha_snapshot: {} },
    {
      rows: [row],
      pass_total: 2,
      alpha_snapshot: { ...anchor, block_hash: "malformed" },
    },
    {
      rows: [{ ...row, captured_at: STAMP + 1 }],
      pass_total: 2,
      alpha_snapshot: anchor,
    },
    { rows: [row, row], pass_total: 2, alpha_snapshot: anchor },
    { rows: [], pass_total: 2, alpha_snapshot: anchor },
    { rows: [row], pass_total: 0, alpha_snapshot: anchor },
    { rows: [row], pass_total: 2, alpha_snapshot: anchor, counts_status: true },
    { counts_status: false, pass_total: 2, alpha_snapshot: anchor },
  ]) {
    const response = await f.post(body);
    assert.equal(response.status, 400);
  }
  assert.equal(f.sent.length, 0);
  assert.deepEqual(await f.counts(), []);
});

test("native ownership must cover the entire capture and count family at admission and consumption", async () => {
  const f = await fixture();
  const anchor = await f.capture();
  const body = {
    rows: [countRow("hot-a", anchor)],
    pass_total: 2,
    alpha_snapshot: anchor,
  };
  for (const table of OWNER_TABLES.split(",")) {
    const tables = OWNER_TABLES.split(",").filter((name) => name !== table);
    const split = dataApiEnv({ ...f.env, D1_STATE_TABLES: tables.join(",") });
    assert.equal((await f.post(body, split)).status, 503);
    assert.equal((await f.status(anchor, 2, split)).status, 503);
  }
  assert.equal(f.sent.length, 0);
  await json(await f.post(body));
  const noOwner = dataApiEnv({ ...f.env, D1_STATE_TABLES: "" });
  assert.deepEqual(await f.deliver(f.sent[0], noOwner), ["retry"]);
  assert.deepEqual(await f.counts(), []);
  const pending = await json(await f.status(anchor));
  assert.equal(pending.applied_count, 0);
  assert.equal(pending.complete, false);
});

test("queue delivery cannot turn substituted or underdeclared hotkeys into a complete receipt", async () => {
  const f = await fixture();
  const anchor = await f.capture();
  for (const body of [
    {
      rows: [countRow("hot-a", anchor)],
      pass_total: 1,
      alpha_snapshot: anchor,
    },
    {
      rows: [countRow("hot-a", anchor), countRow("invented", anchor)],
      pass_total: 2,
      alpha_snapshot: anchor,
    },
    {
      rows: [countRow("hot-a", anchor, 2), countRow("hot-b", anchor)],
      pass_total: 2,
      alpha_snapshot: anchor,
    },
  ]) {
    await json(await f.post(body));
    const message = f.sent.at(-1)!;
    assert.deepEqual(await f.deliver(message), ["retry"]);
    assert.deepEqual(await f.counts(), []);
    const status = await json(await f.status(anchor));
    assert.equal(status.applied_count, 0);
    assert.equal(status.complete, false);
  }
});

test("failed enqueue or unavailable durable status never returns a successful receipt", async () => {
  const f = await fixture();
  const anchor = await f.capture();
  const body = {
    rows: [countRow("hot-a", anchor)],
    pass_total: 2,
    alpha_snapshot: anchor,
  };
  const brokenQueue = dataApiEnv({
    ...f.env,
    SYNC_BATCHES: {
      async send() {
        throw new Error("synthetic queue outage");
      },
    },
  });
  assert.equal((await f.post(body, brokenQueue)).status, 502);
  assert.deepEqual(await f.counts(), []);
  const unconsumed = await json(await f.status(anchor));
  assert.equal(unconsumed.complete, false);
  assert.equal(unconsumed.applied_count, 0);
  const unavailable = dataApiEnv({ ...f.env, D1_STATE: undefined });
  assert.equal((await f.status(anchor, 2, unavailable)).status, 503);
  const failedRead = dataApiEnv({
    ...f.env,
    D1_STATE: {
      prepare() {
        throw new Error("synthetic native read failure");
      },
      async batch() {
        throw new Error("status must never write");
      },
    },
  });
  assert.equal((await f.status(anchor, 2, failedRead)).status, 503);
  assert.equal(f.sent.length, 0);
});

test("inline anchored delivery reports durable completion when queue routing is disabled", async () => {
  const f = await fixture();
  const anchor = await f.capture();
  const inline = dataApiEnv({ ...f.env, SYNC_QUEUE_LANES: "" });
  const body = {
    rows: [countRow("hot-a", anchor), countRow("hot-b", anchor)],
    pass_total: 2,
    alpha_snapshot: anchor,
  };
  const receipt = await json(await f.post(body, inline));
  assert.equal(receipt.complete, true);
  assert.equal(receipt.current, true);
  assert.equal(receipt.applied_count, 2);
  assert.deepEqual(receipt.stores, ["d1"]);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(await json(await f.status(anchor)), receipt);
});

test("all chunks may be admitted before polling with a receiver clock behind capture time", async () => {
  const f = await fixture();
  const anchor = await f.capture();
  const clock = vi.spyOn(Date, "now").mockReturnValue(STAMP - 1);
  try {
    for (const hotkey of ["hot-a", "hot-b"]) {
      const response = await f.post({
        rows: [countRow(hotkey, anchor)],
        alpha_snapshot: anchor,
        pass_total: 2,
      });
      const admission = await json(response);
      assert.equal(admission.queued, true);
      assert.deepEqual(admission.stores, ["queue"]);
    }
    assert.equal(f.sent.length, 2);
    assert.deepEqual(await f.counts(), []);
    const firstPoll = await json(await f.status(anchor));
    assert.equal(firstPoll.current, true);
    assert.equal(firstPoll.complete, false);
    assert.equal(firstPoll.applied_count, 0);
    assert.equal(firstPoll.completed_at, null);
    assert.deepEqual(await f.deliver(f.sent[1]), ["ack"]);
    const partial = await json(await f.status(anchor));
    assert.equal(partial.complete, false);
    assert.equal(partial.applied_count, 1);
    assert.equal(partial.completed_at, null);
    assert.deepEqual(await f.deliver(f.sent[0]), ["ack"]);
    const complete = await json(await f.status(anchor));
    assert.equal(complete.current, true);
    assert.equal(complete.complete, true);
    assert.equal(complete.pass_total, 2);
    assert.equal(complete.applied_count, 2);
    assert.equal(complete.completed_at, STAMP - 1);
    assert.deepEqual(complete.stores, ["d1"]);
    assert.deepEqual(complete.alpha_snapshot, anchor);
    const fields = [...ANCHOR_FIELDS].sort();
    assert.deepEqual(Object.keys(complete.alpha_snapshot).sort(), fields);
  } finally {
    clock.mockRestore();
  }
});

test("an anchored request cannot use an unselected native owner even when its tables exist", async () => {
  const f = await fixture();
  const anchor = await f.capture();
  const unselected = dataApiEnv({ ...f.env, D1_STATE_TABLES: "" });
  const response = await f.post(
    {
      rows: [countRow("hot-a", anchor)],
      alpha_snapshot: anchor,
      pass_total: 2,
    },
    unselected,
  );
  assert.equal(response.status, 503);
  assert.equal((await f.status(anchor, 2, unselected)).status, 503);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(await f.counts(), []);
  assert.deepEqual(await f.receipts(), []);
});

test("legacy HTTP and queued delivery fail closed when native discovery loses its binding", async () => {
  const f = await fixture();
  const legacy = {
    rows: [countRow("legacy-only", { captured_at: STAMP })],
    pass_total: 1,
  };
  const admitted = await json(await f.post(legacy));
  assert.deepEqual(admitted.stores, ["queue"]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].alpha_snapshot, undefined);
  const anchor = await f.capture();
  let fallbackReads = 0;
  const unavailable = dataApiEnv({
    ...f.env,
    D1_STATE: undefined,
    HYPERDRIVE: {
      get connectionString() {
        fallbackReads++;
        return undefined;
      },
    },
  });
  assert.equal((await f.post(legacy, unavailable)).status, 503);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(await f.deliver(f.sent[0], unavailable), ["retry"]);
  assert.equal(fallbackReads, 0);
  assert.deepEqual(await f.counts(), []);
  assert.deepEqual(await f.receipts(), []);
  const status = await json(await f.status(anchor));
  assert.equal(status.current, true);
  assert.equal(status.complete, false);
  assert.equal(status.applied_count, 0);
});

test("legacy messages admitted before Alpha selection cannot mutate anchored count state", async () => {
  const f = await fixture();
  const legacy = {
    rows: [countRow("legacy-only", { captured_at: STAMP + 1 })],
    pass_total: 1,
  };
  await json(await f.post(legacy));
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].alpha_snapshot, undefined);
  assert.deepEqual(await f.counts(), []);
  const anchor = await f.capture();
  await json(
    await f.post({
      rows: [countRow("hot-a", anchor)],
      alpha_snapshot: anchor,
      pass_total: 2,
    }),
  );
  assert.deepEqual(await f.deliver(f.sent[1]), ["ack"]);
  const beforeRows = await f.counts();
  const beforeReceipts = await f.receipts();
  assert.equal(beforeRows.length, 1);
  assert.equal(beforeReceipts.length, 1);
  let nativeBatches = 0;
  let fallbackReads = 0;
  const observed = dataApiEnv({
    ...f.env,
    D1_STATE: {
      prepare: f.db.prepare.bind(f.db),
      async batch(statements: D1PreparedStatement[]) {
        nativeBatches++;
        return f.db.batch(statements);
      },
    },
    HYPERDRIVE: {
      get connectionString() {
        fallbackReads++;
        return undefined;
      },
    },
  });
  assert.deepEqual(await f.deliver(f.sent[0], observed), ["retry"]);
  assert.equal(nativeBatches, 0);
  assert.equal(fallbackReads, 0);
  assert.deepEqual(await f.counts(), beforeRows);
  assert.deepEqual(await f.receipts(), beforeReceipts);
  const status = await json(await f.status(anchor));
  assert.equal(status.current, true);
  assert.equal(status.complete, false);
  assert.equal(status.applied_count, 1);
});
