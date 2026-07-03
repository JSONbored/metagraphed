import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { captureStamp } from "../src/capture-stamp.mjs";

describe("captureStamp", () => {
  test("coerces numeric epoch-ms and ISO strings", () => {
    assert.deepEqual(captureStamp(1_750_000_000_000), {
      ms: 1_750_000_000_000,
      value: "2025-06-15T15:06:40.000Z",
    });
    assert.deepEqual(captureStamp("1750000060000"), {
      ms: 1_750_000_060_000,
      value: "2025-06-15T15:07:40.000Z",
    });
    assert.deepEqual(captureStamp("2026-06-15T00:00:00.000Z"), {
      ms: Date.parse("2026-06-15T00:00:00.000Z"),
      value: "2026-06-15T00:00:00.000Z",
    });
  });

  test("rejects invalid and out-of-range cells", () => {
    for (const value of [
      null,
      undefined,
      "",
      "0",
      "not-a-date",
      -1,
      0,
      8_640_000_000_000_001,
      "8640000000000001",
    ]) {
      assert.equal(captureStamp(value), null, `expected null for ${value}`);
    }
  });
});
