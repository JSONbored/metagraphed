import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  BrandIcon,
  firstPartyDisplayLogoUrl,
  providerDisplayLogoUrl,
} from "./brand-icon";

describe("firstPartyDisplayLogoUrl", () => {
  it("maps first-party top-level and cached marks to deterministic WebP derivatives", () => {
    expect(
      firstPartyDisplayLogoUrl("https://metagraph.sh/logos/chutes.png", 20),
    ).toBe("/logos/display/chutes.webp");
    expect(
      firstPartyDisplayLogoUrl(
        `https://metagraph.sh/logos/cache/${"a".repeat(64)}.svg`,
        40,
      ),
    ).toBe(`/logos/display/cache/${"a".repeat(64)}.webp`);
  });

  it("does not rewrite third-party, malformed, nested, port-qualified, or large-use sources", () => {
    const rejected = [
      "https://logos.example/chutes.png",
      "https://metagraph.sh.evil.example/logos/chutes.png",
      "https://metagraph.sh:8443/logos/chutes.png",
      "https://metagraph.sh/logos/display/chutes.webp",
      "https://metagraph.sh/logos/nested/chutes.png",
      "https://metagraph.sh/logos/chutes.pdf",
      "https://metagraph.sh/logos/chutes..png",
    ];
    for (const url of rejected)
      expect(firstPartyDisplayLogoUrl(url, 20)).toBeNull();
    expect(
      firstPartyDisplayLogoUrl("https://metagraph.sh/logos/chutes.png", 64),
    ).toBeNull();
  });

  it("renders the derivative as the first candidate while preserving fixed geometry", () => {
    const html = renderToStaticMarkup(
      h(BrandIcon, {
        iconUrl: "https://metagraph.sh/logos/chutes.png",
        name: "Chutes",
        size: 20,
      }),
    );
    expect(html).toContain('src="/logos/display/chutes.webp"');
    expect(html).toContain('width="20"');
    expect(html).toContain('height="20"');
  });
});

describe("providerDisplayLogoUrl", () => {
  it("maps a provider with a published remote mark to its committed derivative", () => {
    expect(
      providerDisplayLogoUrl(
        "404-Gen",
        "https://avatars.githubusercontent.com/u/154099142?s=200&v=4",
        20,
      ),
    ).toBe("/logos/display/404-gen.webp");
  });

  it("does not speculate without a mark or accept unsafe and oversized keys", () => {
    expect(providerDisplayLogoUrl("academia", null, 20)).toBeNull();
    expect(
      providerDisplayLogoUrl("../academia", "https://example.com/logo.png", 20),
    ).toBeNull();
    expect(
      providerDisplayLogoUrl("academia", "https://example.com/logo.png", 64),
    ).toBeNull();
  });

  it("renders a provider's local mark before its remote registry source", () => {
    const html = renderToStaticMarkup(
      h(BrandIcon, {
        iconUrl: "https://public-assets.actual.inc/red-mask-512.png",
        name: "Actual Computer",
        providerSlug: "actual-computer",
        size: 20,
      }),
    );
    expect(html).toContain('src="/logos/display/actual-computer.webp"');
  });

  it("prefers an exact cached derivative over a speculative provider-slug path", () => {
    const hash =
      "3c51fd4083332f8a4b32b2af7793b7481e9774ec8e26d40857d72a7d46a15704";
    const html = renderToStaticMarkup(
      h(BrandIcon, {
        iconUrl: `https://metagraph.sh/logos/cache/${hash}.jpg`,
        name: "ByteLeap",
        providerSlug: "byteleap",
        size: 20,
      }),
    );
    expect(html).toContain(`src="/logos/display/cache/${hash}.webp"`);
    expect(html).not.toContain("/logos/display/byteleap.webp");
  });
});
