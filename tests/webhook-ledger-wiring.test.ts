import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test, vi } from "vitest";
import {
  nativeWebhookFixture,
  webhookMessage,
} from "./helpers/webhook-ledger-fixture.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import worker, {
  handleRequest,
  handleWebhookQueue,
  dispatchWebhooksFromChangelog,
} from "../workers/api.ts";
import { handleMcpRequest } from "../src/mcp-server.ts";
import { webhookLedgerD1 } from "../src/webhook-ledger-d1.ts";
import type { Row } from "./row-type.ts";
import type { D1StoreBinding } from "../src/d1-store.ts";

const opened: Awaited<ReturnType<typeof nativeWebhookFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of opened.splice(0)) await f.runtime.dispose();
});
async function setup() {
  vi.useRealTimers();
  const f = await nativeWebhookFixture();
  opened.push(f);
  const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
  const subscription = {
    id,
    url: "https://hooks.example.com/event",
    secret: "private-subscription-secret",
    filters: {},
    created_at: new Date().toISOString(),
  };
  const values = new Map<string, unknown>([
    [`webhooks:sub:${id}`, subscription],
  ]);
  const kv = {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string) {
      try {
        values.set(key, JSON.parse(value));
      } catch {
        values.set(key, value);
      }
    },
    async list({ prefix }: { prefix: string }) {
      return {
        keys: [...values.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((name) => ({ name })),
      };
    },
  };
  const env = createLocalArtifactEnv({ D1_STATE: f.db, METAGRAPH_CONTROL: kv });
  return { ...f, id, values, kv, env };
}
async function consume(
  env: unknown,
  m: unknown,
  deliver: unknown,
  attempts = 1,
) {
  const actions: string[] = [];
  await handleWebhookQueue(
    {
      messages: [
        {
          body: m,
          attempts,
          ack: () => actions.push("ack"),
          retry: () => actions.push("retry"),
        },
      ],
    } as never,
    env as unknown as Env,
    {} as never,
    deliver as never,
  );
  return actions;
}
async function status(env: unknown, id: string) {
  return handleRequest(
    new Request(`https://metagraph.sh/api/v1/webhooks/subscriptions/${id}`),
    env as unknown as Env,
    {},
  );
}
async function mcpStatus(env: unknown, id: string) {
  const response = await handleMcpRequest(
    new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_webhook_subscription", arguments: { id } },
      }),
    }),
    env as unknown as Env,
  );
  return response.json() as Promise<Row>;
}

test("production consumer persists the exact attempt before HTTP, then native success precedes ack", async () => {
  const f = await setup(),
    m = webhookMessage(f.id);
  let effects = 0;
  const actions = await consume(f.env, m, async () => {
    const row = await f.db
      .prepare("SELECT outcome,target_url FROM webhook_delivery_attempts")
      .first();
    assert.equal(row?.outcome, "sending");
    assert.equal(row?.target_url, "https://hooks.example.com/event");
    effects++;
    return { status: "delivered", status_code: 200 };
  });
  assert.deepEqual(actions, ["ack"]);
  assert.equal(effects, 1);
  assert.deepEqual(
    await consume(
      f.env,
      m,
      async () => {
        effects++;
        return { status: "failed" };
      },
      2,
    ),
    ["ack"],
  );
  assert.equal(effects, 1);
  const response = await status(f.env, f.id);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.delivery.status, "ok");
  const rpc = await mcpStatus(f.env, f.id);
  assert.equal(rpc.result.structuredContent.delivery.status, "ok");
  assert.equal(
    JSON.stringify(rpc).includes("private-subscription-secret"),
    false,
  );
});

test("effect followed by failed commit retries, expired lease exposes ambiguity and same identity remains replayable", async () => {
  const f = await setup(),
    m = webhookMessage(f.id);
  let failed = false,
    effects = 0;
  const db = {
    prepare: f.db.prepare.bind(f.db),
    async batch(s: Parameters<D1StoreBinding["batch"]>[0]) {
      if (failed) throw new Error("outcome write refused");
      return f.db.batch(s);
    },
  } as D1StoreBinding;
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  assert.deepEqual(
    await consume({ ...f.env, D1_STATE: db }, m, async () => {
      effects++;
      failed = true;
      return { status: "delivered" };
    }),
    ["retry"],
  );
  vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
  const response = await status(f.env, f.id);
  const delivery = (await response.json()).data.delivery;
  assert.equal(delivery.status, "retrying");
  assert.equal(delivery.last_failure.state, "ambiguous");
  assert.match(delivery.last_failure.reason, /outcome-unknown/);
  failed = false;
  assert.deepEqual(
    await consume(
      f.env,
      m,
      async () => {
        effects++;
        return { status: "delivered" };
      },
      2,
    ),
    ["ack"],
  );
  assert.equal(effects, 2, "at-least-once retry is preserved");
  const rows = await f.db
    .prepare("SELECT outcome FROM webhook_delivery_attempts ORDER BY sequence")
    .all();
  assert.deepEqual(
    rows.results.map((r) => r.outcome),
    ["ambiguous", "delivered"],
  );
});

test("missing/refused native owner never sends and native status failure is explicit on REST and MCP", async () => {
  const f = await setup(),
    m = webhookMessage(f.id);
  let effects = 0;
  const deliver = async () => {
    effects++;
    return { status: "delivered" };
  };
  assert.deepEqual(
    await consume({ ...f.env, D1_STATE: undefined }, m, deliver),
    ["retry"],
  );
  await f.db.prepare("DROP TABLE webhook_delivery_attempts").run();
  assert.deepEqual(await consume(f.env, m, deliver), ["retry"]);
  assert.equal(effects, 0);
  const response = await status(f.env, f.id);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "webhooks_unavailable");
  const rpc = await mcpStatus(f.env, f.id);
  assert.equal(rpc.result.isError, true);
  assert.equal(rpc.result.structuredContent.error.code, "webhooks_unavailable");
});

test("content mutation is refused, removed subscriptions stop sends, and native attempt uses the current target", async () => {
  const f = await setup(),
    m = webhookMessage(f.id);
  let effects = 0;
  const deliver = async () => {
    effects++;
    return { status: "delivered" };
  };
  assert.deepEqual(
    await consume(f.env, { ...m, event_id: "f".repeat(32) }, deliver),
    ["ack"],
  );
  assert.equal(effects, 0);
  f.values.set(`webhooks:sub:${f.id}`, {
    id: f.id,
    url: "https://hooks.example.com/repointed",
    secret: "changed",
    filters: {},
  });
  await consume(f.env, m, deliver);
  assert.equal(
    (
      await f.db
        .prepare("SELECT target_url FROM webhook_delivery_attempts")
        .first()
    )?.target_url,
    "https://hooks.example.com/repointed",
  );
  f.values.delete(`webhooks:sub:${f.id}`);
  await consume(f.env, webhookMessage(f.id, { type: "next" }), deliver);
  assert.equal(effects, 1);
});

test("DLQ preserves known success, records never-sent failures, and defers an active lease", async () => {
  const f = await setup(),
    m = webhookMessage(f.id),
    actions: string[] = [];
  const now = Date.now();
  const c = await f.ledger.claim(m, "https://hooks.example.com/event", 1, now);
  assert(c.kind === "claimed");
  await f.ledger.finish(
    c.attempt,
    { status: "delivered" },
    "delivered",
    now + 1,
    null,
  );
  const other = webhookMessage(f.id, { type: "never-sent" }),
    live = webhookMessage(f.id, { type: "sending" });
  await f.ledger.claim(live, "https://hooks.example.com/event", 1, now);
  await worker.queue!(
    {
      queue: "webhook-deliveries-dlq",
      messages: [m, other, live].map((body) => ({
        body,
        attempts: 8,
        ack: () => actions.push("ack"),
        retry: () => actions.push("retry"),
      })),
    } as never,
    f.env as unknown as Env,
    {} as never,
  );
  assert.deepEqual(actions, ["ack", "ack", "retry"]);
  const records = await f.ledger.recent(f.id, now + 2);
  assert.equal(
    records.find((r) => r.event_id === m.event_id)?.state,
    "delivered",
  );
  assert.equal(
    records.find((r) => r.event_id === other.event_id)?.state,
    "dead",
  );
});

test("existing dispatcher recovers a failed initial enqueue from durable original bytes", async () => {
  const f = await setup(),
    m = webhookMessage(f.id);
  const now = Date.now();
  await f.ledger.ensure(m, now);
  const sent: unknown[] = [];
  const env = {
    ...f.env,
    WEBHOOK_DELIVERIES: {
      async send(body: unknown) {
        sent.push(body);
      },
    },
  };
  await dispatchWebhooksFromChangelog(env as unknown as Env, async () => ({
    type: "metagraph.publish",
    changes: {},
  }));
  assert.deepEqual(sent, [m]);
  assert.deepEqual(await f.ledger.outbox(now + 1), []);
  await dispatchWebhooksFromChangelog(env as unknown as Env, async () => ({
    type: "metagraph.publish",
    changes: {},
  }));
  assert.equal(sent.length, 1);
});

test("consumer prefers native success despite failed KV outcome projection", async () => {
  const f = await setup(),
    m = webhookMessage(f.id);
  let effects = 0;
  const env = {
    ...f.env,
    METAGRAPH_CONTROL: {
      ...f.kv,
      async put() {
        throw new Error("legacy projection failed");
      },
    },
  };
  const deliver = async () => {
    effects++;
    return { status: "delivered" };
  };
  assert.deepEqual(await consume(env, m, deliver), ["ack"]);
  assert.deepEqual(await consume(env, m, deliver, 2), ["ack"]);
  assert.equal(effects, 1);
});

test("committed native success with a lost reply does not repeat HTTP", async () => {
  const f = await setup(),
    m = webhookMessage(f.id);
  let effect = false,
    effects = 0;
  const db = {
    prepare: f.db.prepare.bind(f.db),
    async batch(s: Parameters<D1StoreBinding["batch"]>[0]) {
      const r = await f.db.batch(s);
      if (effect) throw new Error("lost reply");
      return r;
    },
  } as D1StoreBinding;
  assert.deepEqual(
    await consume({ ...f.env, D1_STATE: db }, m, async () => {
      effects++;
      effect = true;
      return { status: "delivered" };
    }),
    ["retry"],
  );
  assert.equal(
    (await webhookLedgerD1(f.db).recent(f.id, Date.now()))[0].state,
    "delivered",
  );
  assert.deepEqual(
    await consume(
      f.env,
      m,
      async () => {
        effects++;
        return { status: "delivered" };
      },
      2,
    ),
    ["ack"],
  );
  assert.equal(effects, 1);
});

test("recovery and unchanged-checkpoint duplicates retain terminal rejection and scheduled backoff", async () => {
  for (const statusCode of [400, 500]) {
    const f = await setup();
    const event = { type: "metagraph.publish", changes: { subnets: [7] } };
    const sent: unknown[] = [];
    let unavailable = true;
    const env = {
      ...f.env,
      WEBHOOK_DELIVERIES: {
        async send(body: unknown) {
          if (unavailable) throw new Error("queue down");
          sent.push(body);
        },
      },
    };
    await assert.rejects(
      dispatchWebhooksFromChangelog(env as unknown as Env, async () => event),
    );
    unavailable = false;
    await dispatchWebhooksFromChangelog(
      env as unknown as Env,
      async () => event,
    );
    assert.equal(
      sent.length,
      2,
      "recovery and checkpoint retry share original bytes",
    );
    let effects = 0;
    const deliver = async () => {
      effects++;
      return {
        status: "failed",
        status_code: statusCode,
        reason: `http-${statusCode}`,
        retryable: statusCode === 500,
      };
    };
    assert.deepEqual(await consume(env, sent[0], deliver), [
      statusCode === 400 ? "ack" : "retry",
    ]);
    assert.deepEqual(await consume(env, sent[1], deliver), ["ack"]);
    if (statusCode === 500)
      assert.deepEqual(await consume(env, sent[0], deliver, 2), ["retry"]);
    assert.equal(
      effects,
      1,
      "neither terminal reopening nor early backoff bypass sends HTTP",
    );
  }
});

test("queue failure preserves the entire recipient set beyond the concurrency window", async () => {
  const f = await setup();
  for (let n = 1; n < 9; n++)
    f.values.set(`webhooks:sub:subscriber-${n}`, {
      id: `subscriber-${n}`,
      url: "https://hooks.example.com/event",
      filters: {},
    });
  const event = { type: "metagraph.publish", changes: { subnets: [9] } };
  const env = {
    ...f.env,
    WEBHOOK_DELIVERIES: {
      async send() {
        throw new Error("queue down");
      },
    },
  };
  await assert.rejects(
    dispatchWebhooksFromChangelog(env as unknown as Env, async () => event),
  );
  const rows = await f.db
    .prepare("SELECT subscription_id FROM webhook_delivery_intents")
    .all();
  assert.equal(
    rows.results.length,
    9,
    "all nine obligations exist before queue sends can fail",
  );
});

test("Unicode envelope poison is durably terminal and does not block new events", async () => {
  const f = await setup();
  const poison = webhookMessage(f.id, {
    type: "metagraph.publish",
    padding: "é".repeat(65500),
  });
  assert(new TextEncoder().encode(poison.body).byteLength <= 131072);
  assert(new TextEncoder().encode(JSON.stringify(poison)).byteLength > 131072);
  await f.ledger.ensure(poison, Date.now());
  const sent: unknown[] = [];
  const env = {
    ...f.env,
    WEBHOOK_DELIVERIES: {
      async send(body: unknown) {
        sent.push(body);
      },
    },
  };
  await dispatchWebhooksFromChangelog(env as unknown as Env, async () => ({
    type: "metagraph.publish",
    changes: { subnets: [10] },
  }));
  assert.equal(sent.length, 1);
  const records = await f.ledger.recent(f.id, Date.now());
  assert.equal(
    records.find((r) => r.event_id === poison.event_id)?.state,
    "dead",
  );
  assert.equal(
    records.find((r) => r.event_id === poison.event_id)?.reason,
    "queue-envelope-oversize",
  );
  assert.deepEqual(await f.ledger.outbox(Date.now()), []);
});

test("native ownership reconciles stale KV beyond256 recent events on REST and MCP", async () => {
  const f = await setup();
  const m = webhookMessage(f.id, { old: true });
  const now = Date.now() - 10000;
  const claim = await f.ledger.claim(
    m,
    "https://hooks.example.com/event",
    1,
    now,
  );
  assert(claim.kind === "claimed");
  await f.ledger.finish(
    claim.attempt,
    { status: "delivered" },
    "delivered",
    now + 1,
    null,
  );
  // Keys mirror the canonical deliveryStorageKey used by the consumer.
  const { deliveryStorageKey } = await import("../src/webhooks.ts");
  f.values.set(deliveryStorageKey(f.id, m.event_id), {
    subscription_id: f.id,
    event_id: m.event_id,
    state: "dead",
    round: 1,
    last_attempt_at: new Date(now).toISOString(),
  });
  for (let n = 0; n < 257; n++) {
    const newer = webhookMessage(f.id, { n });
    await f.ledger.ensure(newer, now + 2 + n);
  }
  const rest = (await (await status(f.env, f.id)).json()) as Row;
  assert.equal(rest.data.delivery.dead_letter, 0);
  const rpc = await mcpStatus(f.env, f.id);
  assert.equal(rpc.result.structuredContent.delivery.dead_letter, 0);
});

test("unresolved receiver effects survive later no-request failure and null stamps do not hide real failures", async () => {
  const f = await setup(),
    m = webhookMessage(f.id, { event: "effect" });
  const now = Date.now() - 70000;
  const first = await f.ledger.claim(
    m,
    "https://hooks.example.com/event",
    1,
    now,
  );
  assert(first.kind === "claimed");
  const second = await f.ledger.claim(
    m,
    "https://hooks.example.com/event",
    2,
    now + 60001,
  );
  assert(second.kind === "claimed");
  await f.ledger.finish(
    second.attempt,
    { status: "skipped", reason: "unsafe-url" },
    "dead",
    now + 60002,
    null,
  );
  await f.ledger.ensure(
    webhookMessage(f.id, { new: "never attempted" }),
    Date.now(),
  );
  const rest = (await (await status(f.env, f.id)).json()) as Row;
  assert.equal(rest.data.delivery.last_failure.event_id, m.event_id);
  assert.match(rest.data.delivery.last_failure.reason, /outcome-unknown/);
  const rpc = await mcpStatus(f.env, f.id);
  assert.match(
    rpc.result.structuredContent.delivery.last_failure.reason,
    /outcome-unknown/,
  );
  await f.ledger.finish(
    first.attempt,
    { status: "delivered" },
    "delivered",
    Date.now(),
    null,
  );
  assert.equal(
    (await f.ledger.recent(f.id, Date.now())).find(
      (r) => r.event_id === m.event_id,
    )?.state,
    "delivered",
  );
});

test("declared DLQ retry policy survives a first native finalization outage without recursive loops", async () => {
  const configuration = readFileSync(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8",
  );
  const block = configuration.match(
    /\{\s*"queue": "webhook-deliveries-dlq",[\s\S]*?\}/,
  )?.[0];
  assert(block);
  const retries = Number(block.match(/"max_retries": (\d+)/)?.[1]);
  const delay = Number(block.match(/"retry_delay": (\d+)/)?.[1]);
  assert(retries > 0 && retries <= 8);
  assert(delay >= 60);
  assert(!block.includes("dead_letter_queue"));
  const f = await setup(),
    m = webhookMessage(f.id);
  await f.ledger.ensure(m, Date.now());
  await f.ledger.enqueued(m.subscription_id, m.event_id, Date.now());
  let acked = false;
  const batch = {
    queue: "webhook-deliveries-dlq",
    messages: [
      {
        body: m,
        attempts: 1,
        ack: () => {
          acked = true;
        },
        retry: () => {},
      },
    ],
  };
  const unavailable = {
    ...f.env,
    D1_STATE: {
      prepare() {
        throw new Error("temporary D1 outage");
      },
      batch: f.db.batch.bind(f.db),
    },
  };
  await assert.rejects(
    worker.queue!(batch as never, unavailable as unknown as Env, {} as never),
  );
  assert(!acked);
  // Official queue semantics retry a failed first delivery while max_retries>0.
  // The actual production configuration above supplies that budget.
  await worker.queue!(batch as never, f.env as unknown as Env, {} as never);
  assert(acked);
  assert.equal(
    (await f.ledger.recent(f.id, Date.now()))[0].state,
    "pending",
    "transport exhaustion preserves queued logical ownership",
  );
  const recovered = Date.now() + 33 * 86400000;
  await f.ledger.recoverExpired(recovered);
  assert.equal((await f.ledger.recent(f.id, recovered))[0].state, "dead");
});

test("committed admission with lost verification still preserves all seven recipients after changelog advances", async () => {
  const f = await setup();
  for (let n = 1; n < 7; n++)
    f.values.set(`webhooks:sub:subscriber-${n}`, {
      id: `subscriber-${n}`,
      url: "https://hooks.example.com/event",
      filters: {},
    });
  let loseReply = true;
  const db = {
    batch: f.db.batch.bind(f.db),
    prepare(sql: string) {
      const statement = f.db.prepare(sql);
      if (sql.startsWith("SELECT payload_sha256,body")) {
        const bind = statement.bind.bind(statement);
        return {
          ...statement,
          bind(...args: unknown[]) {
            const bound = bind(...args);
            return {
              ...bound,
              async first() {
                if (loseReply)
                  throw new Error("committed admission; readback unavailable");
                return bound.first();
              },
            };
          },
        };
      }
      return statement;
    },
  } as unknown as D1StoreBinding;
  const sent: Row[] = [];
  const env = {
    ...f.env,
    D1_STATE: db,
    WEBHOOK_DELIVERIES: {
      async send(message: Row) {
        sent.push(message);
      },
    },
  };
  const eventA = { type: "metagraph.publish", changes: { subnets: [17] } },
    eventB = { type: "metagraph.publish", changes: { subnets: [18] } };
  await assert.rejects(
    dispatchWebhooksFromChangelog(env as unknown as Env, async () => eventA),
  );
  const id = webhookMessage(f.id, eventA).event_id;
  const admitted = await f.db
    .prepare(
      "SELECT subscription_id FROM webhook_delivery_intents WHERE event_id=?",
    )
    .bind(id)
    .all();
  assert.equal(
    admitted.results.length,
    7,
    "atomic admission has no unvisited seventh recipient",
  );
  assert.equal(sent.length, 0);
  loseReply = false;
  await dispatchWebhooksFromChangelog(
    env as unknown as Env,
    async () => eventB,
  );
  await dispatchWebhooksFromChangelog(
    env as unknown as Env,
    async () => eventB,
  );
  assert.equal(
    new Set(sent.filter((m) => m.event_id === id).map((m) => m.subscription_id))
      .size,
    7,
    "every original obligation survives a replaced changelog",
  );
});

test("exhausted duplicate transport cannot terminate another copy's pending logical retry", async () => {
  const f = await setup(),
    m = webhookMessage(f.id);
  const start = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(start);
  let effects = 0;
  const fail = async () => {
    effects++;
    return {
      status: "failed",
      status_code: 503,
      reason: "http-503",
      retryable: true,
    };
  };
  assert.deepEqual(await consume(f.env, m, fail), ["retry"]);
  const failedRead = {
    ...f.env,
    METAGRAPH_CONTROL: {
      ...f.kv,
      async get(key: string) {
        if (key.startsWith("webhooks:sub:"))
          throw new Error("transient subscription read");
        return f.kv.get(key);
      },
    },
  };
  for (let attempts = 1; attempts <= 8; attempts++)
    assert.deepEqual(await consume(failedRead, m, fail, attempts), ["retry"]);
  let acked = false;
  await worker.queue!(
    {
      queue: "webhook-deliveries-dlq",
      messages: [
        {
          body: m,
          attempts: 1,
          ack() {
            acked = true;
          },
          retry() {
            throw new Error("must not spin DLQ");
          },
        },
      ],
    } as never,
    f.env as unknown as Env,
    {} as never,
  );
  assert(acked);
  assert.equal((await f.ledger.recent(f.id, start))[0].state, "pending");
  clock.mockReturnValue(start + 300001);
  assert.deepEqual(
    await consume(
      f.env,
      m,
      async () => {
        effects++;
        return { status: "delivered" };
      },
      2,
    ),
    ["ack"],
  );
  assert.equal(effects, 2);
  assert.equal((await f.ledger.recent(f.id, Date.now()))[0].state, "delivered");
});
