import { describe, expect, it } from "vitest";
import { kindDomainSummary } from "./subnet-masthead";

describe("kindDomainSummary (#8363)", () => {
  it("combines subnet_type and categories into one sentence", () => {
    expect(kindDomainSummary("application", ["DeFi", "Trading"])).toBe(
      "application subnet — DeFi, Trading",
    );
  });

  it("uses subnet_type alone when there are no categories", () => {
    expect(kindDomainSummary("application", [])).toBe("application subnet");
  });

  it("uses categories alone when subnet_type is absent", () => {
    expect(kindDomainSummary(null, ["DeFi", "Trading"])).toBe("DeFi, Trading");
  });

  it("returns null when there's nothing to summarize", () => {
    expect(kindDomainSummary(null, [])).toBeNull();
    expect(kindDomainSummary(undefined, [])).toBeNull();
  });
});
