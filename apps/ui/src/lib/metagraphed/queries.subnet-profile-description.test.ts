import { describe, expect, it } from "vitest";
import { normalizeSubnetProfile } from "./queries";

describe("normalizeSubnetProfile description (#8363)", () => {
  it("reads description from subnet.description, never subnet.notes", () => {
    const profile = normalizeSubnetProfile(
      {
        subnet: {
          netuid: 8,
          description: "The first decentralized liquidity engine for prop firms.",
          notes: "Reviewed overlay for SN8 using the official website, dashboard, and repo.",
        },
        profile: {},
      },
      8,
    );
    expect(profile.description).toBe("The first decentralized liquidity engine for prop firms.");
    expect(profile.notes).toBe(
      "Reviewed overlay for SN8 using the official website, dashboard, and repo.",
    );
  });

  it("falls back to profile.derived_description when there's no real description, still never notes", () => {
    const profile = normalizeSubnetProfile(
      {
        subnet: {
          netuid: 9,
          notes: "Reviewed overlay for SN9 using the provider's public notes.",
        },
        profile: {
          derived_description: "A short blurb derived from a provider's public notes.",
        },
      },
      9,
    );
    expect(profile.description).toBe("A short blurb derived from a provider's public notes.");
    expect(profile.notes).toBe("Reviewed overlay for SN9 using the provider's public notes.");
  });

  it("leaves description undefined when there's no description and no derived fallback", () => {
    const profile = normalizeSubnetProfile(
      { subnet: { netuid: 10, notes: "Curator review note only." }, profile: {} },
      10,
    );
    expect(profile.description).toBeUndefined();
    expect(profile.notes).toBe("Curator review note only.");
  });
});
