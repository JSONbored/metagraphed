import { describe, expect, it } from "vitest";
import { shouldShowProviderSlugSubtitle } from "./provider-hero-fields";

describe("shouldShowProviderSlugSubtitle", () => {
  it("hides the subtitle when the name is a case-folded repeat of the slug", () => {
    expect(shouldShowProviderSlugSubtitle("404-GEN", "404-gen")).toBe(false);
    expect(shouldShowProviderSlugSubtitle("acme", "acme")).toBe(false);
  });

  it("shows the subtitle when the name meaningfully differs from the slug", () => {
    expect(shouldShowProviderSlugSubtitle("Acme Labs", "acme")).toBe(true);
  });

  it("hides the subtitle when there's no name (title already falls back to the slug)", () => {
    expect(shouldShowProviderSlugSubtitle(undefined, "acme")).toBe(false);
  });
});
