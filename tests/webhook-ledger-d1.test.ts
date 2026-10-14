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
      "claimed",
      "normal queue re-admission retains existing replay policy",
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
  assert.match(String(r.reason), /outcome-unknown: http-503/);
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
  assert.equal(r.state, "dead");
  assert.match(String(r.reason), /outcome-unknown/);
  assert.equal(
    (
      await f.db
        .prepare("SELECT outcome FROM webhook_delivery_attempts")
        .first()
    )?.outcome,
    "ambiguous",
  );
  assert.equal(
    (await f.ledger.claim(message, URL, 1, NOW + 60_002)).kind,
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
