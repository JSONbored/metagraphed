import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  nativeWebhookFixture,
  webhookMessage,
} from "./helpers/webhook-ledger-fixture.ts";
import {
  webhookLedgerD1,
  webhookLedgerForEnv,
} from "../src/webhook-ledger-d1.ts";
import { webhookDeliveryStatus } from "../src/webhook-delivery-status.ts";
import {
  WEBHOOK_DELIVERY_TTL_SECONDS,
  webhookIdempotencyKey,
} from "../src/webhooks.ts";
import type { D1StoreBinding } from "../src/d1-store.ts";

const opened: Awaited<ReturnType<typeof nativeWebhookFixture>>[] = [];
afterEach(async () => {
  for (const f of opened.splice(0)) await f.runtime.dispose();
});
async function fixture() {
  vi.useRealTimers();
  const f = await nativeWebhookFixture();
  opened.push(f);
  return f;
}
const URL = "https://hooks.example.com/event";
const NOW = 100_000;
const delivered = { status: "delivered", status_code: 200 };
const failed = {
  status: "failed",
  reason: "http-503",
  status_code: 503,
  retryable: true,
};
async function claimed(
  f: Awaited<ReturnType<typeof fixture>>,
  now = NOW,
  round = 1,
) {
  const message = webhookMessage();
  const claim = await f.ledger.claim(message, URL, round, now);
  assert.equal(claim.kind, "claimed");
  if (claim.kind !== "claimed") throw new Error("missing claim");
  return { message, attempt: claim.attempt };
}

test("intent retains original payload, idempotency and180-day expiry before enqueue", async () => {
  const f = await fixture(),
    m = webhookMessage();
  const r = await f.ledger.ensure(m, NOW);
  assert.equal(
    r.idempotency_key,
    await webhookIdempotencyKey(m.subscription_id, m.body),
  );
  assert.equal(r.expires_at, NOW + WEBHOOK_DELIVERY_TTL_SECONDS * 1000);
  assert.deepEqual(await f.ledger.outbox(NOW), [m]);
  await f.ledger.enqueued(m.subscription_id, m.event_id, NOW + 1);
  assert.deepEqual(await f.ledger.outbox(NOW + 1), []);
  assert.equal(
    (await f.ledger.recent(m.subscription_id, NOW))[0].state,
    "pending",
  );
  await assert.rejects(f.ledger.enqueued("absent", m.event_id, NOW));
});

test("event payload and intent identities are immutable and invalid inputs do not acquire effects", async () => {
  const f = await fixture(),
    m = webhookMessage();
  await assert.rejects(
    f.ledger.ensure({ ...m, event_id: "a".repeat(32) }, NOW),
  );
  await assert.rejects(f.ledger.ensure({ ...m, subscription_id: "" }, NOW));
  await assert.rejects(
    f.ledger.ensure({ ...m, subscription_id: "x".repeat(129) }, NOW),
  );
  await assert.rejects(f.ledger.ensure({ ...m, body: "" }, NOW));
  await assert.rejects(
    f.ledger.ensure(webhookMessage("sub", "é".repeat(65537)), NOW),
  );
  await assert.rejects(f.ledger.ensure(m, 0));
  await assert.rejects(f.ledger.ensure(m, Number.MAX_SAFE_INTEGER));
  await f.ledger.ensure(m, NOW);
  await assert.rejects(
    f.db
      .prepare(
        "UPDATE webhook_delivery_events SET body='changed' WHERE event_id=?",
      )
      .bind(m.event_id)
      .run(),
  );
  await assert.rejects(
    f.db
      .prepare("UPDATE webhook_delivery_intents SET idempotency_key=?")
      .bind("a".repeat(64))
      .run(),
  );
  await assert.rejects(f.ledger.claim(m, URL, 0, NOW));
  await assert.rejects(f.ledger.claim(m, "x".repeat(8193), 1, NOW));
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM webhook_delivery_attempts")
        .first<{ n: number }>()
    )?.n,
    0,
  );
});

test("a refused or colliding event/intent write cannot be acknowledged", async () => {
  const f = await fixture(),
    m = webhookMessage();
  await f.db
    .prepare(
      "CREATE TRIGGER ignored_event BEFORE INSERT ON webhook_delivery_events BEGIN SELECT RAISE(IGNORE); END",
    )
    .run();
  await assert.rejects(f.ledger.ensure(m, NOW));
  await f.db.prepare("DROP TRIGGER ignored_event").run();
  await f.db
    .prepare("INSERT INTO webhook_delivery_events VALUES(?,?,?,?,?)")
    .bind(m.event_id, "f".repeat(64), "another payload", NOW, NOW + 1)
    .run();
  await assert.rejects(f.ledger.ensure(m, NOW));
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM webhook_delivery_intents")
        .first<{ n: number }>()
    )?.n,
    0,
  );
});

test("two concurrent owners produce one claimed attempt and stable replay", async () => {
  const f = await fixture(),
    m = webhookMessage();
  const claims = await Promise.all([
    f.ledger.claim(m, URL, 1, NOW),
    f.ledger.claim(m, URL, 1, NOW),
  ]);
  assert.equal(claims.filter((c) => c.kind === "claimed").length, 1);
  assert.equal(claims.filter((c) => c.kind === "busy").length, 1);
  const c = claims.find((c) => c.kind === "claimed");
  assert(c?.kind === "claimed");
  await f.ledger.finish(c.attempt, delivered, "delivered", NOW + 1, null);
  assert.equal((await f.ledger.claim(m, URL, 1, NOW + 2)).kind, "delivered");
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM webhook_delivery_attempts")
        .first<{ n: number }>()
    )?.n,
    1,
  );
});

test("expired leases preserve ambiguity and admit an at-least-once attempt at the new target", async () => {
  const f = await fixture(),
    { message, attempt } = await claimed(f);
  const before = await f.ledger.recent("sub", NOW + 60_000);
  assert.equal(before[0].state, "ambiguous");
  assert.match(String(before[0].reason), /outcome-unknown/);
  const replay = await f.ledger.claim(
    message,
    URL + "/repointed",
    2,
    NOW + 60_001,
  );
  assert.equal(replay.kind, "claimed");
  const rows = await f.db
    .prepare(
      "SELECT outcome,target_url,ambiguous_at FROM webhook_delivery_attempts ORDER BY sequence",
    )
    .all();
  assert.equal(rows.results[0].outcome, "ambiguous");
  assert.equal(rows.results[0].ambiguous_at, NOW + 60_001);
  assert.equal(rows.results[1].target_url, URL + "/repointed");
  await f.ledger.finish(attempt, delivered, "delivered", NOW + 60_002, null);
  if (replay.kind === "claimed")
    await f.ledger.finish(replay.attempt, failed, "dead", NOW + 60_003, null);
  assert.equal(
    (await f.ledger.recent("sub", NOW + 60_004))[0].state,
    "delivered",
  );
  assert.equal(
    (await f.ledger.claim(message, URL, 3, NOW + 60_005)).kind,
    "delivered",
  );
});

test("success attempt evidence remains authoritative when aggregate update is ignored", async () => {
  const f = await fixture(),
    { message, attempt } = await claimed(f);
  await f.db
    .prepare(
      "CREATE TRIGGER ignored_projection BEFORE UPDATE OF state ON webhook_delivery_intents WHEN NEW.state='delivered' BEGIN SELECT RAISE(IGNORE); END",
    )
    .run();
  const result = await f.ledger.finish(
    attempt,
    delivered,
    "delivered",
    NOW + 1,
    null,
  );
  assert.equal(result.state, "delivered");
  assert.equal(
    (await f.db.prepare("SELECT state FROM webhook_delivery_intents").first())
      ?.state,
    "sending",
  );
  assert.equal(
    (await f.ledger.claim(message, URL, 2, NOW + 2)).kind,
    "delivered",
  );
  assert.equal(
    (await f.ledger.deadLetter(message, NOW + 3)).state,
    "delivered",
  );
  assert.deepEqual(await f.ledger.outbox(NOW + 4), []);
  assert.equal((await f.ledger.recent("sub", NOW + 5))[0].state, "delivered");
});

test("lost committed reply is resolved without a new attempt", async () => {
  const f = await fixture(),
    { message, attempt } = await claimed(f);
  const uncertain = webhookLedgerD1({
    prepare: f.db.prepare.bind(f.db),
    async batch(s) {
      await f.db.batch(s);
      throw new Error("lost reply");
    },
  } as D1StoreBinding);
  await assert.rejects(
    uncertain.finish(attempt, delivered, "delivered", NOW + 1, null),
  );
  assert.equal(
    (await f.ledger.claim(message, URL, 2, NOW + 2)).kind,
    "delivered",
  );
  await assert.rejects(f.ledger.finish(attempt, failed, "dead", NOW + 3, null));
  await assert.rejects(
    f.db.prepare("UPDATE webhook_delivery_attempts SET outcome='failed'").run(),
  );
  await assert.rejects(
    f.db.prepare("UPDATE webhook_delivery_intents SET state='dead'").run(),
  );
});

test("failed aggregate projection is refused before queue acknowledgment", async () => {
  const f = await fixture(),
    { attempt } = await claimed(f);
  await f.db
    .prepare(
      "CREATE TRIGGER ignored_projection BEFORE UPDATE OF state ON webhook_delivery_intents WHEN NEW.state='dead' BEGIN SELECT RAISE(IGNORE); END",
    )
    .run();
  await assert.rejects(f.ledger.finish(attempt, failed, "dead", NOW + 1, null));
  assert.equal(
    (await f.ledger.recent("sub", NOW + 60_001))[0].state,
    "ambiguous",
  );
});

test("attempt insert refusal prevents a claim and invalid finish identity refuses", async () => {
  const f = await fixture(),
    m = webhookMessage();
  await f.db
    .prepare(
      "CREATE TRIGGER ignored_attempt BEFORE INSERT ON webhook_delivery_attempts BEGIN SELECT RAISE(IGNORE); END",
    )
    .run();
  await assert.rejects(f.ledger.claim(m, URL, 1, NOW));
  await assert.rejects(
    f.ledger.finish(
      {
        subscriptionId: "sub",
        eventId: m.event_id,
        sequence: 1,
        token: "absent",
        round: 1,
      },
      delivered,
      "delivered",
      NOW + 1,
      null,
    ),
  );
});

test("failed, skipped and unknown outcomes remain durable with the original queue round", async () => {
  for (const [result, outcome] of [
    [{ status: "failed", reason: "resolve-error" }, "failed"],
    [{ status: "skipped", reason: "unsafe-url" }, "skipped"],
    [{ status: "filtered" }, "skipped"],
    [{}, "ambiguous"],
  ] as const) {
    const f = await fixture(),
      { attempt } = await claimed(f, NOW, 8);
    const r = await f.ledger.finish(attempt, result, "dead", NOW + 1, null);
    assert.equal(r.state, "dead");
    assert.equal(r.round, 8);
    assert.equal(
      (
        await f.db
          .prepare("SELECT outcome FROM webhook_delivery_attempts")
          .first()
      )?.outcome,
      outcome,
    );
    assert.equal(
      (await f.ledger.claim(webhookMessage(), URL, 8, NOW + 2)).kind,
      "dead",
    );
    assert.equal(
      (await f.ledger.claim(webhookMessage(), URL, 1, NOW + 3)).kind,
      "dead",
      "duplicate automatic admission cannot reopen terminal outcomes",
    );
  }
});

test("retry keeps ambiguity, next time and every immutable attempt", async () => {
  const f = await fixture(),
    { message, attempt } = await claimed(f);
  const r = await f.ledger.finish(
    attempt,
    failed,
    "retry",
    NOW + 1,
    NOW + 300_001,
  );
  assert.equal(r.state, "pending");
  assert.match(String(r.reason), /outcome-unknown.*http-503/);
  assert.equal(r.next_attempt_at, new Date(NOW + 300_001).toISOString());
  const next = await f.ledger.claim(message, URL, 2, NOW + 300_001);
  assert(next.kind === "claimed");
  await f.ledger.finish(
    next.attempt,
    delivered,
    "delivered",
    NOW + 300_002,
    null,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM webhook_delivery_attempts")
        .first<{ n: number }>()
    )?.n,
    2,
  );
});

test("dead-letter does not fence a live attempt, expiry records ambiguity, then manual replay remains possible", async () => {
  const f = await fixture(),
    { message } = await claimed(f);
  assert.equal((await f.ledger.deadLetter(message, NOW + 1)).state, "sending");
  const r = await f.ledger.deadLetter(message, NOW + 60_001);
  assert.equal(r.state, "stale");
  assert.match(String(r.reason), /outcome-unknown/);
  assert.equal(
    (
      await f.db
        .prepare("SELECT outcome FROM webhook_delivery_attempts")
        .first()
    )?.outcome,
    "ambiguous",
  );
  await f.ledger.recoverExpired(NOW + 33 * 86400000);
  const replay = await f.ledger.authorizeReplay(
    message,
    "operator-request",
    NOW + 33 * 86400000 + 1,
  );
  assert.equal(
    (await f.ledger.claim(message, URL, 1, NOW + 33 * 86400000 + 2)).kind,
    "stale",
  );
  assert.equal(
    (await f.ledger.deadLetter(message, NOW + 33 * 86400000 + 2)).state,
    "stale",
  );
  assert.equal(
    (await f.ledger.claim(replay, URL, 1, NOW + 33 * 86400000 + 2)).kind,
    "claimed",
  );
});

test("refused dead-letter projection does not report completion", async () => {
  const f = await fixture(),
    m = webhookMessage();
  await f.ledger.ensure(m, NOW);
  await f.db
    .prepare(
      "CREATE TRIGGER ignored_projection BEFORE UPDATE OF state ON webhook_delivery_intents WHEN NEW.state='dead' BEGIN SELECT RAISE(IGNORE); END",
    )
    .run();
  await assert.rejects(f.ledger.deadLetter(m, NOW + 1));
});

test("exact known legacy success is adopted, wrong owner does not suppress delivery", async () => {
  const f = await fixture(),
    m = webhookMessage();
  const legacy = {
    subscription_id: "other",
    event_id: m.event_id,
    state: "delivered",
    last_attempt_at: "invalid",
    status_code: "bad",
  };
  assert.equal((await f.ledger.claim(m, URL, 1, NOW, legacy)).kind, "claimed");
  const r = await f.ledger.ensure(m, NOW + 1, {
    ...legacy,
    subscription_id: m.subscription_id,
  });
  assert.equal(r.state, "delivered");
  assert.equal(r.last_attempt_at, null);
  assert.equal(r.status_code, null);
  assert.equal((await f.ledger.claim(m, URL, 2, NOW + 2)).kind, "delivered");
});

test("status merges legacy with native precedence and fails closed for a broken bound ledger", async () => {
  const f = await fixture(),
    m = webhookMessage();
  const now = Date.now();
  const c = await f.ledger.claim(m, URL, 1, now);
  assert(c.kind === "claimed");
  await f.ledger.finish(c.attempt, delivered, "delivered", now + 1, null);
  const kv = {
    async list() {
      return { keys: [{ name: "same" }, { name: "legacy" }] };
    },
    async get(name: string) {
      return name === "same"
        ? { event_id: m.event_id, state: "dead" }
        : { event_id: "legacy", state: "pending", reason: "old", round: 1 };
    },
  };
  const status = await webhookDeliveryStatus(
    { D1_STATE: f.db, METAGRAPH_CONTROL: kv },
    "sub",
  );
  assert.equal(status.dead_letter, 0);
  assert.equal(status.pending, 1);
  assert.equal(
    (
      await webhookDeliveryStatus(
        {
          D1_STATE: f.db,
          METAGRAPH_CONTROL: {
            async list() {
              throw new Error("KV down");
            },
          },
        },
        "sub",
      )
    ).status,
    "ok",
  );
  await f.db.prepare("DROP TABLE webhook_delivery_attempts").run();
  await assert.rejects(
    webhookDeliveryStatus({ D1_STATE: f.db }, "sub"),
    /status unavailable/,
  );
  assert.equal(webhookLedgerForEnv({}), null);
  assert.equal(webhookLedgerForEnv(null), null);
  assert.equal((await webhookDeliveryStatus(null, "sub")).status, "ok");
});

test("status handles legacy-only malformed, absent and failed projections without claiming new outcomes", async () => {
  assert.equal(
    (await webhookDeliveryStatus({ METAGRAPH_CONTROL: {} }, "sub")).status,
    "ok",
  );
  assert.equal(
    (
      await webhookDeliveryStatus(
        {
          METAGRAPH_CONTROL: {
            async list() {
              return { keys: [{ name: "x" }] };
            },
            async get() {
              return ["bad"];
            },
          },
        },
        "sub",
      )
    ).status,
    "ok",
  );
});

test("retention preserves the full180-day horizon then bounded cleanup cascades attempts and payloads", async () => {
  const f = await fixture(),
    { message, attempt } = await claimed(f);
  await f.ledger.finish(attempt, delivered, "delivered", NOW + 1, null);
  const expiry = NOW + 1 + WEBHOOK_DELIVERY_TTL_SECONDS * 1000;
  await f.ledger.prune(expiry - 1);
  assert.equal((await f.ledger.recent("sub", expiry - 1)).length, 1);
  await f.ledger.prune(expiry);
  assert.deepEqual(await f.ledger.recent("sub", expiry), []);
  for (const table of [
    "webhook_delivery_intents",
    "webhook_delivery_attempts",
    "webhook_delivery_events",
  ])
    assert.equal(
      (
        await f.db
          .prepare(`SELECT count(*) AS n FROM ${table}`)
          .first<{ n: number }>()
      )?.n,
      0,
    );
  assert.equal(
    (await f.ledger.claim(message, URL, 1, expiry + 1)).kind,
    "claimed",
    "expired success is outside the deduplication horizon",
  );
});

test("automatic duplicates cannot reopen rejection or bypass retry due time; explicit replay is fenced", async () => {
  const f = await fixture(),
    { message, attempt } = await claimed(f);
  await f.ledger.finish(attempt, failed, "retry", NOW + 1, NOW + 300001);
  assert.equal((await f.ledger.claim(message, URL, 1, NOW + 2)).kind, "stale");
  assert.equal((await f.ledger.claim(message, URL, 2, NOW + 2)).kind, "busy");
  const retry = await f.ledger.claim(message, URL, 2, NOW + 300001);
  assert(retry.kind === "claimed");
  await f.ledger.finish(
    retry.attempt,
    { status: "failed", status_code: 400, reason: "http-400" },
    "dead",
    NOW + 300002,
    null,
  );
  assert.equal(
    (await f.ledger.claim(message, URL, 1, NOW + 300003)).kind,
    "dead",
  );
  assert.equal(
    (await f.ledger.claim(message, URL, 3, NOW + 300003)).kind,
    "dead",
  );
  const replay = await f.ledger.authorizeReplay(
    message,
    "explicit-operation",
    NOW + 300004,
  );
  assert.equal(replay.generation, 1);
  assert.deepEqual(
    await f.ledger.authorizeReplay(message, "explicit-operation", NOW + 300005),
    replay,
    "lost authorization reply is idempotent",
  );
  await assert.rejects(
    f.ledger.authorizeReplay(message, "another-operation", NOW + 300005),
  );
  await assert.rejects(f.ledger.authorizeReplay(message, "", NOW + 300005));
  assert.equal(
    (await f.ledger.claim(message, URL, 8, NOW + 300006)).kind,
    "stale",
  );
  assert.deepEqual(await f.ledger.outbox(NOW + 300006), [replay]);
  await f.ledger.enqueued(
    message.subscription_id,
    message.event_id,
    NOW + 300006,
  );
  assert.deepEqual(
    await f.ledger.outbox(NOW + 300006),
    [replay],
    "old enqueue acknowledgment cannot erase replay outbox",
  );
  const admitted = await f.ledger.claim(replay, URL, 1, NOW + 300007);
  assert(admitted.kind === "claimed");
  await f.ledger.finish(
    admitted.attempt,
    delivered,
    "delivered",
    NOW + 300008,
    null,
  );
  await assert.rejects(
    f.ledger.authorizeReplay(replay, "repeat-success", NOW + 300009),
  );
});

test("held0040/0041 to0042 upgrade preserves prior owners and fences old messages", async () => {
  const f = await nativeWebhookFixture(true);
  opened.push(f);
  const checkpoint = await f.db
    .prepare(
      "SELECT last_contiguous_block,genesis_hash FROM raw_capture_state WHERE network='mainnet'",
    )
    .first();
  assert.equal(checkpoint?.last_contiguous_block, 100);
  assert.equal(checkpoint?.genesis_hash, null);
  for (const table of [
    "self_stake_snapshot_passes",
    "self_stake_snapshot_chunks",
    "raw_capture_finality",
    "raw_capture_publications",
  ])
    assert.equal(
      (
        await f.db
          .prepare("SELECT name FROM sqlite_master WHERE name=?")
          .bind(table)
          .first()
      )?.name,
      table,
    );
  const { message, attempt } = await claimed(f);
  await f.ledger.finish(attempt, failed, "dead", NOW + 1, null);
  const replay = await f.ledger.authorizeReplay(message, "operator", NOW + 2);
  assert.equal((await f.ledger.deadLetter(message, NOW + 3)).state, "stale");
  assert.equal((await f.ledger.claim(message, URL, 1, NOW + 3)).kind, "stale");
  assert.equal((await f.ledger.claim(replay, URL, 1, NOW + 3)).kind, "claimed");
});

test("native finalization recovers a dropped DLQ beyond both transport retention horizons without resending", async () => {
  const f = await fixture(),
    { message, attempt } = await claimed(f);
  await f.ledger.finish(attempt, failed, "retry", NOW + 1, NOW + 300001);
  assert.equal(await f.ledger.recoverExpired(NOW + 31 * 86400000), 0);
  assert.equal(await f.ledger.recoverExpired(NOW + 33 * 86400000), 1);
  const record = (
    await f.ledger.recent(message.subscription_id, NOW + 33 * 86400000)
  )[0];
  assert.equal(record.state, "dead");
  assert.match(String(record.reason), /outcome-unknown/);
  assert.equal(
    (await f.ledger.claim(message, URL, 1, NOW + 33 * 86400000)).kind,
    "dead",
  );
});

test("representative native cleanup uses expiry/event indexes and reports bounded SQL work", async () => {
  const f = await fixture();
  await f.db
    .prepare(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1100)
    INSERT INTO webhook_delivery_events(event_id,payload_sha256,body,created_at,expires_at)
    SELECT printf('%032x',x),?, '{}',1,2 FROM n`,
    )
    .bind("a".repeat(64))
    .run();
  await f.db
    .prepare(
      `INSERT INTO webhook_delivery_intents(subscription_id,event_id,idempotency_key,created_at,updated_at,expires_at)
    SELECT 'subscriber',event_id,?,1,1,2 FROM webhook_delivery_events`,
    )
    .bind("b".repeat(64))
    .run();
  await f.db
    .prepare(
      `INSERT INTO webhook_delivery_attempts(subscription_id,event_id,sequence,token,target_url,generation,round,started_at,outcome)
    SELECT subscription_id,event_id,1,event_id,'https://hooks.example.com',0,1,1,'ambiguous' FROM webhook_delivery_intents`,
    )
    .run();
  const plan = (
    await f.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT e.event_id FROM webhook_delivery_events e
    WHERE e.expires_at<=? AND NOT EXISTS(SELECT 1 FROM webhook_delivery_intents i WHERE i.event_id=e.event_id)
    ORDER BY e.expires_at,e.event_id LIMIT 1024`,
      )
      .bind(NOW)
      .all()
  ).results;
  const details = plan.map((r) => String(r.detail)).join("\n");
  assert.match(details, /webhook_delivery_event_expiry/);
  assert.match(details, /webhook_delivery_intent_event/);
  let measurements: unknown[] = [];
  const measured = webhookLedgerD1({
    prepare: f.db.prepare.bind(f.db),
    async batch(statements) {
      const result = await f.db.batch(statements);
      measurements = result.map((r) => r.meta);
      return result;
    },
  } as D1StoreBinding);
  await measured.prune(NOW);
  assert.equal(
    (
      await f.db
        .prepare("SELECT COUNT(*) AS n FROM webhook_delivery_intents")
        .first()
    )?.n,
    76,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT COUNT(*) AS n FROM webhook_delivery_attempts")
        .first()
    )?.n,
    76,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT COUNT(*) AS n FROM webhook_delivery_events")
        .first()
    )?.n,
    76,
  );
  process.stdout.write(
    JSON.stringify({
      native_cleanup_fixture: {
        initial_intents: 1100,
        deleted_intents: 1024,
        plan,
        measurements,
      },
      production_capacity_proof: false,
    }) + "\n",
  );
});

test("concurrent DLQ pre-read cannot terminalize a surviving copy's newly scheduled retry", async () => {
  const f = await fixture(),
    m = webhookMessage();
  await f.ledger.ensure(m, NOW);
  let start!: (value: void) => void,
    resume!: (value: void) => void,
    pause = false;
  const started = new Promise<void>((resolve) => {
      start = resolve;
    }),
    released = new Promise<void>((resolve) => {
      resume = resolve;
    });
  const dlq = webhookLedgerD1({
    prepare(sql: string) {
      if (sql.startsWith("UPDATE webhook_delivery_intents SET state='dead'"))
        pause = true;
      return f.db.prepare(sql);
    },
    async batch(statements) {
      if (pause) {
        start();
        await released;
      }
      return f.db.batch(statements);
    },
  } as D1StoreBinding);
  const finishing = dlq.deadLetter(m, NOW + 3);
  await started;
  const claim = await f.ledger.claim(m, URL, 1, NOW + 1);
  assert(claim.kind === "claimed");
  await f.ledger.finish(claim.attempt, failed, "retry", NOW + 2, NOW + 300002);
  resume();
  assert.equal((await finishing).state, "stale");
  const current = (await f.ledger.recent(m.subscription_id, NOW + 4))[0];
  assert.equal(current.state, "pending");
  assert.equal(current.next_attempt_at, new Date(NOW + 300002).toISOString());
  assert.equal((await f.ledger.claim(m, URL, 2, NOW + 300002)).kind, "claimed");
});

test("native adoption retains a valid legacy receipt and refuses ignored or lost ownership updates", async () => {
  for (const mode of ["retained", "ignored", "removed"] as const) {
    const f = await fixture(),
      m = webhookMessage();
    await f.ledger.ensure(m, NOW);
    if (mode !== "retained")
      await f.db
        .prepare(
          mode === "ignored"
            ? "CREATE TRIGGER refused_legacy BEFORE UPDATE OF state ON webhook_delivery_intents WHEN NEW.state='delivered' BEGIN SELECT RAISE(IGNORE); END"
            : "CREATE TRIGGER removed_legacy AFTER UPDATE OF state ON webhook_delivery_intents WHEN NEW.state='delivered' BEGIN DELETE FROM webhook_delivery_intents WHERE subscription_id=NEW.subscription_id AND event_id=NEW.event_id; END",
        )
        .run();
    const legacy = {
      subscription_id: m.subscription_id,
      event_id: m.event_id,
      state: "delivered",
      status_code: 204,
      last_attempt_at: new Date(NOW - 1).toISOString(),
    };
    if (mode === "retained") {
      const receipt = await f.ledger.ensure(m, NOW + 1, legacy);
      assert.equal(receipt.state, "delivered");
      assert.equal(receipt.status_code, 204);
      assert.equal(receipt.last_attempt_at, NOW - 1);
      await f.ledger.enqueued(m.subscription_id, m.event_id, NOW + 2);
      assert.deepEqual(await f.ledger.outbox(NOW + 3), []);
    } else {
      await assert.rejects(
        f.ledger.ensure(m, NOW + 1, legacy),
        /Legacy webhook success was not retained/,
      );
      assert.equal(
        (
          await f.db
            .prepare("SELECT count(*) AS n FROM webhook_delivery_attempts")
            .first()
        )?.n,
        0,
      );
    }
  }
  const f = await fixture(),
    m = webhookMessage();
  const receipt = await f.ledger.ensure(m, NOW, {
    subscription_id: m.subscription_id,
    event_id: m.event_id,
    state: "delivered",
    last_attempt_at: NOW - 1,
  });
  assert.equal(
    receipt.last_attempt_at,
    null,
    "legacy epoch numbers cannot substitute for the receipt's declared ISO timestamp",
  );
});

test("an active lease and exhausted sequence budget cannot admit another receiver effect", async () => {
  const f = await fixture(),
    { message } = await claimed(f);
  assert.equal((await f.ledger.claim(message, URL, 2, NOW + 1)).kind, "busy");
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM webhook_delivery_attempts")
        .first()
    )?.n,
    1,
  );
  await f.db
    .prepare("UPDATE webhook_delivery_intents SET sequence=?")
    .bind(Number.MAX_SAFE_INTEGER)
    .run();
  await assert.rejects(
    f.ledger.claim(message, URL, 2, NOW + 60001),
    /sequence exceeds its budget/,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM webhook_delivery_attempts")
        .first()
    )?.n,
    1,
  );
});

test("a competing terminal owner wins the claim transaction without creating a second attempt", async () => {
  for (const disposition of ["delivered", "dead"] as const) {
    const f = await fixture(),
      m = webhookMessage();
    let competing = false;
    const ledger = webhookLedgerD1({
      prepare(sql: string) {
        if (
          sql.startsWith("UPDATE webhook_delivery_intents SET state='sending'")
        )
          competing = true;
        return f.db.prepare(sql);
      },
      async batch(statements) {
        if (competing) {
          competing = false;
          const winner = await f.ledger.claim(m, URL + "/winner", 1, NOW + 1);
          assert(winner.kind === "claimed");
          await f.ledger.finish(
            winner.attempt,
            disposition === "delivered" ? delivered : failed,
            disposition,
            NOW + 2,
            null,
          );
        }
        return f.db.batch(statements);
      },
    } as D1StoreBinding);
    const loser = await ledger.claim(m, URL, 1, NOW);
    assert.equal(loser.kind, disposition);
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM webhook_delivery_attempts")
          .first()
      )?.n,
      1,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT target_url FROM webhook_delivery_attempts")
          .first()
      )?.target_url,
      URL + "/winner",
    );
  }
});

test("a removed claim intent is refused rather than returned as a send authorization", async () => {
  const f = await fixture(),
    m = webhookMessage();
  await f.db
    .prepare(
      "CREATE TRIGGER removed_claim AFTER UPDATE OF state ON webhook_delivery_intents WHEN NEW.state='sending' BEGIN DELETE FROM webhook_delivery_intents WHERE subscription_id=NEW.subscription_id AND event_id=NEW.event_id; END",
    )
    .run();
  await assert.rejects(
    f.ledger.claim(m, URL, 1, NOW),
    /Webhook claim was not committed/,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM webhook_delivery_attempts")
        .first()
    )?.n,
    0,
  );
});

test("fanout rejects incomplete or mixed recipient sets before admitting any obligations", async () => {
  const f = await fixture(),
    m = webhookMessage();
  await f.ledger.ensureFanout([], NOW);
  await assert.rejects(
    f.ledger.ensureFanout(
      Array.from({ length: 1001 }, (_, n) => webhookMessage(`recipient-${n}`)),
      NOW,
    ),
    /selected KV page budget/,
  );
  for (const event of [
    { ...m, body: "" },
    webhookMessage("sub", "é".repeat(65537)),
    { ...m, event_id: "f".repeat(32) },
  ])
    await assert.rejects(
      f.ledger.ensureFanout([event], NOW),
      /fanout event identity differs/,
    );
  for (const recipient of [
    webhookMessage("second", { type: "different-event" }),
    { ...m, subscription_id: "second", event_id: "f".repeat(32) },
    { ...m, subscription_id: 7 },
    { ...m, subscription_id: "" },
    { ...m, subscription_id: "x".repeat(129) },
    m,
    { ...m, subscription_id: "second", generation: 1 },
  ])
    await assert.rejects(
      f.ledger.ensureFanout([m, recipient] as never, NOW),
      /fanout recipient identity differs/,
    );
  assert.deepEqual(await f.ledger.outbox(NOW), []);
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM webhook_delivery_events")
        .first()
    )?.n,
    0,
  );
});

test("refused fanout publication cannot acknowledge a partial recipient set", async () => {
  for (const refused of ["event", "recipient"] as const) {
    const f = await fixture(),
      messages = [webhookMessage("first"), webhookMessage("second")];
    await f.db
      .prepare(
        refused === "event"
          ? "CREATE TRIGGER refused_event BEFORE INSERT ON webhook_delivery_events BEGIN SELECT RAISE(IGNORE); END"
          : "CREATE TRIGGER refused_recipient BEFORE INSERT ON webhook_delivery_intents WHEN NEW.subscription_id='second' BEGIN SELECT RAISE(IGNORE); END",
      )
      .run();
    await assert.rejects(
      f.ledger.ensureFanout(messages, NOW),
      /complete fanout was not durably acknowledged/,
    );
    assert.equal(
      (await f.ledger.outbox(NOW)).length,
      refused === "event" ? 0 : 1,
    );
    if (refused === "recipient") {
      await f.db.prepare("DROP TRIGGER refused_recipient").run();
      await f.ledger.ensureFanout(messages, NOW + 1);
      assert.deepEqual(
        (await f.ledger.outbox(NOW + 1)).map((m) => m.subscription_id),
        ["first", "second"],
      );
    }
  }
});

test("status event ownership lookup stays bounded and an empty selection owns nothing", async () => {
  const f = await fixture();
  assert.deepEqual(await f.ledger.byEvents("sub", [], NOW), []);
  await assert.rejects(
    f.ledger.byEvents(
      "sub",
      Array.from({ length: 257 }, (_, n) => String(n)),
      NOW,
    ),
    /ownership batch exceeds its budget/,
  );
});

test("transport exhaustion refuses a lost owner instead of reporting a retained retry", async () => {
  const f = await fixture(),
    { message } = await claimed(f);
  await f.db
    .prepare(
      "CREATE TRIGGER removed_ambiguous AFTER UPDATE OF outcome ON webhook_delivery_attempts WHEN NEW.outcome='ambiguous' BEGIN DELETE FROM webhook_delivery_intents WHERE subscription_id=NEW.subscription_id AND event_id=NEW.event_id; END",
    )
    .run();
  await assert.rejects(
    f.ledger.deadLetter(message, NOW + 60001),
    /transport exhaustion was not retained/,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM webhook_delivery_attempts")
        .first()
    )?.n,
    0,
  );
});

test("dead-letter finalization refuses a lost intent and respects a concurrent authorized replay", async () => {
  const f = await fixture(),
    m = webhookMessage();
  await f.db
    .prepare(
      "CREATE TRIGGER removed_dead AFTER UPDATE OF state ON webhook_delivery_intents WHEN NEW.state='dead' BEGIN DELETE FROM webhook_delivery_intents WHERE subscription_id=NEW.subscription_id AND event_id=NEW.event_id; END",
    )
    .run();
  await assert.rejects(
    f.ledger.deadLetter(m, NOW),
    /dead-letter record was not committed/,
  );
  await f.db.prepare("DROP TRIGGER removed_dead").run();
  let competing = false;
  const ledger = webhookLedgerD1({
    prepare(sql: string) {
      if (sql.startsWith("UPDATE webhook_delivery_intents SET state='dead'"))
        competing = true;
      return f.db.prepare(sql);
    },
    async batch(statements) {
      if (competing) {
        competing = false;
        await f.ledger.deadLetter(m, NOW + 1);
        await f.ledger.authorizeReplay(m, "operator-replay", NOW + 2);
      }
      return f.db.batch(statements);
    },
  } as D1StoreBinding);
  assert.equal((await ledger.deadLetter(m, NOW)).state, "stale");
  assert.deepEqual(await f.ledger.outbox(NOW + 4), [{ ...m, generation: 1 }]);
});
