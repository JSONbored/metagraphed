import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { nextDeliveryRecord } from "../src/webhooks.mjs";

describe("nextDeliveryRecord", () => {
  test("returns null next_attempt_at when nowMs is non-finite", () => {
    const record = nextDeliveryRecord({
      existing: null,
      result: {
        id: "sub-1",
        event_id: "evt-1",
        idempotency_key: "key-1",
        retryable: true,
      },
      bodyText: "{}",
      nowIso: "2026-06-01T00:00:00.000Z",
      nowMs: Number.NaN,
      maxRounds: 8,
      baseMs: 60_000,
      maxMs: 3_600_000,
    });
    assert.equal(record.state, "pending");
    assert.equal(record.next_attempt_at, null);
  });
});
