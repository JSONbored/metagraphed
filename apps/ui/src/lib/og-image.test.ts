import { describe, expect, it } from "vitest";

import {
  glyphsForMarkup,
  iconProxyUrl,
  markDataUri,
  monogramFor,
  normalizeLogoHost,
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
      stat2v: "0.0832 τ",
      stat3: "Emission",
      stat3v: "3.41%",
      stat4: "Ignored",
      stat4v: "nope",
    });
    expect(readCardParams(p)).toEqual({
      eyebrow: "Subnet",
      logoHost: null,
      entity: false,
      status: null,
      stats: [
        { label: "Netuid", value: "SN64" },
        { label: "Price", value: "0.0832 τ" },
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

  it("returns null eyebrow and no stats when absent, so the card falls back", () => {
    expect(readCardParams(new URLSearchParams())).toEqual({
      eyebrow: null,
      stats: [],
      logoHost: null,
      entity: false,
      status: null,
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

  it("covers the UPPERCASED eyebrow, which the markup transforms", () => {
    // Regression: eyebrow "Validator" is painted "VALIDATOR". With the old
    // hand-written subset it rendered "V" + 8 tofu boxes whenever the title
    // didn't happen to supply those capitals.
    const markup = renderCardMarkup({
      title: "chutes",
      subtitle: "a subnet.",
      eyebrow: "Validator",
      stats: [],
    });
    const painted = paintedChars(markup);
    for (const ch of "VALIDATOR") {
      expect(painted.has(ch), `subset is missing "${ch}"`).toBe(true);
    }
  });

  it("covers UPPERCASED stat labels", () => {
    const markup = renderCardMarkup({
      title: "x",
      subtitle: "y",
      eyebrow: null,
      stats: [{ label: "Alpha price", value: "0.0832 τ" }],
    });
    const painted = paintedChars(markup);
    for (const ch of "ALPHA PRICE".replace(/\s/g, "")) {
      expect(painted.has(ch), `subset is missing "${ch}"`).toBe(true);
    }
  });

  it("covers the wordmark, the footer lockup, and stat values", () => {
    const markup = renderCardMarkup({
      title: "x",
      subtitle: "y",
      eyebrow: null,
      stats: [{ label: "Netuid", value: "SN64" }],
    });
    const painted = paintedChars(markup);
    for (const ch of "Metagraphedmetagraph.shSN64") {
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
    expect(markup).toContain("Rock & Roll");
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
    expect(markup).toContain(markDataUri("#5DEBBC"));
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

describe("status dot (#8489)", () => {
  it("colours the footer dot with the site's own health colour", () => {
    const markup = renderCardMarkup({
      title: "Chutes",
      subtitle: "x",
      eyebrow: "Subnet",
      stats: [],
      entity: true,
      status: "warn",
    });
    // The DARK health amber. The light theme's AA text variant (#966800) is
    // darkened to survive on paper and reads as mud on the ink foot.
    expect(markup).toContain("#FCB442");
    expect(markup).not.toContain("#966800");
  });

  it("falls back to the brand accent when no status is given", () => {
    const markup = renderCardMarkup({ title: "x", subtitle: "y", eyebrow: null, stats: [] });
    expect(markup).toContain("background:#5DEBBC;margin-right:14px");
  });

  it("never interpolates a prototype property into the card's CSS", () => {
    // `key in obj` would let ?status=constructor through and stringify a
    // function into an inline style. renderCardMarkup re-checks rather than
    // trusting its caller.
    const markup = renderCardMarkup({
      title: "x",
      subtitle: "y",
      eyebrow: null,
      stats: [],
      status: "constructor",
    });
    expect(markup).not.toContain("function");
    expect(markup).toContain("background:#5DEBBC;margin-right:14px");
  });
});

describe("three-stat rail (#8489)", () => {
  it("steps the type down at three cells so the rail still fits the band", () => {
    const three = renderCardMarkup({
      title: "Chutes",
      subtitle: "x",
      eyebrow: "Subnet",
      entity: true,
      stats: [
        { label: "Netuid", value: "SN64" },
        { label: "Price", value: "0.0832 τ" },
        { label: "Emission", value: "3.41%" },
      ],
    });
    expect(three).toContain("font-size:36px");
    expect(three).toContain("margin-right:44px");

    const two = renderCardMarkup({
      title: "Chutes",
      subtitle: "x",
      eyebrow: "Subnet",
      entity: true,
      stats: [
        { label: "Netuid", value: "SN64" },
        { label: "Price", value: "0.0832 τ" },
      ],
    });
    expect(two).toContain("font-size:42px");
    expect(two).toContain("margin-right:64px");
  });
});

describe("ink foot (#8622) — the card ends on the app's dark theme, not a white slab", () => {
  const base = { title: "Chutes", subtitle: "x", eyebrow: "Subnet", entity: true };

  it("uses the dark tokens for the whole band, including with no stats", () => {
    // Unconditional, unlike the old lifted white surface: a panel with nothing
    // in it read as a mistake, an ink band with just the lockup reads as a base.
    for (const stats of [[], [{ label: "Netuid", value: "SN64" }]]) {
      const markup = renderCardMarkup({ ...base, stats });
      expect(markup).toContain("background:#08090A;");
      expect(markup).toContain("#EFF2F6"); // --ink-strong (dark), the lockup
    }
  });

  it("puts the stat rail on the dark tokens, with mint at full strength", () => {
    const markup = renderCardMarkup({ ...base, stats: [{ label: "Netuid", value: "SN64" }] });
    expect(markup).toContain("#8A8C8F"); // --ink-muted (dark), stat labels
    expect(markup).toContain("#5DEBBC"); // --accent (dark), stat values
    // The dialled-down paper variant belongs on the bone body, never on ink.
    expect(markup).not.toContain("color:#008156;margin-top:8px");
  });

  it("puts OUR mark on an ink tile, and an entity's logo on a white one", () => {
    // Our mark is a thin stroke, so mint-on-white had too little area to carry
    // the contrast. An entity tile stays white because we do not control the
    // contrast of a third-party logo.
    const ours = renderCardMarkup({ title: "Agents", subtitle: "x", eyebrow: "Agents", stats: [] });
    expect(ours).toMatch(/border-radius:22px;margin-right:28px;margin-top:4px;background:#08090A;/);

    const theirs = renderCardMarkup({ ...base, stats: [], icon: "data:image/png;base64,AAAA" });
    expect(theirs).toMatch(/margin-top:4px;background:#FFFFFF;border:1px solid #E9EAEA;/);
  });
});
