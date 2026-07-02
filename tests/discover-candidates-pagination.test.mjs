import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

const source = await readFile("scripts/discover-candidates.mjs", "utf8");

describe("TaoMarketCap discovery pagination", () => {
  it("keeps count-less pagination bounded by a page cap", () => {
    expect(source).toContain("const TAOMARKETCAP_MAX_PAGES = 50;");
    expect(source).toContain(
      "for (let pageIndex = 0; pageIndex < TAOMARKETCAP_MAX_PAGES; pageIndex += 1)",
    );
    expect(source).toContain(
      "expectedCount !== null && offset >= expectedCount",
    );
    expect(source).toContain(
      "TaoMarketCap pagination exceeded ${TAOMARKETCAP_MAX_PAGES} pages",
    );
  });
});
