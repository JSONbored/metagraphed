import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { renderMarkup } from "../src/og-image.ts";

describe("published landing card markup", () => {
  test("renders the API identity, registry context and observed counts", () => {
    const markup = renderMarkup([
      "128 subnets",
      "2,540 endpoints",
      "312 providers",
      "87% coverage",
    ]);
    for (const text of [
      "Metagraphed API",
      "The Bittensor subnet integration registry",
      "128",
      "Subnets",
      "2,540",
      "Endpoints",
      "312",
      "Providers",
      "87%",
      "Coverage",
    ])
      assert.ok(markup.includes(text));
    assert.ok(markup.includes("background:#161616"));
  });
  test("omits absent counts rather than inventing a health verdict", () => {
    for (const parts of [[], null, undefined]) {
      const markup = renderMarkup(parts);
      assert.ok(markup.includes("Metagraphed API"));
      assert.ok(!markup.includes("Coverage"));
      assert.ok(!markup.includes("0/100"));
    }
  });
  test("keeps a count without a separator safe and bounded", () => {
    const markup = renderMarkup(["123"]);
    assert.ok(markup.includes("Registry"));
    assert.ok(markup.includes("123"));
  });
});
