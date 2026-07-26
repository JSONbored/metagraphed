import { describe, expect, it } from "vitest";

import { escapeText, normalizeSubtitle, normalizeTitle } from "./og-image";

describe("escapeText", () => {
  it("escapes HTML metacharacters for safe satori markup embedding", () => {
    expect(escapeText(`Tom & Jerry say "hello" <world>`)).toBe(
      "Tom &amp; Jerry say &quot;hello&quot; &lt;world&gt;",
    );
  });

  it("neutralizes user-controlled markup breakout attempts in ?title=", () => {
    expect(escapeText(`</div><img src=x onerror=alert(1)>`)).toBe(
      "&lt;/div&gt;&lt;img src=x onerror=alert(1)&gt;",
    );
  });

  it("leaves plain titles unchanged", () => {
    expect(escapeText("Subnet 7 overview")).toBe("Subnet 7 overview");
  });
});

describe("normalizeTitle", () => {
  it("falls back to the default title when the param is absent or blank", () => {
    expect(normalizeTitle(null)).toBe("Metagraphed");
    expect(normalizeTitle("")).toBe("Metagraphed");
    expect(normalizeTitle("   ")).toBe("Metagraphed");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeTitle("  Validators  ")).toBe("Validators");
  });

  it("truncates overlong titles with an ellipsis suffix", () => {
    const long = "x".repeat(120);
    const out = normalizeTitle(long);
    expect(out.length).toBe(110);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("x".repeat(109))).toBe(true);
  });
});

describe("normalizeSubtitle (#8257)", () => {
  it("falls back to the tagline when a page passes none", () => {
    expect(normalizeSubtitle(null)).toBe("The Bittensor subnet integration registry");
    expect(normalizeSubtitle("  ")).toBe("The Bittensor subnet integration registry");
  });

  it("keeps an entity subtitle so a share names what it links to", () => {
    expect(normalizeSubtitle("Validator — stake, take and subnet memberships")).toBe(
      "Validator — stake, take and subnet memberships",
    );
  });

  it("truncates rather than letting a long subtitle overflow the card", () => {
    const long = "x".repeat(200);
    const out = normalizeSubtitle(long);
    expect(out.length).toBeLessThanOrEqual(90);
    expect(out.endsWith("\u2026")).toBe(true);
  });
});
