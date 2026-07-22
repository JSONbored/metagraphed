// Pure, isomorphic helpers for chain alert triggers (#4984 Part 1, ADR 0015 /
// #2114). Shared by workers/data-api.mjs (the Postgres CRUD write path) and
// the future AlerterHub Durable Object (#4984 Part 2, which evaluates each
// live ChainFirehoseHub broadcast against every active trigger). No I/O --
// Postgres/fetch are injected by callers -- so every branch here is
// unit-testable without a live database or network, matching src/webhooks.mjs's
// own split (this module reuses that file's SSRF guard + constant-time
// compare + secret generation rather than re-deriving them).
//
// A trigger's matchable conditions (netuid/event_kind/account/min_amount_tao)
// are deliberately drawn from account_events' own columns, not chain_events'
// raw pallet/method/args -- see the #4984-prerequisite commit that taught
// notify_chain_firehose() to also tee account_events (workers/chain-
// firehose-hub.mjs's CHAIN_FIREHOSE_TABLES) for why: it is the only firehose
// table that carries netuid/hotkey/coldkey/amount_tao directly, so a trigger
// can be evaluated inline off the NOTIFY payload with no per-event Postgres
// round-trip.
import {
  generateSecret,
  isPublicWebhookUrl,
  timingSafeEqual,
} from "./webhooks.mjs";
import { CHAIN_FIREHOSE_TABLES } from "../workers/chain-firehose-hub.ts";

// Anti-abuse gate on trigger CREATION (public but shared-secret-gated,
// mirroring METAGRAPH_WEBHOOK_SUBSCRIPTION_TOKEN's exact role) -- every
// active trigger costs the evaluator a real per-event match check, so
// unbounded public creation is a workload-inflation vector, not just a
// storage one.
export const ALERT_TRIGGER_CREATE_TOKEN_HEADER = "x-alert-trigger-create-token";
// Per-trigger bearer credential for GET/PATCH/DELETE on that one trigger.
export const ALERT_TRIGGER_OWNER_TOKEN_HEADER = "x-alert-trigger-owner-token";
// Machine-only: gates the evaluator's "give me every active trigger" scan
// (#4984 Part 2), a DIFFERENT secret from the two above since it grants a
// wholly different capability (read every trigger regardless of owner).
export const ALERT_TRIGGERS_INTERNAL_TOKEN_HEADER =
  "x-alert-triggers-internal-token";

// Matches MAX_WEBHOOK_BODY_BYTES (workers/config.mjs) -- generous over this
// shape's actual size (a handful of short scalar fields) without inviting a
// pathological body.
export const ALERT_TRIGGER_MAX_BODY_BYTES = 8192;

export const ALERT_CHANNELS = new Set([
  "webhook",
  "email",
  "telegram",
  "discord",
]);

const MAX_NAME_LENGTH = 128;
const MAX_ACCOUNT_LENGTH = 64; // generous over an SS58 address
const MAX_EVENT_KIND_LENGTH = 64;
const MAX_DESTINATION_LENGTH = 512;
// Generous ceiling defending against a garbage/overflow float rather than a
// realistic TAO amount bound.
const MIN_AMOUNT_TAO_CEILING = 1_000_000_000;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254; // RFC 5321 §4.5.3.1.3

// #6746: a trigger's `condition` matches a COMPUTED/derived metric against a
// threshold, rather than a raw event field -- the extension SubnetAIQ's
// deregistration-risk monitor pioneers (stripped of its trading framing).
// Both metrics below are scoped by the SAME payload fields fixed-field
// matching already reads (netuid, hotkey) -- a condition does not carry its
// own separate scope, it narrows whichever event already matched. See
// src/dereg-risk.ts for how each metric is actually computed into the
// snapshot triggerMatchesEvent reads from below.
export const ALERT_CONDITION_METRICS = new Set([
  // This subnet's rank by alpha_price_tao among all subnets (1 = highest
  // price) -- keyed by payload.netuid.
  "subnet_alpha_price_rank",
  // Blocks remaining until payload.netuid + payload.hotkey's immunity period
  // expires -- null (never matches) when that neuron isn't currently in its
  // immunity window. Keyed by `${netuid}:${hotkey}`.
  "neuron_immunity_countdown_blocks",
]);

export const ALERT_CONDITION_OPERATORS = new Set([
  "lt",
  "lte",
  "gt",
  "gte",
  "eq",
]);

function compareAlertCondition(
  value: number,
  operator: string,
  threshold: number,
): boolean {
  switch (operator) {
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "eq":
      return value === threshold;
    /* v8 ignore next 2 -- unreachable: operator is already validated against
       ALERT_CONDITION_OPERATORS before a trigger can carry it. */
    default:
      return false;
  }
}

export interface AlertConditionInput {
  metric: string;
  operator: string;
  threshold: number;
}

interface ValidationOk<T> {
  ok: true;
  value: T;
}
interface ValidationError {
  ok: false;
  error: string;
}
type ValidationResult<T> = ValidationOk<T> | ValidationError;

// Validates the optional `condition` sub-object of a create/update body.
// `undefined` (the field wasn't provided) is valid and yields `null` --
// distinct from a present-but-malformed condition, which is rejected.
function validateAlertCondition(
  input: unknown,
): ValidationResult<AlertConditionInput | null> {
  if (input === undefined) return { ok: true, value: null };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      error: "`condition`, when provided, must be an object.",
    };
  }
  const obj = input as Record<string, unknown>;
  if (!ALERT_CONDITION_METRICS.has(obj.metric as string)) {
    return {
      ok: false,
      error: `\`condition.metric\` must be one of: ${[...ALERT_CONDITION_METRICS].join(", ")}.`,
    };
  }
  if (!ALERT_CONDITION_OPERATORS.has(obj.operator as string)) {
    return {
      ok: false,
      error: `\`condition.operator\` must be one of: ${[...ALERT_CONDITION_OPERATORS].join(", ")}.`,
    };
  }
  if (typeof obj.threshold !== "number" || !Number.isFinite(obj.threshold)) {
    return {
      ok: false,
      error: "`condition.threshold` must be a finite number.",
    };
  }
  return {
    ok: true,
    value: {
      metric: obj.metric as string,
      operator: obj.operator as string,
      threshold: obj.threshold,
    },
  };
}

interface AlertMetricSnapshot {
  subnetAlphaPriceRank?: Map<unknown, unknown>;
  neuronImmunityCountdownBlocks?: Map<unknown, unknown>;
}

// Reads the current value of one condition's metric for the event payload
// that already matched every fixed-field check -- `null` when the snapshot
// has no entry for this netuid/hotkey (metric genuinely inapplicable right
// now, e.g. a neuron outside its immunity window), which triggerMatchesEvent
// treats as "does not match", never as a thrown error.
function readConditionMetric(
  metric: string,
  payload: Record<string, unknown> | null | undefined,
  metricSnapshot: AlertMetricSnapshot | null | undefined,
): number | null {
  if (metric === "subnet_alpha_price_rank") {
    const rank = metricSnapshot?.subnetAlphaPriceRank?.get(payload?.netuid);
    return typeof rank === "number" ? rank : null;
  }
  // metric === "neuron_immunity_countdown_blocks" -- the only other value
  // ALERT_CONDITION_METRICS permits a trigger to carry (validated at
  // creation/update time), so no further branch/default is reachable here.
  const key = `${payload?.netuid}:${payload?.hotkey}`;
  const countdown = metricSnapshot?.neuronImmunityCountdownBlocks?.get(key);
  return typeof countdown === "number" ? countdown : null;
}

// Telegram chat ids are either a signed integer (private chat / group) or an
// `@channelusername` (public channel/supergroup) -- see the Bot API's
// sendMessage `chat_id` parameter.
const TELEGRAM_CHAT_ID_PATTERN = /^(-?\d{1,15}|@[A-Za-z0-9_]{5,32})$/;

// Discord incoming-webhook URLs have one fixed, well-known shape. Allowlisting
// the exact host + path shape (matching this repo's own icon-proxy
// aggregator-only precedent, workers/icon-proxy.ts) is safer than a generic
// "is this URL public" SSRF check: alertmanager-discord-style relays exist
// specifically because Discord's OWN webhook endpoint is the only fetch
// target this channel ever needs, so there is no legitimate reason to accept
// anything else.
const DISCORD_WEBHOOK_PATTERN =
  /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

export function isValidAlertDestination(
  channel: unknown,
  destination: unknown,
): boolean {
  if (typeof destination !== "string" || destination.length === 0) return false;
  if (destination.length > MAX_DESTINATION_LENGTH) return false;
  switch (channel) {
    case "webhook":
      return isPublicWebhookUrl(destination);
    case "discord":
      return DISCORD_WEBHOOK_PATTERN.test(destination);
    case "email":
      return (
        destination.length <= MAX_EMAIL_LENGTH &&
        EMAIL_PATTERN.test(destination)
      );
    case "telegram":
      return TELEGRAM_CHAT_ID_PATTERN.test(destination);
    default:
      return false;
  }
}

export interface AlertTriggerValidated {
  name: string | null;
  tableFilter: string[] | null;
  netuid: number | null;
  eventKind: string | null;
  account: string | null;
  minAmountTao: number | null;
  condition: AlertConditionInput | null;
  channel: string;
  destination: string;
}

// Validates a create/update request body into the exact shape the Postgres
// write path binds. Every condition field is optional on input (undefined),
// but at least one of netuid/event_kind/account/min_amount_tao is required --
// a trigger with none of them would match every event on every table, which
// is always technically legal per-field but almost certainly a mistake (and
// an unbounded-delivery-volume footgun for the trigger's own owner).
export function validateAlertTriggerInput(
  input: unknown,
): ValidationResult<AlertTriggerValidated> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  const body = input as Record<string, unknown>;
  if (!ALERT_CHANNELS.has(body.channel as string)) {
    return {
      ok: false,
      error: `\`channel\` must be one of ${[...ALERT_CHANNELS].join(", ")}.`,
    };
  }
  if (!isValidAlertDestination(body.channel, body.destination)) {
    return {
      ok: false,
      error: `\`destination\` is not a valid ${String(body.channel)} target.`,
    };
  }

  let name: string | null = null;
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.length > MAX_NAME_LENGTH) {
      return {
        ok: false,
        error: `\`name\`, when provided, must be a string up to ${MAX_NAME_LENGTH} characters.`,
      };
    }
    name = body.name;
  }

  let tableFilter: string[] | null = null;
  if (body.table_filter !== undefined) {
    if (
      !Array.isArray(body.table_filter) ||
      body.table_filter.length === 0 ||
      !body.table_filter.every((table) => CHAIN_FIREHOSE_TABLES.has(table))
    ) {
      return {
        ok: false,
        error: `\`table_filter\`, when provided, must be a non-empty array drawn from ${[...CHAIN_FIREHOSE_TABLES].join(", ")}.`,
      };
    }
    tableFilter = [...new Set(body.table_filter)];
  }

  let netuid: number | null = null;
  if (body.netuid !== undefined) {
    if (
      !Number.isInteger(body.netuid) ||
      (body.netuid as number) < 0 ||
      (body.netuid as number) > 65535
    ) {
      return {
        ok: false,
        error: "`netuid`, when provided, must be an integer 0-65535.",
      };
    }
    netuid = body.netuid as number;
  }

  let eventKind: string | null = null;
  if (body.event_kind !== undefined) {
    if (
      typeof body.event_kind !== "string" ||
      !body.event_kind ||
      body.event_kind.length > MAX_EVENT_KIND_LENGTH
    ) {
      return {
        ok: false,
        error: `\`event_kind\`, when provided, must be a non-empty string up to ${MAX_EVENT_KIND_LENGTH} characters.`,
      };
    }
    eventKind = body.event_kind;
  }

  let account: string | null = null;
  if (body.account !== undefined) {
    if (
      typeof body.account !== "string" ||
      !body.account ||
      body.account.length > MAX_ACCOUNT_LENGTH
    ) {
      return {
        ok: false,
        error: `\`account\`, when provided, must be a non-empty string up to ${MAX_ACCOUNT_LENGTH} characters.`,
      };
    }
    account = body.account;
  }

  let minAmountTao: number | null = null;
  if (body.min_amount_tao !== undefined) {
    if (
      typeof body.min_amount_tao !== "number" ||
      !Number.isFinite(body.min_amount_tao) ||
      body.min_amount_tao < 0 ||
      body.min_amount_tao > MIN_AMOUNT_TAO_CEILING
    ) {
      return {
        ok: false,
        error:
          "`min_amount_tao`, when provided, must be a non-negative finite number.",
      };
    }
    minAmountTao = body.min_amount_tao;
  }

  const conditionResult = validateAlertCondition(body.condition);
  if (!conditionResult.ok) return conditionResult;
  const condition = conditionResult.value;

  if (
    netuid === null &&
    !eventKind &&
    !account &&
    minAmountTao === null &&
    !condition
  ) {
    return {
      ok: false,
      error:
        "At least one of netuid, event_kind, account, min_amount_tao, or condition is required.",
    };
  }

  return {
    ok: true,
    value: {
      name,
      tableFilter,
      netuid,
      eventKind,
      account,
      minAmountTao,
      condition,
      channel: body.channel as string,
      destination: body.destination as string,
    },
  };
}

export interface EvaluatorAlertTrigger {
  id: string;
  name: unknown;
  tableFilter: string[] | null;
  netuid: number | null;
  eventKind: string | null;
  account: string | null;
  minAmountTao: number | null;
  condition: AlertConditionInput | null;
  channel: unknown;
  destination: unknown;
}

// Evaluate one active trigger against a firehose broadcast payload (the SAME
// shape ChainFirehoseHub.broadcast() fans out to SSE/WS/GraphQL/MCP -- see
// workers/chain-firehose-hub.mjs). Pure, no I/O: the caller owns persistence
// (match_count/last_matched_at) and delivery.
//
// `metricSnapshot` (#6746/#6747) is an OPTIONAL, pre-computed cache the
// caller refreshes on its own bounded schedule (AlerterHub.refreshTriggers(),
// alongside the trigger list itself) -- this function never fetches or
// computes a metric itself, only reads whatever snapshot it's handed. A
// condition trigger with no snapshot available (metricSnapshot omitted, or
// cold on a fresh evaluator) fails closed -- it never matches -- rather than
// throwing or silently skipping the condition check, so a stale/missing
// snapshot can only under-fire, never over-fire, a predicate trigger.
export function triggerMatchesEvent(
  trigger: EvaluatorAlertTrigger,
  payload: Record<string, unknown> | null | undefined,
  metricSnapshot: AlertMetricSnapshot | null = null,
): boolean {
  if (!payload || typeof payload !== "object") return false;
  if (
    trigger.tableFilter &&
    !trigger.tableFilter.includes(payload.table as string)
  ) {
    return false;
  }
  if (trigger.netuid !== null && payload.netuid !== trigger.netuid) {
    return false;
  }
  if (trigger.eventKind && payload.event_kind !== trigger.eventKind) {
    return false;
  }
  if (
    trigger.account &&
    payload.hotkey !== trigger.account &&
    payload.coldkey !== trigger.account
  ) {
    return false;
  }
  if (
    trigger.minAmountTao !== null &&
    !(
      typeof payload.amount_tao === "number" &&
      payload.amount_tao >= trigger.minAmountTao
    )
  ) {
    return false;
  }
  if (trigger.condition) {
    const value = readConditionMetric(
      trigger.condition.metric,
      payload,
      metricSnapshot,
    );
    if (
      value === null ||
      !compareAlertCondition(
        value,
        trigger.condition.operator,
        trigger.condition.threshold,
      )
    ) {
      return false;
    }
  }
  return true;
}

// The owner_token is the sole ownership credential (returned once, at
// creation, never echoed back on read) -- there is no user-account system in
// this codebase, matching src/webhooks.mjs's own per-subscription-secret
// model. Unlike webhook subscriptions, a trigger's `destination` can itself
// be a bearer credential (a Discord incoming-webhook URL grants POST-message
// capability to anyone holding it), so every single-trigger route
// (GET/PATCH/DELETE) requires the owner_token, not just PATCH/DELETE --
// there is no "public" trigger view.
export function generateAlertTriggerOwnerToken(): string {
  return generateSecret();
}

export function isValidAlertOwnerToken(
  provided: unknown,
  stored: unknown,
): boolean {
  return (
    typeof provided === "string" &&
    provided.length > 0 &&
    typeof stored === "string" &&
    stored.length > 0 &&
    timingSafeEqual(provided, stored)
  );
}

export interface OwnerAlertTriggerView {
  id: string;
  name: unknown;
  table_filter: unknown;
  netuid: unknown;
  event_kind: unknown;
  account: unknown;
  min_amount_tao: number | null;
  condition: unknown;
  channel: unknown;
  destination: unknown;
  active: boolean;
  created_at: unknown;
  updated_at: unknown;
  last_matched_at: unknown;
  match_count: unknown;
}

// Strips owner_token before a record is returned to its owner. Every other
// field is safe to echo back to whoever already proved ownership.
export function ownerAlertTriggerView(
  record: Record<string, unknown> | null | undefined,
): OwnerAlertTriggerView | null {
  if (!record || typeof record !== "object") return null;
  return {
    id: String(record.id),
    name: record.name ?? null,
    table_filter: record.table_filter ?? null,
    netuid: record.netuid ?? null,
    event_kind: record.event_kind ?? null,
    account: record.account ?? null,
    min_amount_tao:
      record.min_amount_tao === undefined || record.min_amount_tao === null
        ? null
        : Number(record.min_amount_tao),
    condition: record.condition ?? null,
    channel: record.channel,
    destination: record.destination,
    active: record.active !== false,
    created_at: record.created_at ?? null,
    updated_at: record.updated_at ?? null,
    last_matched_at: record.last_matched_at ?? null,
    match_count: record.match_count ?? 0,
  };
}

// The shape AlerterHub (#4984 Part 2) caches for evaluation -- narrower than
// ownerAlertTriggerView (no owner_token, but also no created_at/updated_at
// bookkeeping the evaluator never reads) and pre-shaped for
// triggerMatchesEvent's field names (camelCase, matching validateAlertTriggerInput's
// `value`). Includes `name` (#4984 Part 3) so delivery message formatting
// can reference it without a second Postgres read.
export function evaluatorAlertTriggerView(
  record: Record<string, unknown> | null | undefined,
): EvaluatorAlertTrigger | null {
  if (!record || typeof record !== "object") return null;
  return {
    id: String(record.id),
    name: record.name ?? null,
    tableFilter: (record.table_filter as string[] | undefined) ?? null,
    netuid: (record.netuid as number | undefined) ?? null,
    eventKind: (record.event_kind as string | undefined) ?? null,
    account: (record.account as string | undefined) ?? null,
    minAmountTao:
      record.min_amount_tao === undefined || record.min_amount_tao === null
        ? null
        : Number(record.min_amount_tao),
    condition: (record.condition as AlertConditionInput | undefined) ?? null,
    channel: record.channel,
    destination: record.destination,
  };
}

// A trigger id is a Postgres BIGSERIAL -- validate before binding into a
// query. Accepts the string form (route params are always strings) and
// rejects anything that isn't a plain, non-negative integer literal (no
// leading zeros beyond "0" itself, no sign, no whitespace).
export function isValidAlertTriggerId(id: unknown): boolean {
  return /^(0|[1-9]\d*)$/.test(String(id));
}
