import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, test, vi } from "vitest";
import worker from "../workers/data-api.ts";
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
  return { db, env, sent, post, capture, status, deliver, counts };
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
