import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import { Miniflare } from "miniflare";
import { dataApiEnv } from "./helpers/worker-env.ts";
import worker from "../workers/data-api.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('fixture')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
const secret = "fixture-health-secret";
const row = (lane: string) => ({
  lane,
  verdict: "ok",
  age_ms: 50,
  detail: "completed — exact identity",
  checked_at: 1_790_000_000_000,
});
const digest = (body: string) =>
  createHash("sha256").update(body).digest("hex");

beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  const schema = readFileSync(
    new URL("fixtures/sqlite-schema/0014_lane_health.sql", import.meta.url),
    "utf8",
  ).replace(/^--.*$/gm, "");
  for (const sql of schema.split(";"))
    if (sql.trim()) await db.prepare(sql).run();
});
afterAll(async () => runtime.dispose());
beforeEach(async () => {
  await db.prepare("DROP TRIGGER IF EXISTS reject_health").run();
  await db.prepare("DROP TRIGGER IF EXISTS reject_prune").run();
  await db.prepare("DELETE FROM lane_health").run();
});

function send(body: string) {
  return worker.fetch(
    new Request("https://fixture/api/v1/internal/poller-lane-health-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-poller-lane-health-sync-token": secret,
      },
      body,
    }),
    dataApiEnv({
      D1_STATE: db,
      D1_STATE_TABLES: "lane_health",
      POLLER_LANE_HEALTH_SYNC_SECRET: secret,
    }),
    { waitUntil() {} } as unknown as ExecutionContext,
  );
}

test("complete persistence acknowledges the exact original UTF-8 request", async () => {
  const body =
    JSON.stringify({ rows: [row("ownership"), row("alpha")] }, null, 2) + "\n";
  const response = await send(body);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    lane_health_written: 2,
    lane_health_expected: 2,
    request_sha256: digest(body),
    stores: ["neon"],
  });
  assert.equal(
    await db.prepare("SELECT COUNT(*) n FROM lane_health").first("n"),
    2,
  );
  assert.notEqual(digest(body), digest(JSON.stringify(JSON.parse(body))));
});

test("zero persisted verdicts return a failed acknowledgement with the original identity", async () => {
  await db
    .prepare(
      "CREATE TRIGGER reject_health BEFORE INSERT ON lane_health BEGIN SELECT RAISE(ABORT,'fixture'); END",
    )
    .run();
  const body = JSON.stringify({ rows: [row("ownership")] });
  const response = await send(body);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    lane_health_written: 0,
    lane_health_expected: 1,
    request_sha256: digest(body),
    stores: ["neon"],
  });
  assert.equal(
    await db.prepare("SELECT COUNT(*) n FROM lane_health").first("n"),
    0,
  );
});

test("partial persistence reports its actual count and cannot be mistaken for no writes", async () => {
  await db
    .prepare(
      "CREATE TRIGGER reject_health BEFORE INSERT ON lane_health WHEN NEW.lane='reject' BEGIN SELECT RAISE(ABORT,'fixture'); END",
    )
    .run();
  const body = JSON.stringify([row("ownership"), row("reject")]);
  const response = await send(body);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    lane_health_written: 1,
    lane_health_expected: 2,
    request_sha256: digest(body),
    stores: ["neon"],
  });
  assert.deepEqual(
    (await db.prepare("SELECT lane FROM lane_health").all()).results,
    [{ lane: "ownership" }],
  );
});

test("a silently ignored insert cannot acknowledge persistence", async () => {
  await db
    .prepare(
      "CREATE TRIGGER reject_health BEFORE INSERT ON lane_health WHEN NEW.lane='reject' BEGIN SELECT RAISE(IGNORE); END",
    )
    .run();
  for (const rows of [[row("reject")], [row("ownership"), row("reject")]]) {
    const body = JSON.stringify({ rows });
    const response = await send(body);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      ok: false,
      lane_health_written: rows.length - 1,
      lane_health_expected: rows.length,
      request_sha256: digest(body),
      stores: ["neon"],
    });
  }
  assert.deepEqual(
    (await db.prepare("SELECT lane FROM lane_health").all()).results,
    [{ lane: "ownership" }],
  );
});

test("retention failure does not deny an insert that actually landed", async () => {
  await db
    .prepare(
      "INSERT INTO lane_health(lane,verdict,checked_at) VALUES('ownership','stale',1)",
    )
    .run();
  await db
    .prepare(
      "CREATE TRIGGER reject_prune BEFORE DELETE ON lane_health BEGIN SELECT RAISE(ABORT,'fixture'); END",
    )
    .run();
  const body = JSON.stringify({ rows: [row("ownership")] });
  const response = await send(body);
  assert.equal(response.status, 200);
  const ack = (await response.json()) as {
    ok: boolean;
    lane_health_written: number;
    request_sha256: string;
  };
  assert.equal(ack.ok, true);
  assert.equal(ack.lane_health_written, 1);
  assert.equal(ack.request_sha256, digest(body));
  assert.equal(
    await db.prepare("SELECT COUNT(*) n FROM lane_health").first("n"),
    2,
  );
});
