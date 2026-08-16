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

/**
 * A route `head()` context, faked down to the fields these heads read.
 *
 * `AssetFnContextOptions` carries ten type parameters and a full router match;
 * a unit process cannot construct one, and does not need to -- these head
 * functions read `params`, `loaderData` and `match`. So the assertion IS the
 * mechanism here, the same way it is for a `KVNamespace` fixture.
 *
 * What it is not is `as never` scattered across eight call sites. `never`
 * accepts every value, so it also stopped the compiler checking the fields the
 * head function DOES read -- and one of these tests deliberately passes
 * `netuid: "not-a-number"`, which only reads as deliberate when the fake is
 * named in one place and every call site is otherwise checked.
 */
function headContext<TFields extends object>(fields: TFields): never {
  return fields as unknown as never;
}

describe("feed autodiscovery in rendered markup (#8703)", () => {
  it("the root layout advertises the registry feed as RSS and Atom", async () => {
    const head = await RootRoute.options.head?.(headContext({}));
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
    const head = await SubnetRoute.options.head?.(
      headContext({
        params: { netuid: 8 },
        loaderData: { name: "Chutes", health: "healthy" },
      }),
    );
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
    const head = await SubnetRoute.options.head?.(
      headContext({ params: { netuid: 64 }, loaderData: null }),
    );
    for (const tag of alternatesFrom((head?.links ?? []) as HeadLink[])) {
      const expectedSuffix = tag.type === "application/rss+xml" ? ".rss" : ".atom";
      expect(tag.href?.endsWith(expectedSuffix)).toBe(true);
    }
  });

  it("emits absolute hrefs a reader can resolve on its own", async () => {
    // A feed reader has no page context, so a site-relative href is unusable.
    const heads = await Promise.all([
      RootRoute.options.head?.(headContext({})),
      SubnetRoute.options.head?.(headContext({ params: { netuid: 8 }, loaderData: null })),
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
    const malformed = await SubnetRoute.options.head?.(
      headContext({ params: { netuid: "not-a-number" }, loaderData: null }),
    );
    expect(alternatesFrom((malformed?.links ?? []) as HeadLink[])).toEqual([]);

    // #11204: the absent case is signalled by the MATCH now, not by loaderData.
    // The loader throws notFound() so the SSR request answers 404 rather than
    // 200, which means head() sees a not-found match and no loader data at all.
    const missing = await SubnetRoute.options.head?.(
      headContext({ params: { netuid: 99999 }, match: { status: "notFound" } }),
    );
    expect(alternatesFrom((missing?.links ?? []) as HeadLink[])).toEqual([]);
  });

  it("renders well-formed link markup", async () => {
    const head = await RootRoute.options.head?.(headContext({}));
    const { markup } = renderAlternates((head?.links ?? []) as HeadLink[]);
    expect(markup).toContain('rel="alternate"');
    expect(markup).toContain('type="application/rss+xml"');
    // No unescaped quotes or stray angle brackets that would break the head.
    expect(markup).not.toMatch(/<link[^>]*<</);
  });
});
