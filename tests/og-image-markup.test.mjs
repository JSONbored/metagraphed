import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { renderMarkup } from "../src/og-image.ts";

// The stat-row separator dot (renderStatRow joins parts with this between them).
const STAT_DOT = /width:8px;height:8px;border-radius:4px/g;
const dotCount = (markup) => (markup.match(STAT_DOT) || []).length;

describe("renderMarkup", () => {
  test("always renders the brand wordmark and tagline", () => {
    const markup = renderMarkup(["1 subnet"]);
    assert.ok(markup.includes("Metagraphed"));
    assert.ok(markup.includes("The Bittensor subnet integration registry"));
  });

  test("renders each stat part verbatim, separated by one dot between two", () => {
    const markup = renderMarkup(["128 subnets", "540 surfaces"]);
    assert.ok(markup.includes("128 subnets"));
    assert.ok(markup.includes("540 surfaces"));
    assert.equal(dotCount(markup), 1); // 2 parts → 1 separator
  });

  test("a single stat part has no separator dot", () => {
    assert.equal(dotCount(renderMarkup(["only one"])), 0);
  });

  test("falls back to the default stat line when no parts are given", () => {
    const fallback = "Live health, schemas, and discovery for every subnet";
    assert.ok(renderMarkup([]).includes(fallback));
    assert.equal(dotCount(renderMarkup([])), 0);
  });
});
