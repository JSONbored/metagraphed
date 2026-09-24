import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  safeBlockNumber,
  safeHexLiteral,
  safeSs58Literal,
  safeNameLiteral,
} from "../src/history-readers.ts";
describe("safe literals — the only defence against injection here", () => {
  test("block numbers: real non-negative integers only", () => {
    assert.equal(safeBlockNumber(8755000), 8755000);
    assert.equal(safeBlockNumber("8755000"), 8755000);
    for (const bad of [
      -1,
      1.5,
      NaN,
      Infinity,
      "abc",
      null,
      undefined,
      true,
      false,
      "",
      "  ",
      "-5",
      "1.5",
      "1; DROP TABLE",
      // All digits, but beyond Number.MAX_SAFE_INTEGER -- would lose precision
      // and address the wrong block.
      "99999999999999999999",
    ]) {
      assert.equal(safeBlockNumber(bad), null, `rejected: ${String(bad)}`);
    }
  });

  test("hex literals: 0x-prefixed hex only, lowercased", () => {
    assert.equal(safeHexLiteral("0xABCdef"), "0xabcdef");
    for (const bad of [
      "abcdef",
      "0x",
      "0xzz",
      "0x123'--",
      "'; DROP TABLE chain.blocks; --",
      42,
      null,
    ]) {
      assert.equal(safeHexLiteral(bad), null, `rejected: ${String(bad)}`);
    }
  });
});

describe("the inline-literal guards", () => {
  test("safeSs58Literal accepts real addresses at every length Substrate uses", () => {
    for (const ok of [
      "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u", // 48
      "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      "1".repeat(47),
      "1".repeat(49),
    ]) {
      assert.equal(safeSs58Literal(ok), ok, ok.slice(0, 12));
    }
  });

  test("safeSs58Literal refuses anything that could close the quote", () => {
    for (const bad of [
      "'; DROP TABLE chain.account_events --",
      "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u' OR '1'='1",
      "5E2LP6' UNION SELECT 1 --",
      "1".repeat(46), // too short
      "1".repeat(50), // too long
      "", // empty
      "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ0I", // 0 and I are not base58
      null,
      42,
      {},
      ["5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u"],
    ]) {
      assert.equal(
        safeSs58Literal(bad),
        null,
        JSON.stringify(bad)?.slice(0, 40),
      );
    }
  });

  test("safeNameLiteral accepts the identifiers the chain actually emits", () => {
    for (const ok of [
      "Transfer",
      "StakeAdded",
      "SubtensorModule",
      "a",
      "A_1",
      "a".repeat(64),
    ]) {
      assert.equal(safeNameLiteral(ok), ok, ok.slice(0, 20));
    }
  });

  test("safeNameLiteral refuses quotes, spaces, leading digits and overlong names", () => {
    for (const bad of [
      "Transfer'; DROP TABLE x --",
      "Stake Added", // a space
      "1Transfer", // must start with a letter
      "_Transfer",
      "Transfer-Kind", // hyphen is not in the set
      "a".repeat(65), // one past the ceiling
      "",
      null,
      7,
    ]) {
      assert.equal(
        safeNameLiteral(bad),
        null,
        JSON.stringify(bad)?.slice(0, 40),
      );
    }
  });
});
