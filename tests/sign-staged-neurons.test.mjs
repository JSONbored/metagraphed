import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "vitest";
import { buildSignedEnvelope } from "../scripts/sign-staged-neurons.mjs";

const KEY = "test-staging-signing-key";

const hmacOf = (payload, key = KEY) =>
  createHmac("sha256", key).update(payload).digest("hex");

describe("buildSignedEnvelope (staged-neurons signing)", () => {
  test("array input signs JSON.stringify(rows) directly", () => {
    const rows = [
      { netuid: 1, hotkey: "a" },
      { netuid: 2, hotkey: "b" },
    ];
    const envelope = buildSignedEnvelope(rows, KEY);

    assert.equal(envelope.schema_version, 1);
    assert.deepEqual(envelope.rows, rows);
    assert.equal(envelope.hmac_sha256, hmacOf(JSON.stringify(rows)));
    // A bare array carries no staging metadata.
    assert.equal("refreshed_netuids" in envelope, false);
    assert.equal("captured_at" in envelope, false);
  });

  test("object input signs the full { rows, refreshed_netuids, captured_at }", () => {
    const parsed = {
      rows: [{ netuid: 7 }],
      refreshed_netuids: [7, 8],
      captured_at: "2026-07-20T00:00:00.000Z",
    };
    const envelope = buildSignedEnvelope(parsed, KEY);

    assert.equal(envelope.schema_version, 1);
    assert.deepEqual(envelope.rows, parsed.rows);
    assert.deepEqual(envelope.refreshed_netuids, parsed.refreshed_netuids);
    assert.equal(envelope.captured_at, parsed.captured_at);
    assert.equal(
      envelope.hmac_sha256,
      hmacOf(
        JSON.stringify({
          rows: parsed.rows,
          refreshed_netuids: parsed.refreshed_netuids,
          captured_at: parsed.captured_at,
        }),
      ),
    );
  });

  test("object input omits undefined staging metadata from the envelope", () => {
    const envelope = buildSignedEnvelope({ rows: [] }, KEY);

    assert.deepEqual(envelope.rows, []);
    assert.equal("refreshed_netuids" in envelope, false);
    assert.equal("captured_at" in envelope, false);
    assert.equal(
      envelope.hmac_sha256,
      hmacOf(
        JSON.stringify({
          rows: [],
          refreshed_netuids: undefined,
          captured_at: undefined,
        }),
      ),
    );
  });

  test("object input with non-array rows throws", () => {
    assert.throws(
      () => buildSignedEnvelope({ rows: "not-an-array" }, KEY),
      /staged payload rows must be a JSON array/,
    );
    assert.throws(
      () => buildSignedEnvelope({ refreshed_netuids: [1] }, KEY),
      /staged payload rows must be a JSON array/,
    );
  });

  test("input that is neither an array nor an object throws", () => {
    for (const bad of [null, "string", 42, true]) {
      assert.throws(
        () => buildSignedEnvelope(bad, KEY),
        /staged payload must be a JSON array or staging object/,
      );
    }
  });

  test("same input + key is deterministic; a different key changes the hmac", () => {
    const rows = [{ netuid: 1 }];
    const a = buildSignedEnvelope(rows, KEY);
    const b = buildSignedEnvelope(rows, KEY);
    assert.equal(a.hmac_sha256, b.hmac_sha256);

    const c = buildSignedEnvelope(rows, "a-different-key");
    assert.notEqual(a.hmac_sha256, c.hmac_sha256);
  });
});
