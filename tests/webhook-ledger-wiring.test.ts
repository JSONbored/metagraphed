import assert from "node:assert/strict";
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
      values.set(key, JSON.parse(value));
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
