// Unit tests for src/alert-triggers.mjs (#4984 Part 1). Pure/no-I/O, so every
// branch is directly testable without a Postgres or network dependency.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ALERT_CHANNELS,
  ALERT_CONDITION_METRICS,
  ALERT_CONDITION_OPERATORS,
  ALERT_TRIGGER_CREATE_TOKEN_HEADER,
  ALERT_TRIGGER_MAX_BODY_BYTES,
  ALERT_TRIGGER_OWNER_TOKEN_HEADER,
  ALERT_TRIGGERS_INTERNAL_TOKEN_HEADER,
  evaluatorAlertTriggerView,
  generateAlertTriggerOwnerToken,
  isValidAlertDestination,
  isValidAlertOwnerToken,
  isValidAlertTriggerId,
  ownerAlertTriggerView,
  triggerMatchesEvent,
  validateAlertTriggerInput,
} from "../src/alert-triggers.ts";
import type { EvaluatorAlertTrigger } from "../src/alert-triggers.ts";
import type { Row } from "./row-type.ts";

test("header/limit constants are the documented values", () => {
  assert.equal(
    ALERT_TRIGGER_CREATE_TOKEN_HEADER,
    "x-alert-trigger-create-token",
  );
  assert.equal(ALERT_TRIGGER_OWNER_TOKEN_HEADER, "x-alert-trigger-owner-token");
  assert.equal(
    ALERT_TRIGGERS_INTERNAL_TOKEN_HEADER,
    "x-alert-triggers-internal-token",
  );
  assert.equal(ALERT_TRIGGER_MAX_BODY_BYTES, 8192);
});

// --- isValidAlertDestination ------------------------------------------------

test("isValidAlertDestination: webhook requires a public https:// URL (reuses isPublicWebhookUrl)", () => {
  assert.equal(
    isValidAlertDestination("webhook", "https://example.com/hook"),
    true,
  );
  assert.equal(
    isValidAlertDestination("webhook", "http://example.com/hook"),
    false,
  );
  assert.equal(
    isValidAlertDestination("webhook", "https://localhost/hook"),
    false,
  );
  assert.equal(
    isValidAlertDestination("webhook", "https://192.168.1.1/hook"),
    false,
  );
});

test("isValidAlertDestination: discord requires the exact incoming-webhook URL shape", () => {
  assert.equal(
    isValidAlertDestination(
      "discord",
      "https://discord.com/api/webhooks/123456789012345678/aBc-DeF_123",
    ),
    true,
  );
  assert.equal(
    isValidAlertDestination(
      "discord",
      "https://canary.discord.com/api/webhooks/1/token",
    ),
    true,
  );
  assert.equal(
    isValidAlertDestination("discord", "https://discord.com/invite/abc"),
    false,
  );
  assert.equal(
    isValidAlertDestination(
      "discord",
      "https://evil.example.com/api/webhooks/1/token",
    ),
    false,
  );
  assert.equal(
    isValidAlertDestination(
      "discord",
      "http://discord.com/api/webhooks/1/token",
    ),
    false,
  );
});

test("isValidAlertDestination: email requires a plausible address", () => {
  assert.equal(isValidAlertDestination("email", "a@b.com"), true);
  assert.equal(isValidAlertDestination("email", "not-an-email"), false);
  assert.equal(isValidAlertDestination("email", "a@b"), false);
  assert.equal(
    isValidAlertDestination("email", "a".repeat(250) + "@b.com"),
    false,
  );
});

test("isValidAlertDestination: telegram accepts a signed integer chat id or @channelusername", () => {
  assert.equal(isValidAlertDestination("telegram", "123456789"), true);
  assert.equal(isValidAlertDestination("telegram", "-1001234567890"), true);
  assert.equal(isValidAlertDestination("telegram", "@my_channel"), true);
  assert.equal(isValidAlertDestination("telegram", "not valid"), false);
  assert.equal(isValidAlertDestination("telegram", "@"), false);
});

test("isValidAlertDestination: rejects a non-string, empty, or oversized destination", () => {
  assert.equal(isValidAlertDestination("email", undefined), false);
  assert.equal(isValidAlertDestination("email", ""), false);
  assert.equal(isValidAlertDestination("telegram", "1".repeat(600)), false);
});

test("isValidAlertDestination: rejects an unknown channel", () => {
  assert.equal(isValidAlertDestination("carrier-pigeon", "a@b.com"), false);
});

test("ALERT_CHANNELS is the documented set", () => {
  assert.deepEqual([...ALERT_CHANNELS].sort(), [
    "discord",
    "email",
    "telegram",
    "webhook",
  ]);
});

// --- validateAlertTriggerInput ----------------------------------------------

test("validateAlertTriggerInput: accepts a minimal valid netuid-only trigger", () => {
  const result = validateAlertTriggerInput({
    channel: "discord",
    destination: "https://discord.com/api/webhooks/1/token",
    netuid: 7,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.netuid, 7);
  assert.equal(result.value.tableFilter, null);
  assert.equal(result.value.eventKind, null);
});

test("validateAlertTriggerInput: accepts every condition field together", () => {
  const result = validateAlertTriggerInput({
    channel: "webhook",
    destination: "https://example.com/hook",
    name: "big transfers",
    table_filter: ["account_events", "account_events"], // dedup
    netuid: 7,
    event_kind: "Transfer",
    account: "5F...",
    min_amount_tao: 100,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.tableFilter, ["account_events"]);
  assert.equal(result.value.name, "big transfers");
  assert.equal(result.value.eventKind, "Transfer");
  assert.equal(result.value.account, "5F...");
  assert.equal(result.value.minAmountTao, 100);
});

test("validateAlertTriggerInput: accepts a valid condition and echoes it structured", () => {
  const result = validateAlertTriggerInput({
    channel: "webhook",
    destination: "https://example.com/hook",
    netuid: 7,
    condition: {
      metric: "neuron_immunity_countdown_blocks",
      operator: "lte",
      threshold: 1000,
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.condition, {
    metric: "neuron_immunity_countdown_blocks",
    operator: "lte",
    threshold: 1000,
  });
});

test("validateAlertTriggerInput: a condition alone (no other narrowing field) is sufficient", () => {
  const result = validateAlertTriggerInput({
    channel: "webhook",
    destination: "https://example.com/hook",
    condition: {
      metric: "subnet_alpha_price_rank",
      operator: "gt",
      threshold: 100,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.netuid, null);
});

test("validateAlertTriggerInput: condition omitted entirely defaults to null", () => {
  const result = validateAlertTriggerInput({
    channel: "webhook",
    destination: "https://example.com/hook",
    netuid: 7,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.condition, null);
});

test("validateAlertTriggerInput: rejects a non-object condition", () => {
  const result = validateAlertTriggerInput({
    channel: "webhook",
    destination: "https://example.com/hook",
    netuid: 7,
    condition: "not-an-object",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /condition/);
});

test("validateAlertTriggerInput: rejects an unknown condition.metric", () => {
  const result = validateAlertTriggerInput({
    channel: "webhook",
    destination: "https://example.com/hook",
    netuid: 7,
    condition: { metric: "made_up_metric", operator: "lt", threshold: 1 },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /condition\.metric/);
});

test("validateAlertTriggerInput: rejects an unknown condition.operator", () => {
  const result = validateAlertTriggerInput({
    channel: "webhook",
    destination: "https://example.com/hook",
    netuid: 7,
    condition: {
      metric: "subnet_alpha_price_rank",
      operator: "startswith",
      threshold: 1,
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /condition\.operator/);
});

test("validateAlertTriggerInput: rejects a non-finite condition.threshold", () => {
  for (const threshold of [NaN, Infinity, -Infinity, "10", null, undefined]) {
    const result = validateAlertTriggerInput({
      channel: "webhook",
      destination: "https://example.com/hook",
      netuid: 7,
      condition: {
        metric: "subnet_alpha_price_rank",
        operator: "lt",
        threshold,
      },
    });
    assert.equal(result.ok, false, `threshold=${threshold}`);
    assert.match(result.error, /condition\.threshold/);
  }
});

test("ALERT_CONDITION_METRICS/ALERT_CONDITION_OPERATORS are the documented enums", () => {
  assert.deepEqual(
    [...ALERT_CONDITION_METRICS].sort(),
    ["neuron_immunity_countdown_blocks", "subnet_alpha_price_rank"].sort(),
  );
  assert.deepEqual(
    [...ALERT_CONDITION_OPERATORS].sort(),
    ["eq", "gt", "gte", "lt", "lte"].sort(),
  );
});

test("validateAlertTriggerInput: rejects a non-object body", () => {
  assert.equal(validateAlertTriggerInput(null).ok, false);
  assert.equal(validateAlertTriggerInput([]).ok, false);
  assert.equal(validateAlertTriggerInput("x").ok, false);
});

test("validateAlertTriggerInput: rejects an unknown channel", () => {
  const result = validateAlertTriggerInput({
    channel: "sms",
    destination: "+15555555555",
    netuid: 1,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /channel/);
});

test("validateAlertTriggerInput: rejects a destination that doesn't fit its channel", () => {
  const result = validateAlertTriggerInput({
    channel: "email",
    destination: "not-an-email",
    netuid: 1,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /destination/);
});

test("validateAlertTriggerInput: rejects an oversized name", () => {
  const result = validateAlertTriggerInput({
    channel: "email",
    destination: "a@b.com",
    netuid: 1,
    name: "x".repeat(200),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /name/);
});

test("validateAlertTriggerInput: rejects an empty or unrecognized table_filter entry", () => {
  assert.equal(
    validateAlertTriggerInput({
      channel: "email",
      destination: "a@b.com",
      netuid: 1,
      table_filter: [],
    }).ok,
    false,
  );
  assert.equal(
    validateAlertTriggerInput({
      channel: "email",
      destination: "a@b.com",
      netuid: 1,
      table_filter: ["not_a_real_table"],
    }).ok,
    false,
  );
});

test("validateAlertTriggerInput: rejects an out-of-range netuid", () => {
  assert.equal(
    validateAlertTriggerInput({
      channel: "email",
      destination: "a@b.com",
      netuid: -1,
    }).ok,
    false,
  );
  assert.equal(
    validateAlertTriggerInput({
      channel: "email",
      destination: "a@b.com",
      netuid: 99999,
    }).ok,
    false,
  );
  assert.equal(
    validateAlertTriggerInput({
      channel: "email",
      destination: "a@b.com",
      netuid: 1.5,
    }).ok,
    false,
  );
});

test("validateAlertTriggerInput: netuid 0 (the root subnet) counts as a real condition, not falsy-absent", () => {
  const result = validateAlertTriggerInput({
    channel: "email",
    destination: "a@b.com",
    netuid: 0,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.netuid, 0);
});

test("validateAlertTriggerInput: rejects an empty event_kind or one over the length cap", () => {
  assert.equal(
    validateAlertTriggerInput({
      channel: "email",
      destination: "a@b.com",
      event_kind: "",
    }).ok,
    false,
  );
  assert.equal(
    validateAlertTriggerInput({
      channel: "email",
      destination: "a@b.com",
      event_kind: "x".repeat(100),
    }).ok,
    false,
  );
});

test("validateAlertTriggerInput: rejects an empty account or one over the length cap", () => {
  assert.equal(
    validateAlertTriggerInput({
      channel: "email",
      destination: "a@b.com",
      account: "",
    }).ok,
    false,
  );
  assert.equal(
    validateAlertTriggerInput({
      channel: "email",
      destination: "a@b.com",
      account: "x".repeat(100),
    }).ok,
    false,
  );
});

test("validateAlertTriggerInput: rejects a negative, non-finite, or absurdly large min_amount_tao", () => {
  for (const min_amount_tao of [-1, Infinity, NaN, 2_000_000_000, "100"]) {
    assert.equal(
      validateAlertTriggerInput({
        channel: "email",
        destination: "a@b.com",
        min_amount_tao,
      }).ok,
      false,
      `expected min_amount_tao=${min_amount_tao} to be rejected`,
    );
  }
});

test("validateAlertTriggerInput: min_amount_tao of exactly 0 is a valid (if unusual) threshold", () => {
  const result = validateAlertTriggerInput({
    channel: "email",
    destination: "a@b.com",
    min_amount_tao: 0,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.minAmountTao, 0);
});

test("validateAlertTriggerInput: rejects a trigger with no narrowing condition at all", () => {
  const result = validateAlertTriggerInput({
    channel: "email",
    destination: "a@b.com",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /At least one of/);
});

test("validateAlertTriggerInput: table_filter alone (no other condition) is still rejected", () => {
  const result = validateAlertTriggerInput({
    channel: "email",
    destination: "a@b.com",
    table_filter: ["blocks"],
  });
  assert.equal(result.ok, false);
});

// --- triggerMatchesEvent -----------------------------------------------------

function baseTrigger(overrides: Row = {}): EvaluatorAlertTrigger {
  return {
    tableFilter: null,
    netuid: null,
    eventKind: null,
    account: null,
    minAmountTao: null,
    ...overrides,
  } as EvaluatorAlertTrigger;
}

test("triggerMatchesEvent: a trigger with no conditions matches any payload", () => {
  assert.equal(
    triggerMatchesEvent(baseTrigger(), { table: "blocks", block_number: 1 }),
    true,
  );
});

test("triggerMatchesEvent: table_filter narrows to specific tables", () => {
  const trigger = baseTrigger({ tableFilter: ["account_events"] });
  assert.equal(triggerMatchesEvent(trigger, { table: "account_events" }), true);
  assert.equal(triggerMatchesEvent(trigger, { table: "blocks" }), false);
});

test("triggerMatchesEvent: netuid must match exactly, including 0", () => {
  const trigger = baseTrigger({ netuid: 0 });
  assert.equal(
    triggerMatchesEvent(trigger, { table: "account_events", netuid: 0 }),
    true,
  );
  assert.equal(
    triggerMatchesEvent(trigger, { table: "account_events", netuid: 1 }),
    false,
  );
  assert.equal(
    triggerMatchesEvent(trigger, { table: "account_events", netuid: null }),
    false,
  );
});

test("triggerMatchesEvent: event_kind must match exactly", () => {
  const trigger = baseTrigger({ eventKind: "Transfer" });
  assert.equal(
    triggerMatchesEvent(trigger, {
      table: "account_events",
      event_kind: "Transfer",
    }),
    true,
  );
  assert.equal(
    triggerMatchesEvent(trigger, {
      table: "account_events",
      event_kind: "StakeAdded",
    }),
    false,
  );
});

test("triggerMatchesEvent: account matches EITHER hotkey or coldkey", () => {
  const trigger = baseTrigger({ account: "5FAccount" });
  assert.equal(
    triggerMatchesEvent(trigger, {
      table: "account_events",
      hotkey: "5FAccount",
      coldkey: "5GOther",
    }),
    true,
  );
  assert.equal(
    triggerMatchesEvent(trigger, {
      table: "account_events",
      hotkey: "5GOther",
      coldkey: "5FAccount",
    }),
    true,
  );
  assert.equal(
    triggerMatchesEvent(trigger, {
      table: "account_events",
      hotkey: "5GOther",
      coldkey: "5HOther",
    }),
    false,
  );
});

test("triggerMatchesEvent: min_amount_tao requires a numeric amount_tao at or above the threshold", () => {
  const trigger = baseTrigger({ minAmountTao: 100 });
  assert.equal(
    triggerMatchesEvent(trigger, { table: "account_events", amount_tao: 100 }),
    true,
  );
  assert.equal(
    triggerMatchesEvent(trigger, {
      table: "account_events",
      amount_tao: 99.999,
    }),
    false,
  );
  assert.equal(
    triggerMatchesEvent(trigger, { table: "account_events", amount_tao: null }),
    false,
  );
  assert.equal(
    triggerMatchesEvent(trigger, { table: "account_events" }),
    false,
  );
});

test("triggerMatchesEvent: min_amount_tao of exactly 0 still requires a present numeric amount_tao", () => {
  const trigger = baseTrigger({ minAmountTao: 0 });
  assert.equal(
    triggerMatchesEvent(trigger, { table: "account_events", amount_tao: 0 }),
    true,
  );
  assert.equal(
    triggerMatchesEvent(trigger, { table: "account_events" }),
    false,
  );
});

test("triggerMatchesEvent: ALL present conditions must match (AND, not OR)", () => {
  const trigger = baseTrigger({ netuid: 7, eventKind: "Transfer" });
  assert.equal(
    triggerMatchesEvent(trigger, {
      table: "account_events",
      netuid: 7,
      event_kind: "Transfer",
    }),
    true,
  );
  assert.equal(
    triggerMatchesEvent(trigger, {
      table: "account_events",
      netuid: 7,
      event_kind: "StakeAdded",
    }),
    false,
  );
});

// --- triggerMatchesEvent: condition predicate (#6746/#6747) -----------------

function snapshot({
  priceRank = new Map(),
  immunityCountdown = new Map(),
} = {}) {
  return {
    subnetAlphaPriceRank: priceRank,
    neuronImmunityCountdownBlocks: immunityCountdown,
  };
}

test("triggerMatchesEvent: a subnet_alpha_price_rank condition matches against the snapshot", () => {
  const trigger = baseTrigger({
    netuid: 7,
    condition: {
      metric: "subnet_alpha_price_rank",
      operator: "gt",
      threshold: 100,
    },
  });
  const withinRange = snapshot({ priceRank: new Map([[7, 120]]) });
  const outOfRange = snapshot({ priceRank: new Map([[7, 50]]) });
  assert.equal(
    triggerMatchesEvent(
      trigger,
      { table: "account_events", netuid: 7 },
      withinRange,
    ),
    true,
  );
  assert.equal(
    triggerMatchesEvent(
      trigger,
      { table: "account_events", netuid: 7 },
      outOfRange,
    ),
    false,
  );
});

test("triggerMatchesEvent: a neuron_immunity_countdown_blocks condition is keyed by netuid+hotkey", () => {
  const trigger = baseTrigger({
    condition: {
      metric: "neuron_immunity_countdown_blocks",
      operator: "lte",
      threshold: 1000,
    },
  });
  const snap = snapshot({
    immunityCountdown: new Map([
      ["7:5Fhot", 500],
      ["7:5Fother", 5000],
    ]),
  });
  assert.equal(
    triggerMatchesEvent(
      trigger,
      { table: "account_events", netuid: 7, hotkey: "5Fhot" },
      snap,
    ),
    true,
  );
  assert.equal(
    triggerMatchesEvent(
      trigger,
      { table: "account_events", netuid: 7, hotkey: "5Fother" },
      snap,
    ),
    false,
  );
});

test("triggerMatchesEvent: a condition never matches without a metricSnapshot (fails closed)", () => {
  const trigger = baseTrigger({
    condition: {
      metric: "subnet_alpha_price_rank",
      operator: "gte",
      threshold: 0,
    },
  });
  assert.equal(
    triggerMatchesEvent(trigger, { table: "account_events", netuid: 7 }),
    false,
  );
  assert.equal(
    triggerMatchesEvent(trigger, { table: "account_events", netuid: 7 }, null),
    false,
  );
});

test("triggerMatchesEvent: a condition never matches when the snapshot has no entry for this key", () => {
  const trigger = baseTrigger({
    netuid: 7,
    condition: {
      metric: "subnet_alpha_price_rank",
      operator: "gte",
      threshold: 0,
    },
  });
  const emptySnapshot = snapshot();
  assert.equal(
    triggerMatchesEvent(
      trigger,
      { table: "account_events", netuid: 7 },
      emptySnapshot,
    ),
    false,
  );
});

test("triggerMatchesEvent: neuron_immunity_countdown_blocks never matches when the snapshot has no entry for this neuron", () => {
  const trigger = baseTrigger({
    condition: {
      metric: "neuron_immunity_countdown_blocks",
      operator: "gte",
      threshold: 0,
    },
  });
  // A snapshot present but with no entry for this specific netuid:hotkey key
  // (e.g. the neuron isn't currently in its immunity window at all).
  const snap = snapshot({ immunityCountdown: new Map([["1:5Fother", 100]]) });
  assert.equal(
    triggerMatchesEvent(
      trigger,
      { table: "account_events", netuid: 7, hotkey: "5Fhot" },
      snap,
    ),
    false,
  );
});

test("triggerMatchesEvent: a condition is ANDed with fixed-field checks, not a substitute for them", () => {
  const trigger = baseTrigger({
    netuid: 7,
    eventKind: "StakeAdded",
    condition: {
      metric: "subnet_alpha_price_rank",
      operator: "eq",
      threshold: 1,
    },
  });
  const matchingSnapshot = snapshot({ priceRank: new Map([[7, 1]]) });
  // Fixed fields match, condition matches -> true.
  assert.equal(
    triggerMatchesEvent(
      trigger,
      { table: "account_events", netuid: 7, event_kind: "StakeAdded" },
      matchingSnapshot,
    ),
    true,
  );
  // Fixed fields DON'T match (wrong event_kind), condition would match -> still false.
  assert.equal(
    triggerMatchesEvent(
      trigger,
      { table: "account_events", netuid: 7, event_kind: "Transfer" },
      matchingSnapshot,
    ),
    false,
  );
});

test("triggerMatchesEvent: every operator compares the metric value correctly", () => {
  const cases = [
    ["lt", 5, 10, true],
    ["lt", 10, 10, false],
    ["lte", 10, 10, true],
    ["gt", 15, 10, true],
    ["gt", 10, 10, false],
    ["gte", 10, 10, true],
    ["eq", 10, 10, true],
    ["eq", 9, 10, false],
  ];
  for (const [operator, rank, threshold, expected] of cases) {
    const trigger = baseTrigger({
      netuid: 7,
      condition: { metric: "subnet_alpha_price_rank", operator, threshold },
    });
    const snap = snapshot({ priceRank: new Map([[7, rank]]) });
    assert.equal(
      triggerMatchesEvent(
        trigger,
        { table: "account_events", netuid: 7 },
        snap,
      ),
      expected,
      `operator=${operator} rank=${rank} threshold=${threshold}`,
    );
  }
});

test("triggerMatchesEvent: a null/undefined payload never matches", () => {
  assert.equal(triggerMatchesEvent(baseTrigger({ netuid: 1 }), null), false);
  assert.equal(
    triggerMatchesEvent(baseTrigger({ netuid: 1 }), undefined),
    false,
  );
});

// --- ownership + views --------------------------------------------------------

test("generateAlertTriggerOwnerToken: produces a fresh, sufficiently long hex token each call", () => {
  const a = generateAlertTriggerOwnerToken();
  const b = generateAlertTriggerOwnerToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test("isValidAlertOwnerToken: matches only the exact stored token", () => {
  const token = generateAlertTriggerOwnerToken();
  assert.equal(isValidAlertOwnerToken(token, token), true);
  assert.equal(isValidAlertOwnerToken("wrong", token), false);
  assert.equal(isValidAlertOwnerToken("", token), false);
  assert.equal(isValidAlertOwnerToken(token, ""), false);
  assert.equal(isValidAlertOwnerToken(undefined, token), false);
});

test("ownerAlertTriggerView: strips owner_token and normalizes nullable fields", () => {
  const view = ownerAlertTriggerView({
    id: 42,
    owner_token: "secret-should-not-appear",
    name: null,
    table_filter: null,
    netuid: 7,
    event_kind: null,
    account: null,
    min_amount_tao: "100.5", // Postgres NUMERIC often comes back as a string
    channel: "webhook",
    destination: "https://example.com/hook",
    active: true,
    created_at: 1,
    updated_at: 2,
    last_matched_at: null,
    match_count: 3,
  })!;
  assert.equal(view.id, "42");
  assert.equal("owner_token" in view, false);
  assert.equal(view.min_amount_tao, 100.5);
  assert.equal(view.netuid, 7);
});

test("ownerAlertTriggerView: a minimal record (every optional field absent) falls back to null/0 defaults", () => {
  const view = ownerAlertTriggerView({
    id: 1,
    channel: "email",
    destination: "a@b.com",
  })!;
  assert.equal(view.name, null);
  assert.equal(view.table_filter, null);
  assert.equal(view.netuid, null);
  assert.equal(view.event_kind, null);
  assert.equal(view.account, null);
  assert.equal(view.min_amount_tao, null);
  assert.equal(view.created_at, null);
  assert.equal(view.updated_at, null);
  assert.equal(view.last_matched_at, null);
  assert.equal(view.match_count, 0);
  assert.equal(view.active, true); // `active !== false` defaults true when absent
  assert.equal(view.condition, null);
});

test("ownerAlertTriggerView: echoes a present condition verbatim", () => {
  const condition = {
    metric: "subnet_alpha_price_rank",
    operator: "gt",
    threshold: 100,
  };
  const view = ownerAlertTriggerView({
    id: 1,
    channel: "email",
    destination: "a@b.com",
    condition,
  })!;
  assert.deepEqual(view.condition, condition);
});

test("ownerAlertTriggerView: active:false is preserved, not defaulted away", () => {
  const view = ownerAlertTriggerView({
    id: 1,
    channel: "email",
    destination: "a@b.com",
    active: false,
  })!;
  assert.equal(view.active, false);
});

test("ownerAlertTriggerView: returns null for a non-object record", () => {
  assert.equal(ownerAlertTriggerView(null), null);
  assert.equal(ownerAlertTriggerView(undefined), null);
});

test("evaluatorAlertTriggerView: reshapes snake_case columns into triggerMatchesEvent's camelCase fields", () => {
  const view = evaluatorAlertTriggerView({
    id: 7,
    owner_token: "should-not-appear",
    name: "whale watcher",
    table_filter: ["account_events"],
    netuid: 7,
    event_kind: "Transfer",
    account: "5F...",
    min_amount_tao: "10",
    channel: "discord",
    destination: "https://discord.com/api/webhooks/1/t",
  })!;
  assert.equal(view.id, "7");
  assert.equal("owner_token" in view, false);
  assert.equal(view.name, "whale watcher");
  assert.deepEqual(view.tableFilter, ["account_events"]);
  assert.equal(view.eventKind, "Transfer");
  assert.equal(view.minAmountTao, 10);
  assert.equal(view.condition, null);
  // Round-trips straight into triggerMatchesEvent without reshaping again.
  assert.equal(
    triggerMatchesEvent(view, {
      table: "account_events",
      netuid: 7,
      event_kind: "Transfer",
      hotkey: "5F...",
      amount_tao: 10,
    }),
    true,
  );
});

test("evaluatorAlertTriggerView: reshapes a present condition into triggerMatchesEvent's shape", () => {
  const condition = {
    metric: "neuron_immunity_countdown_blocks",
    operator: "lte",
    threshold: 500,
  };
  const view = evaluatorAlertTriggerView({
    id: 7,
    channel: "discord",
    destination: "https://discord.com/api/webhooks/1/t",
    condition,
  })!;
  assert.deepEqual(view.condition, condition);
  const snap = {
    subnetAlphaPriceRank: new Map(),
    neuronImmunityCountdownBlocks: new Map([["7:5Fhot", 100]]),
  };
  assert.equal(
    triggerMatchesEvent(
      view,
      { table: "account_events", netuid: 7, hotkey: "5Fhot" },
      snap,
    ),
    true,
  );
});

test("evaluatorAlertTriggerView: a minimal record (every optional field absent) falls back to null defaults", () => {
  const view = evaluatorAlertTriggerView({
    id: 1,
    channel: "email",
    destination: "a@b.com",
  })!;
  assert.equal(view.name, null);
  assert.equal(view.tableFilter, null);
  assert.equal(view.netuid, null);
  assert.equal(view.eventKind, null);
  assert.equal(view.account, null);
  assert.equal(view.minAmountTao, null);
});

test("evaluatorAlertTriggerView: returns null for a non-object record", () => {
  assert.equal(evaluatorAlertTriggerView(null), null);
});

// --- isValidAlertTriggerId ----------------------------------------------------

test("isValidAlertTriggerId: accepts plain non-negative integer literals", () => {
  assert.equal(isValidAlertTriggerId("0"), true);
  assert.equal(isValidAlertTriggerId("42"), true);
  assert.equal(isValidAlertTriggerId(42), true);
});

test("isValidAlertTriggerId: rejects leading zeros, signs, and non-numeric input", () => {
  assert.equal(isValidAlertTriggerId("007"), false);
  assert.equal(isValidAlertTriggerId("-1"), false);
  assert.equal(isValidAlertTriggerId("1.5"), false);
  assert.equal(isValidAlertTriggerId("abc"), false);
  assert.equal(isValidAlertTriggerId(""), false);
  assert.equal(
    isValidAlertTriggerId("1; DROP TABLE chain_alert_triggers"),
    false,
  );
});
