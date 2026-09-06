import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OG_WORDMARK_SVG } from "./metagraphed/og-wordmark";
import { OG_CARD_VERSION } from "./metagraphed/og-card-limits";
import { parseDesignTokens } from "../components/metagraphed/design/parse-design-tokens";

import {
  CARD_GLYPHS,
  CARD_FONT_FACES,
  OG_THEME,
  OG_FALLBACK_PATH,
  fallbackImageResponse,
  handleOgImage,
  fontSubsetText,
  glyphsForMarkup,
  googleFontUrl,
  loadCardFont,
  iconProxyUrl,
  coverMarkDataUri,
  cardTitleLayout,
  wrapCardTitle,
  monogramFor,
  normalizeLogoHost,
  normalizeLogoPath,
  assetsBindingFrom,
  resolveLocalLogo,
  normalizeSubtitle,
  normalizeTitle,
  readCardParams,
  renderCardMarkup,
  resolveIcon,
  sanitizeText,
  titleFontSize,
} from "./og-image";

describe("sanitizeText", () => {
  it("REMOVES the structural characters and passes everything else through", () => {
    // The ampersand must survive verbatim. workers-og does not decode HTML
    // entities in text nodes -- verified against the deployed Worker, where
    // `?title=Agents %26 MCP` painted the literal characters `& a m p ;` as
    // eight tofu boxes -- so escaping it was the corruption, not the fix.
    expect(sanitizeText(`Tom & Jerry say "hello" <world>`)).toBe(`Tom & Jerry say "hello" world`);
  });

  it("leaves no way to form a tag, which is the only thing that could alter the parse", () => {
    expect(sanitizeText('<img src=x onerror="alert(1)">')).not.toMatch(/[<>]/);
    expect(sanitizeText('</div><div style="width:99999px">')).not.toMatch(/[<>]/);
  });

  it("neutralizes user-controlled markup breakout attempts in ?title=", () => {
    expect(sanitizeText(`</div><img src=x onerror=alert(1)>`)).toBe(
      "/divimg src=x onerror=alert(1)",
    );
  });

  it("leaves plain titles unchanged", () => {
    expect(sanitizeText("Subnet 7 overview")).toBe("Subnet 7 overview");
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
  it("reads eyebrow and up to three stat pairs", () => {
    const p = new URLSearchParams({
      eyebrow: "Subnet",
      stat1: "Netuid",
      stat1v: "SN64",
      stat2: "Price",
      stat2v: "0.0832τ",
      stat3: "Emission",
      stat3v: "3.41%",
      stat4: "Ignored",
      stat4v: "nope",
    });
    expect(readCardParams(p)).toEqual({
      eyebrow: "Subnet",
      logoHost: null,
      logoPath: null,
      entity: false,
      status: null,
      accent: null,
      identifier: null,
      stats: [
        { label: "Netuid", value: "SN64" },
        { label: "Price", value: "0.0832τ" },
        { label: "Emission", value: "3.41%" },
      ],
    });
  });

  it("reads entity as a strict flag and status from a fixed vocabulary", () => {
    const read = (q: Record<string, string>) => readCardParams(new URLSearchParams(q));
    expect(read({ entity: "1" }).entity).toBe(true);
    expect(read({ entity: "true" }).entity).toBe(false);
    expect(read({ status: "warn" }).status).toBe("warn");
    expect(read({ status: "OK" }).status).toBe("ok");
    // Not a health state we know -- dropped rather than guessed at, so a
    // crawler-supplied value can never reach the colour lookup.
    expect(read({ status: "constructor" }).status).toBe(null);
    expect(read({ status: "on fire" }).status).toBe(null);
  });

  it("drops a half-specified stat — a value with no label is unreadable", () => {
    const p = new URLSearchParams({ stat1: "Netuid", stat2v: "orphaned" });
    expect(readCardParams(p).stats).toEqual([]);
  });

  it("accepts only the existing named page accent, never raw colors or CSS", () => {
    expect(readCardParams(new URLSearchParams({ accent: "agent" })).accent).toBe("agent");
    for (const accent of ["Agent", "#b49cff", "red", "constructor", "agent;background:red"])
      expect(readCardParams(new URLSearchParams({ accent })).accent).toBeNull();
  });

  it("bounds the separate identifier before rendering it as text", () => {
    const identifier = readCardParams(
      new URLSearchParams({ identifier: "x".repeat(500) }),
    ).identifier!;
    expect(identifier).toHaveLength(80);
    const markup = renderCardMarkup({
      title: "Example",
      subtitle: "",
      eyebrow: null,
      stats: [],
      identifier: "SN19 <script>",
    });
    expect(markup).toContain(">SN19 script<");
    expect(markup).not.toContain("<script>");
  });

  it("returns null eyebrow and no stats when absent, so the card falls back", () => {
    expect(readCardParams(new URLSearchParams())).toEqual({
      eyebrow: null,
      stats: [],
      logoHost: null,
      logoPath: null,
      entity: false,
      status: null,
      accent: null,
      identifier: null,
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
    expect(titleFontSize("Chutes".length)).toBe(96);
    expect(titleFontSize(40)).toBe(68);
    expect(titleFontSize(90)).toBe(54);
    expect(titleFontSize(91)).toBe(42);
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
  it("omits whitespace flex children without removing spaces from visible copy", () => {
    const markup = renderCardMarkup({
      title: "Two words",
      subtitle: "Two more words",
      eyebrow: "A label",
      stats: [{ label: "A stat", value: "12 τ" }],
    });
    expect(markup).not.toMatch(/>\s+</);
    expect(markup).toContain(">Two words<");
    expect(markup).toContain(">Two more words<");
    expect(markup).toContain(">12 τ<");
  });

  const base = { title: "Chutes", subtitle: "A subnet", eyebrow: "Subnet", stats: [] };

  it("sanitizes every interpolated value — this endpoint is crawler-reachable", () => {
    const markup = renderCardMarkup({
      ...base,
      title: "<script>alert(1)</script>",
      eyebrow: '"><img>',
      stats: [{ label: "<b>", value: "</div>" }],
    });
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("<b>");
    // The card legitimately contains <div> and <img>, so "no <img>" would be a
    // false assertion. What actually matters is that hostile input adds NO
    // element: the tag inventory has to match a benign render exactly.
    const benign = renderCardMarkup({
      ...base,
      title: "script alert(1) script",
      eyebrow: "img",
      stats: [{ label: "b", value: "div" }],
    });
    const tags = (m: string) =>
      (m.match(/<\/?[a-zA-Z][^>]*>/g) ?? []).map((t) => t.split(/[ >]/)[0]);
    expect(tags(markup)).toEqual(tags(benign));
  });

  it("sizes the root to exactly the canvas, with padding on an inner wrapper", () => {
    // Regression: width/height on the padded element renders 1360x758 under
    // content-box, silently outgrowing the 1200x630 canvas.
    const markup = renderCardMarkup(base);
    expect(markup).toContain("width:1200px;height:630px");
    expect(markup).not.toMatch(/width:1200px;height:630px;padding/);
  });

  it("uses the product graphite canvas without a gradient", () => {
    const markup = renderCardMarkup(base);
    expect(markup).toContain(`background:${OG_THEME.canvas}`);
    expect(markup).not.toMatch(/(?:linear|radial)-gradient/);
  });

  it("names a generic card without inventing an entity", () => {
    const markup = renderCardMarkup({ ...base, eyebrow: null });
    expect(markup).not.toContain(">EXPLORER<");
    expect(markup).not.toContain(">CH<");
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
  it("uses the product text and numeric faces with an explicit symbol fallback", () => {
    // Keep a fallback face at every used weight: a Chromium screenshot can
    // conceal missing glyphs that the actual Satori rasterizer cannot paint.
    const markup = renderCardMarkup({
      title: "Chutes",
      subtitle: "x",
      eyebrow: null,
      stats: [{ label: "Alpha price", value: "0.0832τ" }],
    });
    expect(markup).toContain("font-family:'Geist','Inter'");
    expect(markup).toContain("font-family:'Geist Mono','Inter'");
    for (const weight of [400, 500, 700]) {
      expect(CARD_FONT_FACES).toContainEqual({ name: "Geist", weight });
      expect(CARD_FONT_FACES).toContainEqual({ name: "Inter", weight });
    }
    expect(CARD_FONT_FACES).toContainEqual({ name: "Geist Mono", weight: 500 });
  });
});

describe("entity logo (#8489)", () => {
  it("builds the icon URL through OUR proxy, never the caller's URL", () => {
    expect(iconProxyUrl("chutes.ai")).toBe(
      "https://api.metagraph.sh/api/v1/icon?host=chutes.ai&size=128&theme=light",
    );
  });

  it("inlines the resolved icon so the markup never carries a network URL", () => {
    const markup = renderCardMarkup({
      title: "Chutes",
      subtitle: "x",
      eyebrow: "Subnet",
      stats: [],
      entity: true,
      icon: "data:image/png;base64,AAAA",
    });
    expect(markup).toContain('src="data:image/png;base64,AAAA"');
    expect(markup).not.toContain("/api/v1/icon");
  });
});

describe("glyph subsetting (#8489) — every painted character must be subset", () => {
  // Fonts are loaded with `text=<glyphs>`; anything missing rasterizes as a
  // tofu box. This is the invariant, asserted structurally rather than by
  // listing characters — a hand-written list is exactly what drifted before
  // (stat labels were mirrored as .toUpperCase(), the eyebrow pill was not).
  function paintedChars(markup: string): Set<string> {
    return new Set(glyphsForMarkup(markup).replace(/\s/g, ""));
  }

  it("subsets the legacy entity context that is actually painted", () => {
    // Regression: eyebrow "Validator" is painted "VALIDATOR". With the old
    // hand-written subset it rendered "V" + 8 tofu boxes whenever the title
    // didn't happen to supply those capitals.
    const markup = renderCardMarkup({
      title: "chutes",
      subtitle: "a subnet.",
      eyebrow: "Validator",
      entity: true,
      stats: [],
    });
    const painted = paintedChars(markup);
    for (const ch of "Validator") {
      expect(painted.has(ch), `subset is missing "${ch}"`).toBe(true);
    }
  });

  it("covers sentence-case stat labels", () => {
    const markup = renderCardMarkup({
      title: "x",
      subtitle: "y",
      eyebrow: null,
      stats: [{ label: "Alpha price", value: "0.0832τ" }],
    });
    const painted = paintedChars(markup);
    for (const ch of "Alpha price".replace(/\s/g, "")) {
      expect(painted.has(ch), `subset is missing "${ch}"`).toBe(true);
    }
  });

  it("covers the domain and fact values; the owned wordmark uses vector paths", () => {
    const markup = renderCardMarkup({
      title: "x",
      subtitle: "y",
      eyebrow: null,
      stats: [{ label: "Netuid", value: "SN64" }],
    });
    const painted = paintedChars(markup);
    for (const ch of "metagraph.shSN64") {
      expect(painted.has(ch), `subset is missing "${ch}"`).toBe(true);
    }
  });

  it("subsets a literal ampersand, and never the letters of an entity", () => {
    // The card paints "&", so the subset must contain "&" -- not "a","m","p",
    // ";", which is what an escaped title both emitted AND subset, making the
    // corruption self-consistent and therefore invisible to a glyph test.
    const markup = renderCardMarkup({
      title: "Rock & Roll",
      subtitle: "y",
      eyebrow: null,
      stats: [],
    });
    expect(markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).toContain("Rock & Roll");
    expect(markup).not.toContain("&amp;");
    expect(paintedChars(markup).has("&")).toBe(true);
    expect(glyphsForMarkup(markup)).not.toContain("&amp;");
  });

  it("contains no markup residue — tags and their attributes are stripped", () => {
    const markup = renderCardMarkup({
      title: "Chutes",
      subtitle: "y",
      eyebrow: "Subnet",
      stats: [{ label: "Netuid", value: "SN64" }],
      entity: true,
      icon: "data:image/png;base64,AAAA",
    });
    const glyphs = glyphsForMarkup(markup);
    // Style/attribute text would balloon the subset request for glyphs that
    // are never painted.
    expect(glyphs).not.toMatch(/display:flex|border-radius|<div|https:/);
  });
});

describe("monogram fallback (#8489) — an entity card never shows a blank tile", () => {
  it("matches ui-kit BrandIcon's rule: two words → initials, else first two chars", () => {
    expect(monogramFor("tao.bot")).toBe("TA");
    expect(monogramFor("Chutes")).toBe("CH");
    expect(monogramFor("Open Tensor")).toBe("OT");
    expect(monogramFor("5Grwva…GKutQY")).toBe("5G");
    expect(monogramFor("   ")).toBe("··");
  });

  it("renders a monogram tile for an entity card with no logo", () => {
    // The exact complaint: tao.bot showed nothing where the site shows a chip.
    const markup = renderCardMarkup({
      title: "tao.bot",
      subtitle: "x",
      eyebrow: "Validator",
      stats: [],
      entity: true,
    });
    expect(markup).toContain(">TA<");
  });

  it("prefers a resolved icon over the monogram", () => {
    const markup = renderCardMarkup({
      title: "Chutes",
      subtitle: "x",
      eyebrow: "Subnet",
      stats: [],
      entity: true,
      icon: "data:image/png;base64,AAAA",
    });
    expect(markup).toContain("data:image/png;base64,AAAA");
    expect(markup).not.toContain(">CH<");
  });

  it("shows OUR mark on a non-entity card, where a monogram is meaningless", () => {
    // /agents should not read "AG" -- the Metagraphed mark is the honest
    // avatar for a page that is ours rather than an entity's.
    const markup = renderCardMarkup({
      title: "Agent tooling",
      subtitle: "x",
      eyebrow: "Agents",
      stats: [],
    });
    expect(markup).not.toContain(">AG<");
    expect(markup).toContain(coverMarkDataUri());
  });

  it("subsets the monogram's glyphs — it is uppercased, like the eyebrow was", () => {
    const markup = renderCardMarkup({
      title: "tao.bot",
      subtitle: "x",
      eyebrow: "Validator",
      stats: [],
      entity: true,
    });
    const painted = new Set(glyphsForMarkup(markup));
    for (const ch of "TA") expect(painted.has(ch)).toBe(true);
  });
});

describe("resolveIcon (#8489) — satori has no onerror, so we resolve first", () => {
  const png = (bytes: number[]) =>
    new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "content-type": "image/png" },
    });

  it("inlines a fetched icon as a data URI", async () => {
    const fetchImpl = async () => png([1, 2, 3]);
    expect(await resolveIcon("chutes.ai", fetchImpl as unknown as typeof fetch)).toBe(
      "data:image/png;base64,AQID",
    );
  });

  it("returns null on a 404 — the tao.bot case, where no aggregator has a favicon", async () => {
    // The whole point of resolving up front: this used to paint an empty tile
    // in every unfurl for the life of the cache entry, while the site showed
    // a "TA" monogram. Null here is what lets the card fall back the same way.
    const fetchImpl = async () => new Response(null, { status: 404 });
    expect(await resolveIcon("tao.bot", fetchImpl as unknown as typeof fetch)).toBe(null);
  });

  it("rejects a non-image response rather than inlining it", async () => {
    const fetchImpl = async () =>
      new Response("<!doctype html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    expect(await resolveIcon("example.org", fetchImpl as unknown as typeof fetch)).toBe(null);
  });

  it("rejects an empty body and an implausibly large one", async () => {
    const empty = async () => png([]);
    expect(await resolveIcon("a.example", empty as unknown as typeof fetch)).toBe(null);
    const huge = async () =>
      new Response(new Uint8Array(300 * 1024), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    expect(await resolveIcon("b.example", huge as unknown as typeof fetch)).toBe(null);
  });

  it("strips content-type parameters so the data URI stays well-formed", async () => {
    const fetchImpl = async () =>
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "image/svg+xml; charset=utf-8" },
      });
    expect(await resolveIcon("c.example", fetchImpl as unknown as typeof fetch)).toBe(
      "data:image/svg+xml;base64,AQ==",
    );
  });

  it("never throws — a card must render even when the icon service is down", async () => {
    const fetchImpl = async () => {
      throw new Error("network down");
    };
    expect(await resolveIcon("d.example", fetchImpl as unknown as typeof fetch)).toBe(null);
  });

  it("base64s past the 8192-byte chunk boundary without corrupting the icon", async () => {
    // The chunked String.fromCharCode loop exists so a large icon can't blow
    // the argument limit; this proves the seams line up.
    const bytes = Array.from({ length: 20000 }, (_, i) => i % 256);
    const fetchImpl = async () => png(bytes);
    const uri = await resolveIcon("e.example", fetchImpl as unknown as typeof fetch);
    const decoded = Uint8Array.from(atob(uri!.split(",")[1]!), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual(bytes);
  });
});

describe("health compatibility", () => {
  it("does not suggest current health without an observation-time contract", () => {
    const base = { title: "Chutes", subtitle: "x", eyebrow: "Subnet", stats: [], entity: true };
    const unobserved = renderCardMarkup(base);
    for (const status of ["ok", "warn", "down", "unknown", "constructor"])
      expect(renderCardMarkup({ ...base, status })).toBe(unobserved);
    expect(unobserved).not.toContain("Health:");
  });
});

describe("bounded stat rail", () => {
  const base = { title: "Chutes", subtitle: "x", eyebrow: "Subnet", entity: true };

  it("retains three real values and omits a fourth from the rendered and subset text", () => {
    const markup = renderCardMarkup({
      ...base,
      stats: [
        { label: "Netuid", value: "SN64" },
        { label: "Price", value: "0.0832τ" },
        { label: "Emission", value: "3.41%" },
        { label: "Unshown", value: "FOURTH_VALUE" },
      ],
    });
    expect(markup).toContain("SN64");
    expect(markup).toContain("0.0832τ");
    expect(markup).toContain("3.41%");
    expect(markup).not.toContain("UNSHOWN");
    expect(markup).not.toContain("FOURTH_VALUE");
    expect(glyphsForMarkup(markup)).not.toContain("FOURTH_VALUE");
  });

  it("preserves long values while giving them a smaller wrapping numeric face", () => {
    const value = "123456789012345678901234567890";
    const markup = renderCardMarkup({ ...base, stats: [{ label: "Observed value", value }] });
    expect(markup).toContain(`>${value}</div>`);
    expect(markup).toContain("font-size:22px");
    expect(markup).toContain("word-break:break-all");
  });
});

describe("graphite composition", () => {
  const base = { title: "Chutes", subtitle: "x", eyebrow: "Subnet", entity: true };

  it("shows one destination title without duplicated page category or framed bands", () => {
    const markup = renderCardMarkup({
      title: "Agents",
      subtitle: "MCP tools",
      eyebrow: "Agents",
      stats: [],
      accent: "agent",
    });
    expect(markup.match(/>Agents</g)).toHaveLength(1);
    expect(markup).not.toContain(">AGENTS<");
    expect(markup).not.toContain(`background:${OG_THEME.layer};`);
    expect(markup).not.toContain("border-top:");
    expect(markup).toContain(coverMarkDataUri(true));
  });

  it("separates identity from optional facts and omits ungrounded health decoration", () => {
    const markup = renderCardMarkup({
      ...base,
      identifier: "SN19 · block 8,500,000",
      stats: [{ label: "Price", value: "0.08 τ" }],
      status: "warn",
    });
    expect(markup).toContain(">SN19 · block 8,500,000<");
    expect(markup).not.toContain(">Subnet<");
    expect(markup).toContain(">Price<");
    expect(markup).toContain(">0.08 τ<");
    expect(markup).not.toContain("Health:");
    expect(markup).not.toContain(coverMarkDataUri());
    expect(markup).toContain(">CH<");
  });

  it("uses the full owned geometry and authentic site wordmark", () => {
    const svg = atob(coverMarkDataUri(true).split(",")[1]!);
    expect(svg).toContain('viewBox="-2 -2 752 452"');
    expect(svg).not.toContain("transform=");
    expect(svg).toContain(OG_THEME.agent);
    expect(svg).toContain(OG_THEME.brand);
    const source = readFileSync(
      new URL(
        "../../../../packages/ui-kit/src/components/metagraphed/wordmark.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    const canonical = source
      .match(/<svg[\s\S]*?<\/svg>/)![0]
      .replace("className={className}", 'width="1190.44" height="164.29"')
      .replaceAll("currentColor", OG_THEME.ink)
      .replace(/>\s+</g, "><");
    expect(OG_WORDMARK_SVG).toBe(canonical);
  });

  it("bounds wide text with readable type and visible truncation", () => {
    for (const title of [
      "Bittensor in a box",
      "W".repeat(110),
      "界".repeat(110),
      "A long document title with substantial context and an exceptionally descriptive ending",
    ]) {
      const layout = cardTitleLayout(title, true, true, "W".repeat(90));
      expect(layout.fontSize).toBeGreaterThanOrEqual(42);
      expect(layout.lines.length).toBeLessThanOrEqual(3);
      expect(layout.subtitleLines.length).toBeLessThanOrEqual(2);
      expect(
        layout.lines.length * layout.fontSize * 1.13 + 28 + layout.subtitleHeight,
      ).toBeLessThanOrEqual(260);
    }
    expect(cardTitleLayout("界".repeat(110), true, true, "界".repeat(90)).lines.at(-1)).toMatch(
      /…$/,
    );
    expect(wrapCardTitle("Bittensor in a box", 10)).toEqual(["Bittensor", "in a box"]);
  });

  it("uses a quiet monogram tile but protects third-party logo contrast", () => {
    const monogram = renderCardMarkup({ ...base, stats: [] });
    expect(monogram).toContain(`background:${OG_THEME.raised};`);
    expect(monogram).toContain(">CH<");
    const icon = renderCardMarkup({ ...base, stats: [], icon: "data:image/png;base64,AAAA" });
    expect(icon).toContain("background:#ffffff;");
    expect(icon).toContain("object-fit:contain");
    expect(icon).not.toContain(">CH<");
  });

  it("matches the actual stylesheet dark tokens instead of another literal palette", () => {
    const css = readFileSync(
      new URL("../../../../packages/ui-kit/src/styles.css", import.meta.url),
      "utf8",
    );
    const tokens = new Map(
      parseDesignTokens(css).map((token) => [token.name, token.dark ?? token.light]),
    );
    const mapping: Record<keyof typeof OG_THEME, string> = {
      canvas: "--canvas",
      layer: "--layer",
      raised: "--raised",
      ink: "--ink-strong",
      muted: "--ink-muted",
      rule: "--rule",
      brand: "--brand",
      accent: "--accent",
      agent: "--agent",
      good: "--good",
      warn: "--warn",
      bad: "--bad",
      unknown: "--ink-subtle",
    };
    for (const [key, token] of Object.entries(mapping)) {
      expect(OG_THEME[key as keyof typeof OG_THEME], token).toBe(tokens.get(token));
    }
  });
});

describe("font subset request (#11204) — the bug that painted three tofu boxes", () => {
  // The live /subnets/1 card, verbatim: an em dash in the subtitle, an ellipsis
  // from truncation, a tau in the price and a percent in the emission share.
  const APEX = {
    title: "Apex",
    subtitle:
      "Apex (SN1): Bittensor subnet 1 — interfaces, endpoints, schemas, machine-readable on Metagraphed…",
    eyebrow: "Subnet",
    entity: true,
    stats: [
      { label: "Netuid", value: "SN1" },
      { label: "Price", value: "0.0080τ" },
      { label: "Emission", value: "0.61%" },
    ],
  };

  it("percent-encodes the subset text, which is the entire fix", () => {
    // workers-og's loadGoogleFont encodes `family` and interpolates `text` RAW.
    // One `%` in the copy — an emission share of "0.61%" is enough — leaves a
    // bare percent in the query value, Google stops decoding the parameter, and
    // the %E2%80%94 / %E2%80%A6 / %CF%84 escapes for "—", "…" and "τ" are
    // subset as their literal hex letters. Measured against the live endpoint:
    // with the percent encoded all three glyphs come back, without it none do.
    const text = "0.61% Rock & Roll #1 a+b —…τ";
    const url = new URL(googleFontUrl("Space Grotesk", 700, text));
    expect(url.searchParams.get("text")).toBe(text);
    expect(url.searchParams.get("family")).toBe("Space Grotesk:wght@700");
  });

  it("would NOT survive the raw interpolation it replaces", () => {
    // Proves the assertion above can fail: the same string built the way
    // workers-og builds it loses everything from the first "&" onward, and the
    // "#" turns the rest into a fragment.
    const text = "0.61% Rock & Roll #1 a+b —…τ";
    const raw = new URL(`https://fonts.googleapis.com/css2?family=X&text=${text}`);
    expect(raw.searchParams.get("text")).not.toBe(text);
  });

  it("subsets every character the real subnet card paints", () => {
    const markup = renderCardMarkup(APEX);
    const subset = new Set(fontSubsetText(markup));
    for (const char of glyphsForMarkup(markup)) {
      if ((char.codePointAt(0) ?? 0) < 0x20) continue;
      expect(subset.has(char)).toBe(true);
    }
    for (const char of "—…τ%") expect(subset.has(char)).toBe(true);
  });

  it("needs no card-specific extras for that card, so the request is cacheable", () => {
    // The fixed repertoire is what lets caches.default hit: a per-card subset
    // put the card's own prose in the URL, so every render missed.
    expect(fontSubsetText(renderCardMarkup(APEX))).toBe(CARD_GLYPHS);
  });

  it("appends genuinely exotic characters, sorted so two cards can share an entry", () => {
    const extra = fontSubsetText(renderCardMarkup({ ...APEX, title: "Ωmega ыдра" })).slice(
      CARD_GLYPHS.length,
    );
    expect(extra).toContain("Ω");
    expect(extra).toContain("ы");
    expect([...extra]).toStrictEqual([...extra].sort());
  });

  it("never sends the newlines between tags — they are not glyphs", () => {
    // glyphsForMarkup keeps them (it reports what the template contains);
    // the subset request must not, or the URL varies for nothing.
    const isControl = (text: string) => [...text].some((c) => (c.codePointAt(0) ?? 0) < 0x20);
    const markup = `<div>\n${renderCardMarkup(APEX)}\n</div>`;
    expect(isControl(glyphsForMarkup(markup))).toBe(true);
    expect(isControl(fontSubsetText(markup))).toBe(false);
  });
});

describe("loadCardFont (#11204) — we own the two fetches, not workers-og", () => {
  const truetypeCss = (url: string) =>
    `@font-face {\n  font-family: 'X';\n  src: url(${url}) format('truetype');\n}`;

  it("resolves the TrueType face and asks for it with the UA that returns one", async () => {
    // Google serves woff2 to anything modern, and satori cannot parse woff2.
    const seen: Array<{ url: string; ua: string | null }> = [];
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      seen.push({ url: String(input), ua: new Headers(init?.headers).get("user-agent") });
      return seen.length === 1
        ? new Response(truetypeCss("https://fonts.gstatic.com/l/font?kit=abc"))
        : new Response(new Uint8Array([1, 2, 3]));
    }) as unknown as typeof fetch;

    const bytes = await loadCardFont("Test Alpha", 700, "abc", fetchImpl);
    expect(new Uint8Array(bytes)).toStrictEqual(new Uint8Array([1, 2, 3]));
    expect(seen[0]?.url).toBe(googleFontUrl("Test Alpha", 700, "abc"));
    expect(seen[0]?.ua).toMatch(/Safari\/533/);
    expect(seen[1]?.url).toBe("https://fonts.gstatic.com/l/font?kit=abc");
  });

  it("rejects when the CSS carries no TrueType face rather than returning junk", async () => {
    const fetchImpl = (async () =>
      new Response("@font-face { src: url(x.woff2) format('woff2'); }")) as unknown as typeof fetch;
    await expect(loadCardFont("Test Beta", 400, "abc", fetchImpl)).rejects.toThrow(/No TrueType/);
  });

  it("rejects on a non-ok response instead of subsetting an error page", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(loadCardFont("Test Gamma", 400, "abc", fetchImpl)).rejects.toThrow(/503/);
  });

  it("fetches a face once per isolate — the fixed repertoire makes that one entry", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1
        ? new Response(truetypeCss("https://fonts.gstatic.com/l/font?kit=d"))
        : new Response(new Uint8Array([9]));
    }) as unknown as typeof fetch;

    await loadCardFont("Test Delta", 500, "abc", fetchImpl);
    await loadCardFont("Test Delta", 500, "abc", fetchImpl);
    // The CSS and the binary, once each — not four fetches.
    expect(calls).toBe(2);
  });

  it("does NOT memoize a failure, or one hiccup blanks every later card", async () => {
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt += 1;
      if (attempt === 1) return new Response("nope", { status: 500 });
      return attempt === 2
        ? new Response(truetypeCss("https://fonts.gstatic.com/l/font?kit=e"))
        : new Response(new Uint8Array([7]));
    }) as unknown as typeof fetch;

    await expect(loadCardFont("Test Epsilon", 400, "abc", fetchImpl)).rejects.toThrow(/500/);
    expect(new Uint8Array(await loadCardFont("Test Epsilon", 400, "abc", fetchImpl))).toStrictEqual(
      new Uint8Array([7]),
    );
  });
});

describe("first-party logo assets (#11204) — read, never fetched", () => {
  it("accepts the two shapes the registry stores and nothing else", () => {
    expect(normalizeLogoPath(`/logos/cache/${"a".repeat(64)}.png`)).toBe(
      `/logos/cache/${"a".repeat(64)}.png`,
    );
    expect(normalizeLogoPath("/logos/404-gen.png")).toBe("/logos/404-gen.png");
    expect(normalizeLogoPath("/logos/albedo.svg")).toBe("/logos/albedo.svg");
  });

  it("refuses traversal, nesting, absolute URLs and unknown extensions", () => {
    // The endpoint is public, so the param is validated here too even though
    // firstPartyLogoPath already validated it on the way out.
    expect(normalizeLogoPath("/logos/../../etc/passwd.png")).toBeNull();
    expect(normalizeLogoPath("/logos/a/b.png")).toBeNull();
    expect(normalizeLogoPath("https://evil.example/logos/x.png")).toBeNull();
    expect(normalizeLogoPath("/logos/x.js")).toBeNull();
    expect(normalizeLogoPath("/logos/CAPS.png")).toBeNull();
    expect(normalizeLogoPath(null)).toBeNull();
  });

  it("reads the asset through the ASSETS binding, not the network", async () => {
    // This Worker SERVES metagraph.sh, and a Worker fetching its own custom
    // domain gets 522 — so a plain fetch would never resolve the logo.
    const seen: string[] = [];
    const assets = {
      fetch: async (input: Request) => {
        seen.push(input.url);
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        });
      },
    };
    const uri = await resolveLocalLogo("/logos/404-gen.png", assets, "https://metagraph.sh");
    expect(uri).toBe("data:image/png;base64,AQID");
    expect(seen).toStrictEqual(["https://metagraph.sh/logos/404-gen.png"]);
  });

  it("falls through to the monogram on a miss instead of an empty tile", async () => {
    const missing = { fetch: async () => new Response("", { status: 404 }) };
    expect(await resolveLocalLogo("/logos/x.png", missing, "https://metagraph.sh")).toBeNull();
    const throwing = {
      fetch: async () => {
        throw new Error("binding exploded");
      },
    };
    expect(await resolveLocalLogo("/logos/x.png", throwing, "https://metagraph.sh")).toBeNull();
    expect(await resolveLocalLogo("/logos/x.png", null, "https://metagraph.sh")).toBeNull();
  });

  it("narrows env to a real binding, so a missing one degrades quietly", () => {
    const assets = { fetch: async () => new Response("") };
    expect(assetsBindingFrom({ ASSETS: assets })).toBe(assets);
    expect(assetsBindingFrom({})).toBeNull();
    expect(assetsBindingFrom(null)).toBeNull();
    expect(assetsBindingFrom(undefined)).toBeNull();
    expect(assetsBindingFrom({ ASSETS: { fetch: "not a function" } })).toBeNull();
  });
});

describe("static social-preview recovery", () => {
  it("reads the branded asset through ASSETS and replaces its long cache with 60 seconds", async () => {
    const bytes = readFileSync(new URL("../../public/og-fallback.png", import.meta.url));
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(bytes.readUInt32BE(16)).toBe(1200);
    expect(bytes.readUInt32BE(20)).toBe(630);
    const requests: Request[] = [];
    const response = await fallbackImageResponse(
      {
        ASSETS: {
          fetch: async (request: Request) => {
            requests.push(request);
            return new Response(bytes, {
              headers: {
                "content-type": "image/png; charset=binary",
                "cache-control": "public, max-age=31536000",
              },
            });
          },
        },
      },
      "https://metagraph.sh",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`https://metagraph.sh${OG_FALLBACK_PATH}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes));
  });

  it.each([
    ["missing binding", {}],
    [
      "lookalike MIME",
      {
        ASSETS: {
          fetch: async () =>
            new Response("not png", { headers: { "content-type": "image/pngjunk" } }),
        },
      },
    ],
    ["absent asset", { ASSETS: { fetch: async () => new Response(null, { status: 404 }) } }],
    [
      "HTML asset fallback",
      {
        ASSETS: {
          fetch: async () =>
            new Response("<html>app</html>", { headers: { "content-type": "text/html" } }),
        },
      },
    ],
    [
      "binding failure",
      {
        ASSETS: {
          fetch: async () => {
            throw new Error("Asset binding unavailable");
          },
        },
      },
    ],
  ])("returns an uncacheable unavailable result on %s", async (_label, env) => {
    const response = await fallbackImageResponse(env, "https://metagraph.sh");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).not.toBe("image/png");
  });

  it("keeps method and query guards ahead of render and fallback work", async () => {
    expect(await handleOgImage(new Request("https://metagraph.sh/unrelated"))).toBeNull();
    const method = await handleOgImage(new Request("https://metagraph.sh/og", { method: "POST" }));
    expect(method?.status).toBe(405);
    expect(method?.headers.get("allow")).toBe("GET, HEAD");
    const long = await handleOgImage(
      new Request(`https://metagraph.sh/og?title=${"x".repeat(3000)}`),
    );
    expect(long?.status).toBe(414);
    const head = await handleOgImage(new Request("https://metagraph.sh/og", { method: "HEAD" }));
    expect(head?.status).toBe(200);
    expect(head?.headers.get("content-type")).toBe("image/png");
    expect(await head?.text()).toBe("");
  });
});

describe("edge social-preview recovery", () => {
  const renderedBytes = new Uint8Array([137, 80, 78, 71, 1]);
  const fallbackBytes = new Uint8Array([137, 80, 78, 71, 2]);
  const assetFetch = () =>
    vi.fn(
      async () =>
        new Response(fallbackBytes, {
          headers: { "content-type": "image/png" },
        }),
    );

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.doUnmock("workers-og");
    vi.resetModules();
  });

  async function setup(
    options: {
      cacheReadFails?: boolean;
      cacheWriteFails?: boolean;
      fontsFail?: "all" | "one";
      renderFails?: boolean;
    } = {},
  ) {
    vi.resetModules();
    const render = vi.fn();
    vi.doMock("workers-og", () => ({
      ImageResponse: class extends Response {
        constructor(markup: string, config: unknown) {
          render(markup, config);
          if (options.renderFails) throw new Error("Rasterizer unavailable");
          super(renderedBytes, { headers: { "content-type": "image/png" } });
        }
      },
    }));
    const cache = {
      match: vi.fn(async (_request: Request): Promise<Response | undefined> => {
        if (options.cacheReadFails) throw new Error("Cache unavailable");
        return undefined;
      }),
      put: vi.fn(async (_request: Request, _response: Response) => {
        if (options.cacheWriteFails) throw new Error("Cache write unavailable");
      }),
    };
    const fontFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "fonts.googleapis.com") {
        if (
          options.fontsFail === "all" ||
          (options.fontsFail === "one" && url.searchParams.get("family") === "Geist:wght@700")
        ) {
          return new Response(null, { status: 503 });
        }
        return new Response("src: url(https://fonts.gstatic.com/fixture.ttf) format('truetype')");
      }
      if (url.href === "https://fonts.gstatic.com/fixture.ttf")
        return new Response(new Uint8Array([1, 2, 3]));
      throw new Error(`Unexpected fixture fetch: ${url.origin}${url.pathname}`);
    });
    vi.stubGlobal("caches", { default: cache });
    vi.stubGlobal("fetch", fontFetch);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const module = await import("./og-image");
    return { module, cache, render, fontFetch };
  }

  it("treats failed card and font cache reads as misses and still serves the render", async () => {
    const { module, render, fontFetch } = await setup({ cacheReadFails: true });
    const assets = assetFetch();
    const response = await module.handleOgImage(
      new Request("https://metagraph.sh/og?title=Chutes"),
      { ASSETS: { fetch: assets } },
    );
    expect(response?.status).toBe(200);
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(renderedBytes);
    expect(response?.headers.get("cache-control")).toContain("max-age=86400");
    expect(render).toHaveBeenCalledOnce();
    expect(fontFetch).toHaveBeenCalled();
    expect(assets).not.toHaveBeenCalled();
  });

  it("keeps the valid image when cache writes fail instead of serving the fallback", async () => {
    const { module, cache, render } = await setup({ cacheWriteFails: true });
    const assets = assetFetch();
    const response = await module.handleOgImage(new Request("https://metagraph.sh/og"), {
      ASSETS: { fetch: assets },
    });
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(renderedBytes);
    expect(render).toHaveBeenCalledOnce();
    expect(cache.put.mock.calls.some(([request]) => new URL(request.url).pathname === "/og")).toBe(
      true,
    );
    expect(assets).not.toHaveBeenCalled();
  });

  it("serves a short-cache branded image when every font fails, without caching it as a render", async () => {
    const { module, cache, render, fontFetch } = await setup({ fontsFail: "all" });
    const assets = assetFetch();
    const response = await module.handleOgImage(new Request("https://metagraph.sh/og"), {
      ASSETS: { fetch: assets },
    });
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(fallbackBytes);
    expect(response?.headers.get("cache-control")).toBe("public, max-age=60");
    expect(fontFetch).toHaveBeenCalledTimes(CARD_FONT_FACES.length);
    expect(assets).toHaveBeenCalledOnce();
    expect(render).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("keeps available faces when one font fails", async () => {
    const { module, render } = await setup({ fontsFail: "one" });
    const response = await module.handleOgImage(new Request("https://metagraph.sh/og"));
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(renderedBytes);
    expect(render).toHaveBeenCalledOnce();
    const config = render.mock.calls[0]?.[1] as { fonts: { name: string; weight: number }[] };
    expect(config.fonts).toHaveLength(CARD_FONT_FACES.length - 1);
    expect(config.fonts).not.toContainEqual(
      expect.objectContaining({ name: "Geist", weight: 700 }),
    );
    expect(config.fonts).toContainEqual(expect.objectContaining({ name: "Inter", weight: 700 }));
  });

  it("serves the independent asset after a rasterizer exception", async () => {
    const { module, cache } = await setup({ renderFails: true });
    const response = await module.handleOgImage(new Request("https://metagraph.sh/og"), {
      ASSETS: { fetch: assetFetch() },
    });
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(fallbackBytes);
    expect(response?.headers.get("cache-control")).toBe("public, max-age=60");
    expect(cache.put.mock.calls.some(([request]) => new URL(request.url).pathname === "/og")).toBe(
      false,
    );
  });

  it("returns no-store when rendering and the independent asset are both unavailable", async () => {
    const { module } = await setup({ fontsFail: "all" });
    const response = await module.handleOgImage(new Request("https://metagraph.sh/og"));
    expect(response?.status).toBe(503);
    expect(response?.headers.get("cache-control")).toBe("no-store");
  });

  it("uses the current design version for normalized cache lookup even for an old image URL", async () => {
    const { module, cache, fontFetch, render } = await setup();
    cache.match.mockResolvedValue(new Response(renderedBytes));
    const response = await module.handleOgImage(
      new Request(
        "https://metagraph.sh/og?title=%20Chutes%20&v=old&stat1=Netuid&stat1v=SN64&ignored=value",
        { method: "HEAD" },
      ),
    );
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("");
    const key = new URL(cache.match.mock.calls[0]![0].url);
    expect(key.searchParams.get("v")).toBe(OG_CARD_VERSION);
    expect(key.searchParams.get("title")).toBe("Chutes");
    expect(key.searchParams.get("stat1v")).toBe("SN64");
    expect(key.searchParams.has("ignored")).toBe(false);
    expect(fontFetch).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it("separates the semantic accent cache entry and ignores unsupported accents", async () => {
    const { module, cache } = await setup();
    cache.match.mockResolvedValue(new Response(renderedBytes));
    for (const suffix of ["", "&accent=agent", "&accent=constructor"])
      await module.handleOgImage(
        new Request(`https://metagraph.sh/og?title=Agents${suffix}`, { method: "HEAD" }),
      );
    const [plain, agent, ignored] = cache.match.mock.calls.map(([request]) => new URL(request.url));
    expect(agent!.searchParams.get("accent")).toBe("agent");
    expect(agent!.href).not.toBe(plain!.href);
    expect(ignored!.href).toBe(plain!.href);
  });

  it("carries the parsed page accent into the actual image render", async () => {
    const { module, render } = await setup();
    await module.handleOgImage(
      new Request("https://metagraph.sh/og?title=Agents&eyebrow=Agents&accent=agent"),
    );
    expect(render.mock.calls[0]![0]).toContain(coverMarkDataUri(true));
  });

  it("carries identifier text through the render and a distinct cache key", async () => {
    const { module, render, cache } = await setup();
    await module.handleOgImage(
      new Request("https://metagraph.sh/og?title=Example&identifier=SN19"),
    );
    expect(render.mock.calls[0]![0]).toContain(">SN19<");
    expect(new URL(cache.match.mock.calls[0]![0].url).searchParams.get("identifier")).toBe("SN19");
  });
});

describe("edge logo compatibility", () => {
  it("declines embedded bitmap SVGs so an unusable local asset can fall through", async () => {
    const assets = {
      fetch: async () =>
        new Response(
          '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/jpeg;base64,AA==" /></svg>',
          { headers: { "content-type": "image/svg+xml" } },
        ),
    };
    expect(await resolveLocalLogo("/logos/example.svg", assets, "https://metagraph.sh")).toBeNull();
  });
});
