import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { apiTagIndexRow } from "../apps/ui/scripts/api-tag-index-row.ts";

const operation = {
  slug: "get-account",
  title: "Get Account",
  method: "GET",
  route: "/api/v1/accounts/{ss58}",
};

describe("generated API tag index rows (#11553)", () => {
  test("descriptions retain a hard break without trailing whitespace", () => {
    const row = apiTagIndexRow("accounts", {
      ...operation,
      description: "Read an account.",
    });
    assert.equal(
      row,
      "- [Get Account](/docs/api-reference/accounts/get-account) — `GET /api/v1/accounts/{ss58}`\\\n  Read an account.",
    );
    assert.doesNotMatch(row, /[\t ]+$/m);
  });

  test.each([undefined, ""])(
    "an absent description (%s) adds neither a break nor a blank line",
    (description) => {
      assert.equal(
        apiTagIndexRow("accounts", { ...operation, description }),
        "- [Get Account](/docs/api-reference/accounts/get-account) — `GET /api/v1/accounts/{ss58}`",
      );
    },
  );

  test("escapes MDX prose while preserving route parameters in code", () => {
    const row = apiTagIndexRow("accounts", {
      ...operation,
      title: "Get <Account> {network}",
      description: "Use ?counterparty=<ss58> on {network}.",
    });
    assert.equal(
      row,
      "- [Get \\<Account> \\{network}](/docs/api-reference/accounts/get-account) — `GET /api/v1/accounts/{ss58}`\\\n  Use ?counterparty=\\<ss58> on \\{network}.",
    );
    assert.doesNotMatch(row, /[\t ]+$/m);
  });
});
