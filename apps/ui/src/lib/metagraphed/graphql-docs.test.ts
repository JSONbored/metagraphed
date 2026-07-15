import { describe, expect, it } from "vitest";
import {
  GRAPHQL_DOCS_MAX_BODY_BYTES,
  GRAPHQL_DOCS_MAX_COMPLEXITY,
  GRAPHQL_DOCS_MAX_DEPTH,
  GRAPHQL_DOCS_MAX_PAGE_LIMIT,
  GRAPHQL_DOCS_MAX_QUERY_BYTES,
  GRAPHQL_ENDPOINT_PATH,
  GRAPHQL_ROOT_QUERIES,
  GRAPHQL_ROOT_QUERY_COUNT,
  buildGraphqlCurlExample,
  buildGraphqlLimitRows,
  formatGraphqlByteBudget,
} from "./graphql-docs";

describe("graphql docs reference (#3513)", () => {
  it("keeps Worker-aligned limit constants", () => {
    expect(GRAPHQL_DOCS_MAX_DEPTH).toBe(7);
    expect(GRAPHQL_DOCS_MAX_COMPLEXITY).toBe(50);
    expect(GRAPHQL_DOCS_MAX_BODY_BYTES).toBe(64 * 1024);
    expect(GRAPHQL_DOCS_MAX_QUERY_BYTES).toBe(16 * 1024);
    expect(GRAPHQL_DOCS_MAX_PAGE_LIMIT).toBe(100);
  });

  it("documents all ten root Query fields without duplicates", () => {
    expect(GRAPHQL_ROOT_QUERIES).toHaveLength(GRAPHQL_ROOT_QUERY_COUNT);
    const names = GRAPHQL_ROOT_QUERIES.map((q) => q.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("subnet");
    expect(names).toContain("compare");
    expect(names).toContain("opportunity_boards");
  });

  it("formats byte budgets as KiB when divisible by 1024", () => {
    expect(formatGraphqlByteBudget(64 * 1024)).toBe("64 KiB");
    expect(formatGraphqlByteBudget(16 * 1024)).toBe("16 KiB");
    expect(formatGraphqlByteBudget(100)).toBe("100 B");
    expect(formatGraphqlByteBudget(Number.NaN)).toBe("—");
  });

  it("builds a limits table covering depth, complexity, bytes, pages, and rate", () => {
    const rows = buildGraphqlLimitRows();
    const labels = rows.map((r) => r.label);
    expect(labels).toEqual([
      "Max depth",
      "Max complexity",
      "Max POST body",
      "Max query document",
      "Page size",
      "Rate limit",
    ]);
    expect(rows[0]?.value).toBe("7");
    expect(rows[5]?.value).toContain("100");
  });

  it("builds a curl example against the GraphQL path", () => {
    const curl = buildGraphqlCurlExample("https://api.metagraph.sh");
    expect(curl).toContain("POST https://api.metagraph.sh/api/v1/graphql");
    expect(curl).toContain("content-type: application/json");
    expect(curl).toContain("subnet(netuid: 7)");
    expect(GRAPHQL_ENDPOINT_PATH).toBe("/api/v1/graphql");
  });
});
