import { describe, expect, it } from "vitest";

import { buildOgImageUrl, routeOwnsOgImage } from "./lib/metagraphed/og-card";
import { sitemapLastmod } from "./server";

// #8624. These are the SEO properties that were silently wrong in production and
// that nothing was asserting: every /docs/* page shared one OG card, and the
// crawler defaults that make the card render large were absent entirely.
describe("docs pages own their OG card (#8624)", () => {
  it("matches every docs page, so server.ts stops injecting the generic card", () => {
    // All 20 unfurled as `og?title=Metagraphed` before this.
    for (const p of ["/docs/economics", "/docs/accounts", "/docs/api-reference/subnets/get"]) {
      expect(routeOwnsOgImage(p), p).toBe(true);
    }
  });

  it("leaves /docs itself to the server-injected card, which has its own copy", () => {
    expect(routeOwnsOgImage("/docs")).toBe(false);
    expect(routeOwnsOgImage("/docs/")).toBe(false);
  });

  it("still matches the three entity routes and nothing else", () => {
    expect(routeOwnsOgImage("/subnets/64")).toBe(true);
    expect(routeOwnsOgImage("/validators/5Grwva")).toBe(true);
    expect(routeOwnsOgImage("/accounts/5Grwva")).toBe(true);
    for (const p of ["/", "/subnets", "/agents", "/blocks/123", "/providers/x"]) {
      expect(routeOwnsOgImage(p), p).toBe(false);
    }
  });
});

describe("sitemap lastmod (#8624)", () => {
  it("normalizes a real API timestamp to W3C Datetime", () => {
    expect(sitemapLastmod("2026-07-28T09:58:51Z")).toBe("2026-07-28T09:58:51.000Z");
  });

  it("emits NOTHING rather than a fabricated date", () => {
    // This is the property that matters. Google discounts lastmod site-wide
    // once it catches a site stamping "now" on URLs that did not change, so a
    // synthesised value would cost us the real ones too. Absent beats wrong.
    for (const bad of [undefined, null, "", "not-a-date", 1785000000000, {}]) {
      expect(sitemapLastmod(bad), String(bad)).toBeUndefined();
    }
  });
});

describe("docs cards are OURS, not an entity's (#8624)", () => {
  it("omits entity=1 so the avatar slot takes the Metagraphed mark", () => {
    // With entity=1 the renderer falls back to a monogram, so /docs/economics
    // would show "EC". A doc page is ours; the mark is the honest answer.
    const url = new URL(buildOgImageUrl({ title: "Economics", eyebrow: "Docs", entity: false }));
    expect(url.searchParams.get("entity")).toBe(null);
  });

  it("still defaults to entity=1, so the entity routes are unaffected", () => {
    const url = new URL(buildOgImageUrl({ title: "Chutes", eyebrow: "Subnet" }));
    expect(url.searchParams.get("entity")).toBe("1");
  });
});
