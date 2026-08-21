import { describe, expect, it } from "vitest";

import { renderApiTagIndexPage } from "./openapi-docs-index";

describe("renderApiTagIndexPage", () => {
  it("uses a CommonMark backslash hard break without trailing whitespace", () => {
    const page = renderApiTagIndexPage({
      tag: "subnets",
      title: "Subnets",
      operations: [
        {
          slug: "price-share-composition",
          title: "Price Share Composition",
          method: "GET",
          route: "/api/v1/chain/subnet-price-share-composition",
          description: "Compare observed price shares across the selected period.",
        },
      ],
    });

    expect(page).toContain(
      "`GET /api/v1/chain/subnet-price-share-composition`\\\n  Compare observed price shares across the selected period.",
    );
    expect(page).not.toMatch(/[ \t]+$/m);
  });
});
