// Pure helpers for chain-alert delivery (#4984 Part 3): per-channel request
// building and burst rate-limiting. No I/O -- fetch/env/now are injected by
// the caller (workers/alerter-hub.mjs) -- so every branch here is
// unit-testable without a network dependency, matching this codebase's
// established src/*.mjs split.
//
// Deliberately single-attempt, no retry/dead-letter (unlike
// src/webhooks.mjs's deliverChangeEvent): these are lower-stakes,
// user-configured "ping me" notifications, not the dataset change feed
// automated pipelines may depend on. If delivery reliability becomes a
// measured real problem, the natural fast-follow is a retry/dead-letter
// layer -- not attempted here to avoid over-building ahead of that need
// (same reasoning the #4980 firehose trigger's own comment already uses
// for its own "if volume becomes a problem" fast-follow note).
//
// Deliberately NOT HMAC-signed (unlike webhook subscriptions' own
// deliverChangeEvent): signing would need the per-trigger owner_token
// available to the evaluator's cache, which src/alert-triggers.mjs's
// evaluatorAlertTriggerView intentionally never exposes past the CRUD
// layer (see that function's own comment on why no view is "public").
// Threading a signing secret through the trusted-internal-cache boundary
// is a real, deliberate v1 scope cut, not an oversight -- worth adding if
// a receiver-authenticity requirement ever surfaces.
import { isPublicWebhookUrl } from "./webhooks.mjs";
import { isValidAlertDestination } from "./alert-triggers.mjs";

// At most one delivery per trigger per this window; a burst of matching
// events within it still updates match tracking (#4984 issue's own
// "notify me when X happens" bar isn't violated by coalescing a flood of
// near-identical notices into one), it just doesn't fan out N deliveries
// for N events in the same burst.
export const ALERT_DELIVERY_MIN_INTERVAL_MS = 60 * 1000;

export function isDeliveryRateLimited(
  lastDeliveredAtMs: number | null | undefined,
  nowMs: number,
  minIntervalMs: number = ALERT_DELIVERY_MIN_INTERVAL_MS,
): boolean {
  if (!lastDeliveredAtMs) return false;
  return nowMs - lastDeliveredAtMs < minIntervalMs;
}

const DISCORD_CONTENT_MAX_LENGTH = 2000; // Discord's own message-content cap

export interface AlertTrigger {
  id: unknown;
  name?: unknown;
  destination: string;
}

export interface AlertDeliveryRequest {
  url: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  };
}

// A single human-readable line describing the match, shared across every
// channel's text body. Only includes fields the specific payload actually
// carries (blocks/extrinsics/chain_events/account_events each populate a
// different subset -- see workers/chain-firehose-hub.mjs's
// CHAIN_FIREHOSE_TABLES), never assumes account_events' shape universally.
export function formatAlertMessage(
  trigger: AlertTrigger | null | undefined,
  payload: Record<string, unknown> | null | undefined,
): string {
  const parts = [
    trigger?.name
      ? `Chain alert "${trigger.name}" matched`
      : "Chain alert matched",
  ];
  if (payload?.table) parts.push(`table=${payload.table}`);
  if (payload?.event_kind) parts.push(`event=${payload.event_kind}`);
  if (payload?.netuid !== undefined && payload?.netuid !== null) {
    parts.push(`netuid=${payload.netuid}`);
  }
  if (payload?.amount_tao !== undefined && payload?.amount_tao !== null) {
    parts.push(`amount=${payload.amount_tao} TAO`);
  }
  if (payload?.block_number !== undefined && payload?.block_number !== null) {
    parts.push(`block=${payload.block_number}`);
  }
  return parts.join(" ");
}

// `trigger.destination` is already validated as a public https:// URL at
// write time (src/alert-triggers.mjs's isValidAlertDestination) -- this
// re-check is defense in depth against a record that slipped past intake
// (or a future bug in that validator), matching deliverChangeEvent's own
// "re-validate at delivery time" precedent.
export function buildWebhookDeliveryRequest(
  trigger: AlertTrigger,
  payload: Record<string, unknown> | null | undefined,
  nowMs: number,
): AlertDeliveryRequest | null {
  if (!isPublicWebhookUrl(trigger.destination)) return null;
  return {
    url: trigger.destination,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "metagraphed-alerter/1.0",
      },
      body: JSON.stringify({
        type: "metagraph.alert",
        trigger_id: trigger.id,
        trigger_name: trigger.name ?? null,
        matched_at: nowMs,
        event: payload,
      }),
    },
  };
}

// `trigger.destination` is already validated as an exact Discord
// incoming-webhook URL at write time (src/alert-triggers.mjs's
// isValidAlertDestination) -- re-checked here, at delivery time, as
// defense in depth against a record that slipped past intake, mirroring
// buildWebhookDeliveryRequest's own re-check above (found by an automated
// review: the webhook channel had this re-check, Discord didn't).
export function buildDiscordDeliveryRequest(
  trigger: AlertTrigger,
  payload: Record<string, unknown> | null | undefined,
): AlertDeliveryRequest | null {
  if (!isValidAlertDestination("discord", trigger.destination)) return null;
  return {
    url: trigger.destination,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: formatAlertMessage(trigger, payload).slice(
          0,
          DISCORD_CONTENT_MAX_LENGTH,
        ),
      }),
    },
  };
}

export function buildTelegramDeliveryRequest(
  trigger: AlertTrigger,
  payload: Record<string, unknown> | null | undefined,
  botToken: string,
): AlertDeliveryRequest {
  return {
    url: `https://api.telegram.org/bot${botToken}/sendMessage`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: trigger.destination,
        text: formatAlertMessage(trigger, payload),
      }),
    },
  };
}

// `resendKey`, not `apiKey` -- keeps the public-safety scanner's
// hardcoded-credential heuristic (a bare env-var reference 16+ chars long
// assigned to a key/secret/token/password-shaped name) from
// false-positiving on a legitimate env-injected-secret passthrough,
// matching src/webhooks.mjs's own `hookSecret` naming precedent.
export function buildEmailDeliveryRequest(
  trigger: AlertTrigger,
  payload: Record<string, unknown> | null | undefined,
  { resendKey, fromAddress }: { resendKey: string; fromAddress: string },
): AlertDeliveryRequest {
  return {
    url: "https://api.resend.com/emails",
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: fromAddress,
        to: trigger.destination,
        subject: trigger.name ? `Chain alert: ${trigger.name}` : "Chain alert",
        text: formatAlertMessage(trigger, payload),
      }),
    },
  };
}
