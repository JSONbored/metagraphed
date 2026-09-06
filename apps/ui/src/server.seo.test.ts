import { describe, expect, it } from "vitest";

import { buildOgImageUrl, routeOwnsOgImage } from "./lib/metagraphed/og-card";
import { subnetDatasetJsonLd, validatorDatasetJsonLd } from "./lib/metagraphed/json-ld";
import {
  buildJsonLd,
  handleArtifactHostRedirect,
  SEO_DEFAULT_TAGS,
  sitemapLastmod,
} from "./server";

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

  it("respects both splat routes on their bare hubs and trailing-slash forms", () => {
    for (const path of ["/docs", "/docs/", "/news", "/news/", "/news/network/2026-w03"]) {
      expect(routeOwnsOgImage(path), path).toBe(true);
    }
    for (const path of ["/docs-other", "/newsroom", "/news-other/page"]) {
      expect(routeOwnsOgImage(path), path).toBe(false);
    }
  });

  it("gives event detail cards to the data-owning route, including index zero", () => {
    expect(routeOwnsOgImage("/events/8713384/0")).toBe(true);
    expect(routeOwnsOgImage("/events/8713384/320/")).toBe(true);
    expect(routeOwnsOgImage("/events")).toBe(false);
    expect(routeOwnsOgImage("/chain/events")).toBe(false);
  });

  it("still matches the entity detail routes and nothing else", () => {
    expect(routeOwnsOgImage("/subnets/64")).toBe(true);
    expect(routeOwnsOgImage("/validators/5Grwva")).toBe(true);
    expect(routeOwnsOgImage("/accounts/5Grwva")).toBe(true);
    // #11204: providers joined them. Their 138 pages were unfurling the raw
    // slug with no logo and no counts, from the pathname alone.
    expect(routeOwnsOgImage("/providers/latent")).toBe(true);
    expect(routeOwnsOgImage("/blocks/123")).toBe(true);
    expect(routeOwnsOgImage("/blocks/0xabc/")).toBe(true);
    expect(routeOwnsOgImage("/extrinsics/123-0")).toBe(true);
    // The hub is not a detail page and keeps its section copy.
    for (const p of [
      "/",
      "/subnets",
      "/agents",
      "/blocks",
      "/extrinsics",
      "/providers",
      "/apis/providers",
    ]) {
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

describe("site-wide JSON-LD graph (#11204)", () => {
  const graphOf = (pathname: string) =>
    JSON.parse(buildJsonLd(pathname))["@graph"] as Array<Record<string, unknown>>;
  const typesOn = (pathname: string) => graphOf(pathname).map((node) => node["@type"]);
  const breadcrumbOn = (pathname: string) =>
    graphOf(pathname).find((node) => node["@type"] === "BreadcrumbList") as
      { itemListElement: Array<{ position: number; name: string; item: string }> } | undefined;

  it("carries Organization and WebSite on every page", () => {
    for (const path of ["/", "/subnets", "/docs/economics", "/validators/5Grwva"]) {
      expect(typesOn(path), path).toEqual(expect.arrayContaining(["Organization", "WebSite"]));
    }
  });

  it("claims only profiles this project controls via sameAs", () => {
    // A sameAs is an identity assertion: a wrong one merges this entity with
    // someone else's in a knowledge graph.
    const org = graphOf("/").find((node) => node["@type"] === "Organization");
    expect(org?.sameAs).toEqual([
      "https://github.com/JSONbored/metagraphed",
      "https://x.com/metagraphed",
    ]);
  });

  it("breadcrumbs the validator pages, which are the biggest indexed set", () => {
    // 1,023 validator URLs are in the sitemap and every one of them emitted no
    // breadcrumb, which is most of why Search Console saw ONE valid item
    // site-wide. The hotkey is truncated rather than shown in full.
    const crumb = breadcrumbOn("/validators/5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
    expect(crumb?.itemListElement.map((entry) => entry.name)).toEqual([
      "Home",
      "Validators",
      "5Grwva…GKutQY",
    ]);
  });

  it("breadcrumbs docs pages one level per path segment", () => {
    const crumb = breadcrumbOn("/docs/api-reference/subnets");
    expect(crumb?.itemListElement.map((entry) => entry.name)).toEqual([
      "Home",
      "Docs",
      "API reference",
      "Subnets",
    ]);
    // Every `item` must be absolute — a crawler cannot resolve a relative one.
    for (const entry of crumb?.itemListElement ?? []) {
      expect(() => new URL(entry.item)).not.toThrow();
    }
  });

  it("breadcrumbs the weekly digests, which render a crumb row and emitted no node", () => {
    // #11303: 285 digest URLs -- 15% of the sitemap -- painted a breadcrumb the
    // reader can see while emitting no BreadcrumbList, because they shipped
    // (#8705) after this function was written. The structured data has to agree
    // with what is on screen, which is the rule every builder here ships under.
    const crumb = breadcrumbOn("/news/sn38/2026-w25");
    expect(crumb?.itemListElement.map((entry) => entry.name)).toEqual([
      "Home",
      "News",
      "SN38",
      "2026-W25",
    ]);
    expect(crumb?.itemListElement.map((entry) => entry.item)).toEqual([
      "https://metagraph.sh/",
      "https://metagraph.sh/news",
      "https://metagraph.sh/news/sn38",
      "https://metagraph.sh/news/sn38/2026-w25",
    ]);
  });

  it("labels a digest segment the way the site writes it, not the way the URL does", () => {
    // `Sn38` and `2026 w25` are what the generic slug rule produces, and the
    // site writes neither. A crumb that renames the thing it points at is a
    // crumb Google reports as not matching the page.
    expect(breadcrumbOn("/news/network/2026-w03")?.itemListElement.map((e) => e.name)).toEqual([
      "Home",
      "News",
      "Network",
      "2026-W03",
    ]);
    // The docs trail must be untouched by those two new rules.
    expect(breadcrumbOn("/docs/api-reference/subnets")?.itemListElement.map((e) => e.name)).toEqual(
      ["Home", "Docs", "API reference", "Subnets"],
    );
  });

  it("still breadcrumbs subnets and providers", () => {
    expect(breadcrumbOn("/subnets/64")?.itemListElement).toHaveLength(3);
    expect(breadcrumbOn("/providers/chutes")?.itemListElement).toHaveLength(3);
  });

  it("emits no breadcrumb on pages that are not a detail view", () => {
    // A one-item "trail" on a hub page is noise, and Google flags a breadcrumb
    // that does not describe a real position in the hierarchy.
    for (const path of ["/", "/subnets", "/validators", "/docs", "/news"]) {
      expect(breadcrumbOn(path), path).toBeUndefined();
    }
  });

  it("escapes a crafted path segment so it cannot break out of the script", () => {
    const serialized = buildJsonLd("/subnets/</script><script>alert(1)</script>");
    expect(serialized).not.toContain("</script>");
    expect(serialized).not.toContain("<");
  });
});

describe("apex /metagraph/* redirects to the host that serves it (#11204)", () => {
  const get = (url: string, method = "GET") =>
    handleArtifactHostRedirect(new Request(url, { method }));

  it("301s an artifact path to api.metagraph.sh", () => {
    // 82 of the site's 83 Search Console crawl errors were this one prefix.
    const res = get("https://metagraph.sh/metagraph/subnets.json");
    expect(res?.status).toBe(301);
    expect(res?.headers.get("location")).toBe("https://api.metagraph.sh/metagraph/subnets.json");
  });

  it("carries the query string across the hop", () => {
    const res = get("https://metagraph.sh/metagraph/fixtures/x.json?pretty=1");
    expect(res?.headers.get("location")).toBe(
      "https://api.metagraph.sh/metagraph/fixtures/x.json?pretty=1",
    );
  });

  it("covers the bare prefix as well as paths under it", () => {
    expect(get("https://metagraph.sh/metagraph")?.status).toBe(301);
  });

  it("leaves every other path to the SSR app", () => {
    // The guard that matters: a page route must never be redirected to the API
    // host. `/metagraphed` is the near-miss that a `startsWith("/metagraph")`
    // test would have swallowed.
    for (const p of ["/", "/subnets", "/subnets/1", "/metagraphed", "/metagraphs", "/docs"]) {
      expect(get(`https://metagraph.sh${p}`), p).toBeNull();
    }
  });

  it("redirects HEAD but leaves non-idempotent methods alone", () => {
    expect(get("https://metagraph.sh/metagraph/subnets.json", "HEAD")?.status).toBe(301);
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect(get("https://metagraph.sh/metagraph/subnets.json", method), method).toBeNull();
    }
  });
});

describe("site-wide crawler + attribution defaults (#8626)", () => {
  it("carries the directives the OG cards depend on, and the X attribution", () => {
    // max-image-preview:large is the load-bearing one: without it Google caps
    // the preview to a thumbnail, which wastes the per-page card programme.
    expect(SEO_DEFAULT_TAGS).toContain("max-image-preview:large");
    expect(SEO_DEFAULT_TAGS).toContain('name="robots"');
    expect(SEO_DEFAULT_TAGS).toContain('content="en_US"');
    expect(SEO_DEFAULT_TAGS).toContain('name="twitter:site" content="@metagraphed"');
    expect(SEO_DEFAULT_TAGS).toContain('name="twitter:creator" content="@metagraphed"');
  });

  it("never emits noindex itself — a route's own noindex must be free to win", () => {
    // Crawlers take the most restrictive directive when tags conflict, so this
    // block sitting alongside entityNotFoundMeta's `noindex` is safe. It would
    // NOT be safe the other way round.
    expect(SEO_DEFAULT_TAGS).not.toContain("noindex");
  });
});

describe("registry records assert their own freshness (#11314)", () => {
  const graphOf = (node: unknown) => node as Record<string, unknown>;

  it("emits dateModified when the record carries a publish timestamp", () => {
    // We probe every surface every 15 minutes and, before this, asserted that
    // freshness in exactly one route family (/docs, #11259). Against competitor
    // content dated months ago, live data is the whole advantage.
    const node = graphOf(
      subnetDatasetJsonLd({
        netuid: 64,
        name: "Chutes",
        url: "https://metagraph.sh/subnets/64",
        apiUrl: "https://api.metagraph.sh/api/v1/subnets/64",
        artifactUrl: "https://api.metagraph.sh/metagraph/subnets/64.json",
        dateModified: "2026-08-14T12:14:17.177Z",
      }),
    );
    expect(node.dateModified).toBe("2026-08-14T12:14:17.177Z");
  });

  it("omits dateModified entirely rather than inventing one", () => {
    // Absent beats wrong: an undated record is honest, a record dated "now" on
    // every request is the abuse that gets lastmod discounted site-wide.
    for (const bad of [undefined, null, "", "not-a-date"]) {
      const node = graphOf(
        subnetDatasetJsonLd({
          netuid: 64,
          url: "https://metagraph.sh/subnets/64",
          apiUrl: "https://api.metagraph.sh/api/v1/subnets/64",
          artifactUrl: "https://api.metagraph.sh/metagraph/subnets/64.json",
          dateModified: bad as string | null | undefined,
        }),
      );
      expect(node, String(bad)).not.toHaveProperty("dateModified");
    }
  });

  it("applies the same rule the sitemap does", () => {
    // One rule, two consumers. A page whose dateModified and whose sitemap
    // lastmod disagree makes two different claims about one fact — which is
    // how metaDescription, the breadcrumb list and the OG card each drifted.
    const value = "2026-08-14T12:15:22Z";
    const node = graphOf(
      subnetDatasetJsonLd({
        netuid: 1,
        url: "https://metagraph.sh/subnets/1",
        apiUrl: "https://api.metagraph.sh/api/v1/subnets/1",
        artifactUrl: "https://api.metagraph.sh/metagraph/subnets/1.json",
        dateModified: value,
      }),
    );
    expect(node.dateModified).toBe(sitemapLastmod(value));
  });
});

describe("validator records are typed, not just breadcrumbed (#11313)", () => {
  it("names the operator when the chain carries an identity", () => {
    // 1,023 URLs -- 53% of the sitemap -- carried a BreadcrumbList and nothing
    // else. The largest structured-data gap on the site.
    const node = validatorDatasetJsonLd({
      hotkey: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      name: "Datura",
      subnetCount: 12,
      dateModified: "2026-08-14T12:14:17.177Z",
    }) as Record<string, unknown>;
    expect(node["@type"]).toBe("Dataset");
    expect(node.name).toBe("Datura — Bittensor validator");
    expect(node.identifier).toBe("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
    expect(node.url).toBe(
      "https://metagraph.sh/validators/5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    );
    expect(node.dateModified).toBe("2026-08-14T12:14:17.177Z");
  });

  it("does not invent a name for a hotkey with no declared identity", () => {
    // 424 of 1,022 have no coldkey_identity.name. Naming them anything is a
    // claim about someone's business that the chain does not support.
    const node = validatorDatasetJsonLd({ hotkey: "5Grwva" }) as Record<string, unknown>;
    expect(node.name).toBe("Bittensor validator record");
    expect(node).not.toHaveProperty("dateModified");
  });

  it("puts the record in the same catalog as every other registry record", () => {
    // What makes 1,023 Datasets one catalog rather than 1,023 loose files.
    const node = validatorDatasetJsonLd({ hotkey: "5Grwva" }) as Record<string, unknown>;
    expect(node.includedInDataCatalog).toBeTruthy();
    expect(node.publisher).toBeTruthy();
  });
});
