import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS,
  nominatorCountsByHotkey,
} from "../src/validator-nominator-summary.ts";

describe("nominatorCountsByHotkey", () => {
  test("builds a hotkey -> nominator_count Map from rows", () => {
    const map = nominatorCountsByHotkey([
      { hotkey: "5Hk1", nominator_count: 42, captured_at: 1_700_000_000_000 },
      { hotkey: "5Hk2", nominator_count: 0, captured_at: 1_700_000_000_000 },
    ]);
    assert.equal(map.get("5Hk1"), 42);
    assert.equal(map.get("5Hk2"), 0);
    assert.equal(map.size, 2);
  });

  test("is cold-safe for non-array/empty input", () => {
    assert.equal(nominatorCountsByHotkey(null).size, 0);
    assert.equal(nominatorCountsByHotkey(undefined).size, 0);
    assert.equal(nominatorCountsByHotkey([]).size, 0);
    assert.equal(
      nominatorCountsByHotkey(
        "not-an-array" as unknown as Parameters<
          typeof nominatorCountsByHotkey
        >[0],
      ).size,
      0,
    );
  });

  test("skips a row with a missing/blank hotkey", () => {
    const map = nominatorCountsByHotkey([
      { hotkey: "", nominator_count: 5 },
      { hotkey: null, nominator_count: 5 },
      { nominator_count: 5 },
    ]);
    assert.equal(map.size, 0);
  });

  test("skips a row with a non-integer or negative nominator_count", () => {
    const map = nominatorCountsByHotkey([
      { hotkey: "5Hk1", nominator_count: -1 },
      { hotkey: "5Hk2", nominator_count: 1.5 },
      { hotkey: "5Hk3", nominator_count: "abc" },
      { hotkey: "5Hk4", nominator_count: null },
    ]);
    assert.equal(map.size, 0);
  });

  test("skips a malformed (non-object) row", () => {
    const map = nominatorCountsByHotkey([
      null,
      undefined,
      "row",
      42,
    ] as unknown as Parameters<typeof nominatorCountsByHotkey>[0]);
    assert.equal(map.size, 0);
  });
});

describe("VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS", () => {
  test("is the exact three-column shape the migration/sync endpoint expect", () => {
    assert.deepEqual(VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS, [
      "hotkey",
      "nominator_count",
      "captured_at",
    ]);
  });
});
