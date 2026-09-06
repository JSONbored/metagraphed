import { describe, expect, it } from "vitest";

import {
  buildOgImageUrl,
  firstPartyLogoPath,
  healthFromStatusCounts,
  logoHostFrom,
  ogImageMeta,
} from "./og-card";
import { OG_CARD_VERSION, OG_LIMITS } from "./og-card-limits";
import { clampOgText } from "./og-display-text";

describe("OG display text boundaries", () => {
  it("preserves ordinary word cuts while normalizing and keeping supplementary characters intact", () => {
    expect(clampOgText(null, 10)).toBe("");
    expect(clampOgText("  A normal title  ", 20)).toBe("A normal title");
    expect(clampOgText("A normal title is longer", 18)).toBe("A normal title…");
    expect(clampOgText("A𠮷字漢", 3)).toBe("A𠮷…");
    expect(clampOgText("한글", 2)).toBe("한글");
    expect(clampOgText("界".repeat(80), 80)).toBe("界".repeat(80));
  });
  it("normalizes all metadata image fields before a budget can split their identity", () => {
    const url = new URL(
      buildOgImageUrl({
        title: "A".repeat(108) + "𠮷漢字",
        subtitle: "한글",
        identifier: "A".repeat(78) + "𠮷漢字",
        stats: [{ label: "한", value: "글" }],
      }),
    );
    expect(url.searchParams.get("subtitle")).toBe("한글");
    expect(url.searchParams.get("stat1")).toBe("한");
    expect(url.searchParams.get("stat1v")).toBe("글");
    expect(url.searchParams.get("title")).toBe("A".repeat(108) + "𠮷…");
    expect(url.searchParams.get("identifier")).toBe("A".repeat(78) + "𠮷…");
    for (const value of url.searchParams.values()) expect(value).not.toMatch(/[\uD800-\uDFFF]/u);
  });
});

// The route → card adapters (#11204). Each one exists because the obvious
// reduction threw away the better answer; the tests below pin the case that
// motivated it, not just the happy path.

describe("firstPartyLogoPath — the registry's own curated logo", () => {
  it("accepts both shapes the registry actually stores", () => {
    // Subnets: a content-addressed cache entry (all 60 that have a logo).
    expect(firstPartyLogoPath(`https://metagraph.sh/logos/cache/${"a".repeat(64)}.png`)).toBe(
      `/logos/cache/${"a".repeat(64)}.png`,
    );
    // Providers: a slug (102 of 138).
    expect(firstPartyLogoPath("https://metagraph.sh/logos/404-gen.png")).toBe("/logos/404-gen.png");
    expect(firstPartyLogoPath("https://metagraph.sh/logos/albedo.svg")).toBe("/logos/albedo.svg");
  });

  it("takes the light/dark object form the same way BrandIcon does", () => {
    expect(firstPartyLogoPath({ light: "https://metagraph.sh/logos/adtao.png" })).toBe(
      "/logos/adtao.png",
    );
  });

  it("refuses anything that is not ours, and anything off the two shapes", () => {
    // A third-party host, even at a path that would otherwise match: the asset
    // is read from OUR ASSETS binding, so the origin is not the caller's.
    expect(firstPartyLogoPath("https://evil.example/logos/404-gen.png")).toBeNull();
    // Traversal cannot be spelled — the name charset excludes ".".
    expect(firstPartyLogoPath("https://metagraph.sh/logos/../../secret.png")).toBeNull();
    expect(firstPartyLogoPath("https://metagraph.sh/logos/nested/dir/x.png")).toBeNull();
    expect(firstPartyLogoPath("https://metagraph.sh/logos/script.svg.js")).toBeNull();
    expect(firstPartyLogoPath("https://metagraph.sh/index.html")).toBeNull();
    expect(firstPartyLogoPath(null, undefined, "")).toBeNull();
  });

  it("returns the FIRST usable candidate, so callers can pass a preference order", () => {
    expect(
      firstPartyLogoPath("https://example.com/x.png", "https://metagraph.sh/logos/almanac.png"),
    ).toBe("/logos/almanac.png");
  });
});

describe("logoHostFrom — our own host is not an identity", () => {
  it("skips a first-party logo URL so the entity's real site wins", () => {
    // This is the bug: the registry caches a subnet's logo on OUR domain, so
    // reducing it to a host asked the favicon proxy for metagraph.sh — which
    // has no icon there, so all 60 subnets with a curated logo showed a
    // monogram. The website is the next-best identity and must not be shadowed.
    expect(
      logoHostFrom(`https://metagraph.sh/logos/cache/${"b".repeat(64)}.png`, "https://chutes.ai"),
    ).toBe("chutes.ai");
  });

  it("returns null rather than our own host when there is no other candidate", () => {
    expect(logoHostFrom("https://metagraph.sh/logos/404-gen.png")).toBeNull();
  });

  it("still reduces a third-party URL, and accepts a bare host", () => {
    expect(logoHostFrom("https://Apex.Macrocosmos.ai/path?q=1")).toBe("apex.macrocosmos.ai");
    expect(logoHostFrom("chutes.ai")).toBe("chutes.ai");
    expect(logoHostFrom("not a url", "https://tao.bot")).toBe("tao.bot");
  });
});

describe("healthFromStatusCounts — a summary of probe verdicts, not a judgement", () => {
  it("summarizes the three cases", () => {
    expect(healthFromStatusCounts({ ok: 8 })).toBe("ok");
    expect(healthFromStatusCounts({ ok: 6, down: 2 })).toBe("warn");
    expect(healthFromStatusCounts({ down: 3 })).toBe("down");
  });

  it("preserves warning observations instead of relabeling them as failed", () => {
    expect(healthFromStatusCounts({ degraded: 3 })).toBe("warn");
    expect(healthFromStatusCounts({ warn: 3 })).toBe("warn");
    expect(healthFromStatusCounts({ degraded: 1, failed: 2 })).toBe("warn");
    expect(healthFromStatusCounts({ failed: 3 })).toBe("down");
    expect(healthFromStatusCounts({ ok: 1, failed: 2 })).toBe("warn");
  });

  it("declines incomplete or unrecognized positive evidence instead of inventing a verdict", () => {
    for (const unknown of ["unknown", "not_monitored", "pending", "constructor", "other"]) {
      expect(healthFromStatusCounts({ [unknown]: 3 }), unknown).toBeNull();
      expect(healthFromStatusCounts({ ok: 1, [unknown]: 3 }), unknown).toBeNull();
    }
    expect(healthFromStatusCounts({ ok: 1, unknown: 0 })).toBe("ok");
  });

  it("declines to answer when there is nothing to summarize", () => {
    // Null, not "unknown": the card falls back to its brand bullet rather than
    // asserting a health state nothing measured.
    expect(healthFromStatusCounts(null)).toBeNull();
    expect(healthFromStatusCounts(undefined)).toBeNull();
    expect(healthFromStatusCounts({})).toBeNull();
    expect(healthFromStatusCounts({ ok: 0, down: 0 })).toBeNull();
  });

  it("ignores non-numeric counts rather than counting them as endpoints", () => {
    expect(healthFromStatusCounts({ ok: 4, bogus: Number.NaN } as Record<string, number>)).toBe(
      "ok",
    );
  });
});

describe("buildOgImageUrl", () => {
  it("carries a named semantic accent without adding it to unrelated page cards", () => {
    const url = new URL(buildOgImageUrl({ title: "Agents", entity: false, accent: "agent" }));
    expect(url.searchParams.get("accent")).toBe("agent");
    expect(
      new URL(buildOgImageUrl({ title: "API reference", entity: false })).searchParams.has(
        "accent",
      ),
    ).toBe(false);
  });

  it("publishes the renderer version in every externally shared image URL", () => {
    for (const options of [
      { title: "Metagraphed", entity: false },
      { title: "Chutes", stats: [{ label: "Netuid", value: "SN64" }] },
      { title: "API reference", eyebrow: "Docs", entity: false },
    ]) {
      const url = new URL(buildOgImageUrl(options));
      expect(url.origin).toBe("https://metagraph.sh");
      expect(url.pathname).toBe("/og");
      expect(url.searchParams.getAll("v")).toEqual([OG_CARD_VERSION]);
      expect(url.searchParams.get("title")).toBe(options.title);
    }
  });

  it("carries the first-party logo path as logop, which the renderer prefers", () => {
    const url = new URL(
      buildOgImageUrl({ title: "404-GEN", logoPath: "/logos/404-gen.png", entity: true }),
    );
    expect(url.searchParams.get("logop")).toBe("/logos/404-gen.png");
  });

  it("omits every absent field so the card's own fallbacks apply", () => {
    const url = new URL(buildOgImageUrl({ title: "Chutes" }));
    expect(url.searchParams.get("logop")).toBeNull();
    expect(url.searchParams.get("logo")).toBeNull();
    expect(url.searchParams.get("status")).toBeNull();
  });

  it("clamps every field, so the URL says only what the card will paint", () => {
    const url = new URL(
      buildOgImageUrl({
        title: "t".repeat(500),
        subtitle: "s".repeat(500),
        eyebrow: "e".repeat(500),
        identifier: "i".repeat(500),
        stats: [{ label: "l".repeat(500), value: "v".repeat(500) }],
      }),
    );
    expect(url.searchParams.get("title")).toHaveLength(OG_LIMITS.title);
    expect(url.searchParams.get("subtitle")).toHaveLength(OG_LIMITS.subtitle);
    expect(url.searchParams.get("eyebrow")).toHaveLength(OG_LIMITS.eyebrow);
    expect(url.searchParams.get("identifier")).toHaveLength(OG_LIMITS.identifier);
    expect(url.searchParams.get("stat1")).toHaveLength(OG_LIMITS.statLabel);
    expect(url.searchParams.get("stat1v")).toHaveLength(OG_LIMITS.statValue);
  });

  it("preserves a wide identifier within the encoded query budget", () => {
    const input = {
      title: "界".repeat(110),
      subtitle: "界".repeat(70),
      identifier: "界".repeat(80),
      entity: true,
    };
    const url = new URL(buildOgImageUrl(input));
    expect(url.search.length).toBeLessThanOrEqual(OG_LIMITS.query);
    expect(url.searchParams.get("title")).toBe(input.title);
    expect(url.searchParams.get("subtitle")).toBe(input.subtitle);
    expect(url.searchParams.get("identifier")).toBe(input.identifier);
    expect(url.searchParams.get("identifier")).not.toContain("�");
  });

  it("cannot build a URL the renderer would refuse, even at every field's cap", () => {
    // The regression this guards: /og answers 414 over OG_LIMITS.query and the
    // page unfurls with NO image. Adding the first-party logo path took the
    // worst legitimate card to 548 characters against a 512 cap.
    const url = new URL(
      buildOgImageUrl({
        title: "𠮷".repeat(OG_LIMITS.title),
        subtitle: "𠮷".repeat(OG_LIMITS.subtitle),
        eyebrow: "𠮷".repeat(OG_LIMITS.eyebrow),
        identifier: "𠮷".repeat(OG_LIMITS.identifier),
        logoPath: `/logos/cache/${"c".repeat(64)}.webp`,
        logoHost: `${"h".repeat(OG_LIMITS.logoHost - 4)}.com`,
        status: "degraded",
        accent: "agent",
        entity: true,
        stats: [1, 2, 3].map(() => ({
          label: "𠮷".repeat(OG_LIMITS.statLabel),
          value: "𠮷".repeat(OG_LIMITS.statValue),
        })),
      }),
    );
    expect(url.search.length).toBeGreaterThan(5616);
    expect(url.search.length).toBeLessThan(6000);
    expect(url.search.length).toBeLessThanOrEqual(OG_LIMITS.query);
    expect(Array.from(url.searchParams.get("identifier")!)).toHaveLength(OG_LIMITS.identifier);
  });
});

describe("ogImageMeta", () => {
  it("emits the alt text a route-owned card was silently missing", () => {
    // Only the server-injected card carried og:image:alt, so every page that
    // took ownership of its own card lost what a screen reader announces.
    const meta = ogImageMeta({ title: "Chutes", subtitle: "SN64 — compute" });
    expect(meta).toContainEqual({ property: "og:image:alt", content: "Chutes — SN64 — compute" });
    expect(meta).toContainEqual({ name: "twitter:image:alt", content: "Chutes — SN64 — compute" });
  });

  it("falls back to the title alone when there is no subtitle", () => {
    const meta = ogImageMeta({ title: "Chutes" });
    expect(meta).toContainEqual({ property: "og:image:alt", content: "Chutes" });
  });

  it("describes the same bounded title and subtitle that the image URL carries", () => {
    const meta = ogImageMeta({ title: "T".repeat(200), subtitle: "S".repeat(200) });
    const image = meta.find((tag) => "property" in tag && tag.property === "og:image");
    const params = new URL(image!.content).searchParams;
    const alt = `${params.get("title")} — ${params.get("subtitle")}`;
    expect(meta).toContainEqual({ property: "og:image:alt", content: alt });
    expect(meta).toContainEqual({ name: "twitter:image:alt", content: alt });
    expect(alt).toHaveLength(OG_LIMITS.title + OG_LIMITS.subtitle + 3);
  });

  it("points every image tag at the same card", () => {
    const meta = ogImageMeta({ title: "Chutes" });
    const urls = new Set(
      meta
        .filter((tag) => "property" in tag || tag.name === "twitter:image")
        .map((tag) => tag.content)
        .filter((content) => content.includes("/og?")),
    );
    expect(urls.size).toBe(1);
    expect(new URL([...urls][0]!).searchParams.get("v")).toBe(OG_CARD_VERSION);
  });
});
