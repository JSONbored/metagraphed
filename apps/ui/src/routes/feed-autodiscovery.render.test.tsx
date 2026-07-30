// #8703: autodiscovery verified against rendered markup, not against the JSX.
//
// WHAT THIS COVERS, PRECISELY. It calls each route's REAL `head()` — the same
// function TanStack Router calls — takes the `links` it returns, renders them
// to markup with renderToStaticMarkup, and parses the result. So it catches a
// wrong `rel`, a wrong media type, a media type paired with the wrong suffix, a
// relative href, and a head() that returns no links at all.
//
// What it does NOT cover is TanStack's own head pipeline placing those tags in
// <head> — that is framework code with its own tests, and exercising it here
// would mean standing up a full router with a loader per route. The seam this
// test guards is the one we actually own and the one that was empty: the links
// these routes declare.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Route as RootRoute } from "./__root";
import { Route as SubnetRoute } from "./subnets.$netuid";

interface HeadLink {
  rel?: string;
  type?: string;
  href?: string;
  title?: string;
}

/** Render a head()'s links exactly as tags, then read them back out. */
function renderLinks(links: HeadLink[]): {
  markup: string;
  tags: HeadLink[];
} {
  const markup = renderToStaticMarkup(
    <>
      {links.map((link, index) => (
        <link key={index} rel={link.rel} type={link.type} href={link.href} title={link.title} />
      ))}
    </>,
  );
  // Parse the MARKUP back, rather than re-reading the input objects — the point
  // is to assert on what a reader would actually receive.
  const tags: HeadLink[] = [];
  for (const match of markup.matchAll(/<link\b([^>]*)\/?>/g)) {
    const attrs: HeadLink = {};
    for (const attr of match[1].matchAll(/(\w+)="([^"]*)"/g)) {
      attrs[attr[1] as keyof HeadLink] = attr[2];
    }
    tags.push(attrs);
  }
  return { markup, tags };
}

/**
 * Render only the autodiscovery links and read them back.
 *
 * Filtered BEFORE rendering because the root layout also declares a stylesheet
 * link whose href is empty under test (the CSS asset is a build artifact), and
 * rendering it would emit a React warning unrelated to anything asserted here.
 */
function renderAlternates(links: HeadLink[]) {
  return renderLinks(links.filter((link) => link.rel === "alternate"));
}

function alternatesFrom(links: HeadLink[]) {
  return renderAlternates(links).tags;
}

describe("feed autodiscovery in rendered markup (#8703)", () => {
  it("the root layout advertises the registry feed as RSS and Atom", async () => {
    const head = await RootRoute.options.head?.({} as never);
    const alternates = alternatesFrom((head?.links ?? []) as HeadLink[]);
    expect(alternates).toHaveLength(2);
    expect(alternates.map((tag) => tag.type).sort()).toEqual([
      "application/atom+xml",
      "application/rss+xml",
    ]);
    for (const tag of alternates) {
      expect(tag.href).toContain("/api/v1/feeds/registry.");
    }
  });

  it("a subnet page advertises that subnet's own feed", async () => {
    const head = await SubnetRoute.options.head?.({
      params: { netuid: 8 },
      loaderData: { name: "Chutes", health: "healthy" },
    } as never);
    const alternates = alternatesFrom((head?.links ?? []) as HeadLink[]);
    expect(alternates).toHaveLength(2);
    for (const tag of alternates) {
      // The whole point: subnet 8's page must point at subnet 8's feed, not
      // the site-wide one.
      expect(tag.href).toContain("/api/v1/feeds/subnets/8.");
      expect(tag.title).toContain("subnet 8");
    }
  });

  it("pairs each media type with the matching suffix", async () => {
    // A reader that requests the Atom alternate and receives RSS silently
    // fails to parse it, which looks like an empty feed rather than an error.
    const head = await SubnetRoute.options.head?.({
      params: { netuid: 64 },
      loaderData: null,
    } as never);
    for (const tag of alternatesFrom((head?.links ?? []) as HeadLink[])) {
      const expectedSuffix = tag.type === "application/rss+xml" ? ".rss" : ".atom";
      expect(tag.href?.endsWith(expectedSuffix)).toBe(true);
    }
  });

  it("emits absolute hrefs a reader can resolve on its own", async () => {
    // A feed reader has no page context, so a site-relative href is unusable.
    const heads = await Promise.all([
      RootRoute.options.head?.({} as never),
      SubnetRoute.options.head?.({
        params: { netuid: 8 },
        loaderData: null,
      } as never),
    ]);
    for (const head of heads) {
      for (const tag of alternatesFrom((head?.links ?? []) as HeadLink[])) {
        expect(() => new URL(String(tag.href))).not.toThrow();
      }
    }
  });

  it("does not advertise a feed for a netuid that is not a subnet", async () => {
    // #8624 made these paths return noindex not-found metadata; handing a
    // reader a feed URL for netuid 99999 would be a permanent empty
    // subscription. Both the malformed and the absent case must stay bare.
    const malformed = await SubnetRoute.options.head?.({
      params: { netuid: "not-a-number" },
      loaderData: null,
    } as never);
    expect(alternatesFrom((malformed?.links ?? []) as HeadLink[])).toEqual([]);

    const missing = await SubnetRoute.options.head?.({
      params: { netuid: 99999 },
      loaderData: { missing: true },
    } as never);
    expect(alternatesFrom((missing?.links ?? []) as HeadLink[])).toEqual([]);
  });

  it("renders well-formed link markup", async () => {
    const head = await RootRoute.options.head?.({} as never);
    const { markup } = renderAlternates((head?.links ?? []) as HeadLink[]);
    expect(markup).toContain('rel="alternate"');
    expect(markup).toContain('type="application/rss+xml"');
    // No unescaped quotes or stray angle brackets that would break the head.
    expect(markup).not.toMatch(/<link[^>]*<</);
  });
});
