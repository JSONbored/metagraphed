import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fromRoute = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const subnetPage = fromRoute("./-subnets-netuid-page.tsx");
const subnetIndex = fromRoute("./-subnets-index-page.tsx");
const redirect = fromRoute("./revenue.tsx");
const detailSection = fromRoute("../components/metagraphed/subnet-detail/revenue.tsx");
const coverageSection = fromRoute("../components/metagraphed/subnets-index/revenue.tsx");

describe("subnet revenue surfaces", () => {
  it("gives every dynamic subnet a revenue ledger and API source", () => {
    expect(subnetPage).toContain("RevenueSection");
    expect(detailSection).toContain("`/api/v1/subnets/${netuid}/revenue`");
    expect(detailSection).toContain('id="revenue"');
    expect(detailSection).toContain("No readable external revenue has been observed");
  });

  it("keeps the directory denominator visible instead of turning revenue into a ranking", () => {
    expect(subnetIndex).toContain("RevenueCoverageSection");
    expect(coverageSection).toContain('"/api/v1/chain/revenue-coverage"');
    expect(coverageSection).toContain("not a speculative ranking");
    expect(coverageSection).toContain("Subnets with readable external revenue");
  });

  it("defers the non-critical evidence reads and keeps the old URL pointed at them", () => {
    expect(detailSection).toContain("enabled: nearViewport");
    expect(coverageSection).toContain("enabled: nearViewport");
    expect(redirect).toContain('hash: "revenue"');
    expect(redirect).toContain("statusCode: 301");
  });
});
