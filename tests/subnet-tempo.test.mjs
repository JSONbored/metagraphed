import { describe, test } from "vitest";
import assert from "node:assert/strict";

import { tempoByNetuid } from "../src/subnet-tempo.ts";

describe("tempoByNetuid", () => {
  test("builds a netuid -> tempo Map from rows", () => {
    const map = tempoByNetuid([
      { netuid: 3, tempo: 360 },
      { netuid: 8, tempo: 100 },
    ]);
    assert.equal(map.get(3), 360);
    assert.equal(map.get(8), 100);
    assert.equal(map.size, 2);
  });

  test("is cold-safe for non-array/empty input", () => {
    assert.equal(tempoByNetuid(null).size, 0);
    assert.equal(tempoByNetuid(undefined).size, 0);
    assert.equal(tempoByNetuid([]).size, 0);
    assert.equal(tempoByNetuid("not-an-array").size, 0);
  });

  test("excludes a row with tempo=0 (would divide-by-zero downstream), never stores it", () => {
    const map = tempoByNetuid([{ netuid: 3, tempo: 0 }]);
    assert.equal(map.size, 0);
    assert.equal(map.has(3), false);
  });

  test("excludes a row with a missing/negative/non-integer netuid or tempo", () => {
    const map = tempoByNetuid([
      { netuid: null, tempo: 360 },
      { tempo: 360 },
      { netuid: -1, tempo: 360 },
      { netuid: 3, tempo: null },
      { netuid: 3 },
      { netuid: 3, tempo: -1 },
      { netuid: 3, tempo: 1.5 },
    ]);
    assert.equal(map.size, 0);
  });

  test("excludes a malformed (non-object) row", () => {
    const map = tempoByNetuid([null, undefined, "row", 42]);
    assert.equal(map.size, 0);
  });

  test("excludes a row with a blank/whitespace-only string netuid or tempo", () => {
    const map = tempoByNetuid([
      { netuid: "", tempo: 360 },
      { netuid: "  ", tempo: 360 },
      { netuid: 3, tempo: "" },
      { netuid: 3, tempo: "   " },
    ]);
    assert.equal(map.size, 0);
  });

  test("accepts a numeric-string netuid/tempo (D1/Postgres text cell coercion)", () => {
    const map = tempoByNetuid([{ netuid: "3", tempo: "360" }]);
    assert.equal(map.get(3), 360);
  });
});
