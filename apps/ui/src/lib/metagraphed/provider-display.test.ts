import { describe, expect, it } from "vitest";
import { providerSlugSubtitle } from "./provider-display";

describe("providerSlugSubtitle", () => {
  it("hides the subtitle when name and slug are the same string case-insensitively", () => {
    expect(providerSlugSubtitle("404-GEN", "404-gen")).toBeNull();
    expect(providerSlugSubtitle("chutes", "chutes")).toBeNull();
  });

  it("shows the slug when the name meaningfully differs", () => {
    expect(providerSlugSubtitle("Chutes AI", "chutes")).toBe("chutes");
    expect(providerSlugSubtitle("404 GEN Labs", "404-gen")).toBe("404-gen");
  });

  it("hides the subtitle when there is no usable name (title falls back to slug)", () => {
    expect(providerSlugSubtitle(null, "chutes")).toBeNull();
    expect(providerSlugSubtitle(undefined, "chutes")).toBeNull();
    expect(providerSlugSubtitle("", "chutes")).toBeNull();
    expect(providerSlugSubtitle("   ", "chutes")).toBeNull();
  });

  it("ignores surrounding whitespace when comparing", () => {
    expect(providerSlugSubtitle("  404-gen  ", "404-gen")).toBeNull();
    expect(providerSlugSubtitle("Acme", "  acme  ")).toBeNull();
  });

  it("returns the untrimmed slug for display when it differs", () => {
    expect(providerSlugSubtitle("Acme", "acme-labs")).toBe("acme-labs");
  });
});
