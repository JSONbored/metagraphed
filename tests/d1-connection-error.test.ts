import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { isD1ConnectionError } from "../src/d1-connection-error.ts";

describe("the connection classifier alone never grants a write replay", () => {
  for (const message of [
    "Network connection lost.",
    "Replica disconnected from primary.",
    "D1 DB reset because its code was updated.",
    "Internal error while starting up D1 DB storage caused object to be reset.",
    "Internal error in D1 DB storage caused object to be reset.",
    "Cannot resolve D1 DB due to transient issue on remote node.",
    "internal error; reference = e_abc-123_xyz",
  ]) {
    test(message, () => {
      assert.equal(isD1ConnectionError(new Error(message)), true);
      assert.equal(
        isD1ConnectionError(new Error("D1_ERROR: " + message)),
        true,
      );
    });
  }
  for (const value of [
    null,
    "Network connection lost.",
    { message: "Network connection lost." },
    new Error("D1_ERROR: no such table: tao_usd_index"),
    new Error("D1_ERROR: CHECK constraint failed"),
    new Error("D1_ERROR: Too many requests"),
    new Error("D1_ERROR: Database storage limit exceeded"),
    new Error("D1_ERROR: Unauthorized"),
    new Error("Network connection lost. while running invalid SQL"),
    new Error("connection timeout"),
  ]) {
    test(`rejects unclassified failure ${String(value)}`, () => {
      assert.equal(isD1ConnectionError(value), false);
    });
  }
});
