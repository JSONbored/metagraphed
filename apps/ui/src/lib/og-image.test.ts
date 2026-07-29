import { describe, expect, it } from "vitest";

import {
  escapeText,
  normalizeLogoHost,
  normalizeSubtitle,
  normalizeTitle,
  readCardParams,
  renderCardMarkup,
  titleFontSize,
} from "./og-image";

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

// --- #8489: brand card params + layout guards ---------------------------

describe("readCardParams (#8489)", () => {
  it("reads eyebrow and up to two stat pairs", () => {
    const p = new URLSearchParams({
      eyebrow: "Subnet",
      stat1: "Netuid",
      stat1v: "SN64",
      stat2: "Alpha price",
      stat2v: "0.0832 τ",
    });
    expect(readCardParams(p)).toEqual({
      eyebrow: "Subnet",
      logoHost: null,
      stats: [
        { label: "Netuid", value: "SN64" },
        { label: "Alpha price", value: "0.0832 τ" },
      ],
    });
  });

  it("drops a half-specified stat — a value with no label is unreadable", () => {
    const p = new URLSearchParams({ stat1: "Netuid", stat2v: "orphaned" });
    expect(readCardParams(p).stats).toEqual([]);
  });

  it("returns null eyebrow and no stats when absent, so the card falls back", () => {
    expect(readCardParams(new URLSearchParams())).toEqual({
      eyebrow: null,
      stats: [],
      logoHost: null,
    });
  });

  it("bounds every param, so a crawler-supplied query can't overflow the card", () => {
    const p = new URLSearchParams({
      eyebrow: "e".repeat(200),
      stat1: "l".repeat(200),
      stat1v: "v".repeat(200),
    });
    const out = readCardParams(p);
    expect(out.eyebrow!.length).toBeLessThanOrEqual(32);
    expect(out.stats[0]!.label.length).toBeLessThanOrEqual(24);
    expect(out.stats[0]!.value.length).toBeLessThanOrEqual(28);
  });
});

describe("titleFontSize (#8489)", () => {
  it("steps down so a long title can't push the stat rail off the card", () => {
    expect(titleFontSize("Chutes".length)).toBe(68);
    expect(titleFontSize(40)).toBe(54);
    expect(titleFontSize(110)).toBe(42);
  });

  it("is monotonic — a longer title never renders larger", () => {
    let prev = Infinity;
    for (let n = 1; n <= 110; n++) {
      const size = titleFontSize(n);
      expect(size).toBeLessThanOrEqual(prev);
      prev = size;
    }
  });
});

describe("renderCardMarkup (#8489)", () => {
  const base = { title: "Chutes", subtitle: "A subnet", eyebrow: "Subnet", stats: [] };

  it("escapes every interpolated value — this endpoint is crawler-reachable", () => {
    const markup = renderCardMarkup({
      ...base,
      title: "<script>alert(1)</script>",
      eyebrow: '"><img>',
      stats: [{ label: "<b>", value: "</div>" }],
    });
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img>");
    expect(markup).toContain("&lt;script&gt;");
  });

  it("sizes the root to exactly the canvas, with padding on an inner wrapper", () => {
    // Regression: width/height on the padded element renders 1360x758 under
    // content-box, silently outgrowing the 1200x630 canvas.
    const markup = renderCardMarkup(base);
    expect(markup).toContain("width:1200px;height:630px");
    expect(markup).not.toMatch(/width:1200px;height:630px;padding/);
  });

  it("omits the eyebrow pill entirely when there is none", () => {
    expect(renderCardMarkup({ ...base, eyebrow: null })).not.toContain("border-radius:999px");
  });
});

describe("normalizeLogoHost (#8489) — /og is unauthenticated, so this gates SSRF", () => {
  it("accepts a plain public DNS name", () => {
    expect(normalizeLogoHost("chutes.ai")).toBe("chutes.ai");
    expect(normalizeLogoHost("  Sub.Example.CO.UK ")).toBe("sub.example.co.uk");
  });

  it("rejects anything that is a URL rather than a hostname", () => {
    // The whole point: a caller must never be able to name the fetch target.
    for (const bad of [
      "https://evil.example/x",
      "//evil.example",
      "evil.example/path",
      "user@evil.example",
      "evil.example:8080",
      "javascript:alert(1)",
      "data:text/html,x",
    ]) {
      expect(normalizeLogoHost(bad)).toBeNull();
    }
  });

  it("rejects IP literals and internal names", () => {
    for (const bad of [
      "127.0.0.1",
      "10.0.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "localhost",
      "foo.localhost",
      "svc.internal",
      "box.local",
    ]) {
      expect(normalizeLogoHost(bad)).toBeNull();
    }
  });

  it("rejects empty, over-long, and malformed input", () => {
    expect(normalizeLogoHost(null)).toBeNull();
    expect(normalizeLogoHost("")).toBeNull();
    expect(normalizeLogoHost("nodot")).toBeNull();
    expect(normalizeLogoHost(`${"a".repeat(90)}.com`)).toBeNull();
  });
});

describe("card font stack (#8489)", () => {
  it("lists Inter after the display face so tau isn't tofu", () => {
    // Space Grotesk has no Greek coverage; every TAO value contains τ. Caught
    // by a real satori render — Chromium substituted a system font and hid it.
    const markup = renderCardMarkup({
      title: "Chutes",
      subtitle: "x",
      eyebrow: null,
      stats: [{ label: "Alpha price", value: "0.0832 τ" }],
    });
    expect(markup).toContain("font-family:'Space Grotesk','Inter'");
  });
});

describe("entity logo (#8489)", () => {
  it("renders the logo through OUR icon proxy, never the caller's URL", () => {
    const markup = renderCardMarkup({
      title: "Chutes",
      subtitle: "x",
      eyebrow: "Subnet",
      stats: [],
      logoHost: "chutes.ai",
    });
    expect(markup).toContain("https://api.metagraph.sh/api/v1/icon?host=chutes.ai");
  });

  it("falls back to the mint rule when there is no logo", () => {
    const markup = renderCardMarkup({
      title: "5Grwva…GKutQY",
      subtitle: "x",
      eyebrow: "Account",
      stats: [],
    });
    expect(markup).not.toContain("/api/v1/icon");
  });
});
