import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #6996: /domains capability-domain rollup. Both route files compose TanStack
// Router/Query context a rendered test can't easily stand up, so this suite is
// node-environment source assertions, mirroring the convention documented in
// subnets-total-stake-tile.test.ts / leaderboards-csv-export-menu.test.ts. The
// query-layer logic (normalizeDomain) is exercised directly in
// ../lib/metagraphed/queries.domains.test.ts.
const list = readFileSync(fileURLToPath(new URL("./domains.index.tsx", import.meta.url)), "utf8");
const detail = readFileSync(fileURLToPath(new URL("./domains.$tag.tsx", import.meta.url)), "utf8");

describe("domains.tsx (rollup list)", () => {
  it("registers the /domains route", () => {
    expect(list).toContain('createFileRoute("/domains/")');
  });

  it("fetches the live rollup from the domains query, not a hardcoded list", () => {
    expect(list).toMatch(/import\s*\{[^}]*domainsQuery[^}]*\}/s);
    expect(list).toContain("useSuspenseQuery(domainsQuery())");
  });

  it("links each domain through to its detail page", () => {
    expect(list).toContain('to="/domains/$tag"');
  });

  it("links each domain through to the subnets table pre-filtered by domain", () => {
    expect(list).toContain('to="/subnets"');
    expect(list).toContain("search={{ domain: d.domain }}");
  });

  it("wraps the wide table in a horizontal-scroll container so it never overflows the page", () => {
    expect(list).toContain("overflow-x-auto");
  });

  it("renders member count, stake, emission share, and concentration per domain", () => {
    expect(list).toContain("formatTao(d.total_stake_tao)");
    expect(list).toContain("formatPercent(d.total_emission_share)");
    expect(list).toContain("nakamoto_coefficient");
  });
});

describe("domains.$tag.tsx (per-domain summary)", () => {
  it("registers the /domains/$tag route", () => {
    expect(detail).toContain('createFileRoute("/domains/$tag")');
  });

  it("fetches the per-domain summary endpoint", () => {
    expect(detail).toMatch(/import\s*\{[^}]*domainSummaryQuery[^}]*\}/s);
    expect(detail).toContain("useSuspenseQuery(domainSummaryQuery(tag))");
  });

  it("surfaces the within-domain emission concentration", () => {
    expect(detail).toContain("emission_concentration");
    expect(detail).toContain('eyebrow="Gini"');
    expect(detail).toContain('eyebrow="Nakamoto"');
  });

  it("links member subnets to their detail pages and back to the filtered table", () => {
    expect(detail).toContain('to="/subnets/$netuid"');
    expect(detail).toContain("search={{ domain: domain.domain }}");
  });
});
