// Unit tests for src/alert-delivery.mjs (#4984 Part 3). Pure/no-I/O, so
// every branch is directly testable without a network dependency.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ALERT_DELIVERY_MIN_INTERVAL_MS,
  buildDiscordDeliveryRequest,
  buildEmailDeliveryRequest,
  buildTelegramDeliveryRequest,
  buildWebhookDeliveryRequest,
  formatAlertMessage,
  isDeliveryRateLimited,
} from "../src/alert-delivery.ts";

function trigger(overrides = {}) {
  return {
    id: "1",
    name: null,
    channel: "webhook",
    destination: "https://example.com/hook",
    ...overrides,
  };
}

// --- isDeliveryRateLimited ----------------------------------------------------

test("isDeliveryRateLimited: never limited on the first delivery (no prior timestamp)", () => {
  assert.equal(isDeliveryRateLimited(null, 1_000_000), false);
  assert.equal(isDeliveryRateLimited(undefined, 1_000_000), false);
  assert.equal(isDeliveryRateLimited(0, 1_000_000), false);
});

test("isDeliveryRateLimited: limited within the window, clear once the window elapses", () => {
  const last = 1_000_000;
  assert.equal(isDeliveryRateLimited(last, last + 1), true);
  assert.equal(
    isDeliveryRateLimited(last, last + ALERT_DELIVERY_MIN_INTERVAL_MS - 1),
    true,
  );
  assert.equal(
    isDeliveryRateLimited(last, last + ALERT_DELIVERY_MIN_INTERVAL_MS),
    false,
  );
});

test("isDeliveryRateLimited: honors a custom minIntervalMs", () => {
  assert.equal(isDeliveryRateLimited(1000, 1500, 1000), true);
  assert.equal(isDeliveryRateLimited(1000, 2000, 1000), false);
});

test("ALERT_DELIVERY_MIN_INTERVAL_MS is the documented value (1 minute)", () => {
  assert.equal(ALERT_DELIVERY_MIN_INTERVAL_MS, 60 * 1000);
});

// --- formatAlertMessage -------------------------------------------------------

test("formatAlertMessage: includes only the fields the payload actually carries", () => {
  const message = formatAlertMessage(trigger(), {
    table: "account_events",
    event_kind: "Transfer",
    netuid: 7,
    amount_tao: 12.5,
    block_number: 8608870,
  });
  assert.match(message, /table=account_events/);
  assert.match(message, /event=Transfer/);
  assert.match(message, /netuid=7/);
  assert.match(message, /amount=12\.5 TAO/);
  assert.match(message, /block=8608870/);
});

test("formatAlertMessage: omits fields absent from the payload (e.g. blocks/extrinsics carry no netuid)", () => {
  const message = formatAlertMessage(trigger(), {
    table: "blocks",
    block_number: 1,
  });
  assert.doesNotMatch(message, /netuid/);
  assert.doesNotMatch(message, /event=/);
  assert.doesNotMatch(message, /amount=/);
});

test("formatAlertMessage: includes the trigger name when set, a generic phrase when not", () => {
  assert.match(
    formatAlertMessage(trigger({ name: "whale watcher" }), {}),
    /"whale watcher"/,
  );
  assert.doesNotMatch(formatAlertMessage(trigger({ name: null }), {}), /"/);
});

test("formatAlertMessage: netuid 0 and amount_tao 0 are included, not treated as absent", () => {
  const message = formatAlertMessage(trigger(), { netuid: 0, amount_tao: 0 });
  assert.match(message, /netuid=0/);
  assert.match(message, /amount=0 TAO/);
});

test("formatAlertMessage: tolerates a null/undefined payload", () => {
  assert.doesNotThrow(() => formatAlertMessage(trigger(), null));
  assert.doesNotThrow(() => formatAlertMessage(trigger(), undefined));
});

// --- buildWebhookDeliveryRequest -----------------------------------------------

test("buildWebhookDeliveryRequest: posts a metagraph.alert envelope to the trigger's own destination", () => {
  const payload = { table: "account_events", netuid: 7 };
  const request = buildWebhookDeliveryRequest(
    trigger({ id: "42", name: "my alert" }),
    payload,
    1_700_000_000_000,
  )!;
  assert.equal(request.url, "https://example.com/hook");
  assert.equal(request.init.method, "POST");
  const body = JSON.parse(request.init.body);
  assert.equal(body.type, "metagraph.alert");
  assert.equal(body.trigger_id, "42");
  assert.equal(body.trigger_name, "my alert");
  assert.equal(body.matched_at, 1_700_000_000_000);
  assert.deepEqual(body.event, payload);
});

test("buildWebhookDeliveryRequest: trigger_name is null when the trigger has no name", () => {
  const request = buildWebhookDeliveryRequest(trigger({ name: null }), {}, 0)!;
  assert.equal(JSON.parse(request.init.body).trigger_name, null);
});

test("buildWebhookDeliveryRequest: returns null (refuses to send) when the destination isn't a public https:// URL", () => {
  const request = buildWebhookDeliveryRequest(
    trigger({ destination: "http://example.com/hook" }),
    {},
    0,
  );
  assert.equal(request, null);
});

// --- buildDiscordDeliveryRequest -----------------------------------------------

test("buildDiscordDeliveryRequest: posts {content} to the trigger's own webhook URL", () => {
  const request = buildDiscordDeliveryRequest(
    trigger({ destination: "https://discord.com/api/webhooks/1/token" }),
    { table: "blocks" },
  )!;
  assert.equal(request.url, "https://discord.com/api/webhooks/1/token");
  const body = JSON.parse(request.init.body);
  assert.match(body.content, /table=blocks/);
});

test("buildDiscordDeliveryRequest: truncates content to Discord's 2000-char cap", () => {
  const request = buildDiscordDeliveryRequest(
    trigger({
      name: "x".repeat(3000),
      destination: "https://discord.com/api/webhooks/1/token",
    }),
    {},
  )!;
  const body = JSON.parse(request.init.body);
  assert.ok(body.content.length <= 2000);
});

test("buildDiscordDeliveryRequest: returns null (refuses to send) when the destination fails delivery-time re-validation", () => {
  const request = buildDiscordDeliveryRequest(
    trigger({ destination: "https://discord.com/invite/abc" }),
    {},
  );
  assert.equal(request, null);
});

// --- buildTelegramDeliveryRequest -----------------------------------------------

test("buildTelegramDeliveryRequest: posts to the bot's sendMessage endpoint with the trigger's chat id", () => {
  const request = buildTelegramDeliveryRequest(
    trigger({ destination: "123456789" }),
    { table: "chain_events" },
    "bot-token-abc",
  );
  assert.equal(
    request.url,
    "https://api.telegram.org/botbot-token-abc/sendMessage",
  );
  const body = JSON.parse(request.init.body);
  assert.equal(body.chat_id, "123456789");
  assert.match(body.text, /table=chain_events/);
});

// --- buildEmailDeliveryRequest ---------------------------------------------------

test("buildEmailDeliveryRequest: posts to Resend with the trigger's destination as the recipient", () => {
  const request = buildEmailDeliveryRequest(
    trigger({ destination: "a@b.com", name: "big transfers" }),
    { table: "account_events" },
    { resendKey: "resend-key", fromAddress: "alerts@metagraph.sh" },
  );
  assert.equal(request.url, "https://api.resend.com/emails");
  assert.equal(request.init.headers.authorization, "Bearer resend-key");
  const body = JSON.parse(request.init.body);
  assert.equal(body.from, "alerts@metagraph.sh");
  assert.equal(body.to, "a@b.com");
  assert.equal(body.subject, "Chain alert: big transfers");
});

test("buildEmailDeliveryRequest: uses a generic subject when the trigger has no name", () => {
  const request = buildEmailDeliveryRequest(
    trigger({ name: null }),
    {},
    { resendKey: "k", fromAddress: "alerts@metagraph.sh" },
  );
  assert.equal(JSON.parse(request.init.body).subject, "Chain alert");
});
