import { describe, expect, it } from "vitest";

import {
  apiRecordUrl,
  breadcrumbListJsonLd,
  JSONLD_IDS,
  siteGraphNodes,
  stringifyJsonLd,
  providerDatasetJsonLd,
  subnetDatasetJsonLd,
  techArticleJsonLd,
} from "./json-ld";

describe("stringifyJsonLd (#11204)", () => {
  it("neutralizes a script break-out in any string it serializes", () => {
    // The attack this exists for: a path segment or subnet name containing
    // </script> would otherwise end the element and everything after it is
    // markup, not data.
    const out = stringifyJsonLd({ name: "</script><img src=x onerror=alert(1)>" });
    expect(out).not.toContain("</script>");
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).toContain("\\u003c");
  });

  it("escapes the JavaScript line terminators that are legal inside JSON", () => {
    // U+2028/U+2029 parse fine as JSON but terminate a line inside a <script>,
    // so an unescaped one is a syntax error in the page rather than in the data.
    //
    // Built from escapes rather than pasted: as raw characters these are
    // invisible here, so a future edit could drop one and leave the assertions
    // below passing against a string that no longer contains what they test.
    const LINE_SEPARATOR = "\u2028";
    const PARAGRAPH_SEPARATOR = "\u2029";
    const out = stringifyJsonLd({ name: `a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c` });
    expect(out).toContain("\\u2028");
    expect(out).toContain("\\u2029");
    expect(out).not.toContain(LINE_SEPARATOR);
    expect(out).not.toContain(PARAGRAPH_SEPARATOR);
  });

  it("still round-trips to the original value", () => {
    // Escaping must not change what a consumer reads back.
    const value = { name: "A & B <c>", nested: { list: [1, 2] } };
    expect(JSON.parse(stringifyJsonLd(value))).toEqual(value);
  });
});

describe("breadcrumbListJsonLd (#11204)", () => {
  it("numbers positions from 1 in trail order", () => {
    const crumbs = [
      { name: "Home", item: "https://metagraph.sh/" },
      { name: "Subnets", item: "https://metagraph.sh/subnets" },
      { name: "Subnet 1", item: "https://metagraph.sh/subnets/1" },
    ];
    const out = breadcrumbListJsonLd(crumbs);
    expect(out["@type"]).toBe("BreadcrumbList");
    expect(out.itemListElement.map((entry) => entry.position)).toEqual([1, 2, 3]);
    expect(out.itemListElement.map((entry) => entry.name)).toEqual(["Home", "Subnets", "Subnet 1"]);
  });

  it("emits an empty list rather than throwing on no crumbs", () => {
    expect(breadcrumbListJsonLd([]).itemListElement).toEqual([]);
  });
});

describe("subnetDatasetJsonLd (#11204)", () => {
  const base = {
    netuid: 1,
    url: "https://metagraph.sh/subnets/1",
    apiUrl: "https://api.metagraph.sh/api/v1/subnets/1",
    artifactUrl: "https://api.metagraph.sh/metagraph/subnets/1.json",
  };

  it("names the subnet and keeps the netuid as the identifier", () => {
    const out = subnetDatasetJsonLd({ ...base, name: "Apex" });
    expect(out["@type"]).toBe("Dataset");
    expect(out.name).toBe("Apex (Subnet 1)");
    // The identifier must stay the netuid: it is the stable on-chain key, and
    // the term a reader searches. A name can change; netuid 1 cannot.
    expect(out.identifier).toBe("1");
  });

  it("still produces a valid node for a subnet with no name or description", () => {
    const out = subnetDatasetJsonLd(base);
    expect(out.name).toBe("Subnet 1");
    expect(out.description).toContain("Bittensor subnet 1");
  });

  it("points distribution at both machine-readable representations", () => {
    // This is what earns the markup — a Dataset with no distribution is just a
    // description of a page.
    const out = subnetDatasetJsonLd(base);
    expect(out.distribution.map((d) => d.contentUrl)).toEqual([base.apiUrl, base.artifactUrl]);
    for (const dist of out.distribution) {
      expect(dist.encodingFormat).toBe("application/json");
    }
  });

  it("omits sameAs entirely rather than asserting an empty identity", () => {
    // An empty or wrong sameAs attaches this record to another project, which
    // is worse than claiming nothing.
    expect(subnetDatasetJsonLd(base)).not.toHaveProperty("sameAs");
    expect(subnetDatasetJsonLd({ ...base, sameAs: null })).not.toHaveProperty("sameAs");
    expect(subnetDatasetJsonLd({ ...base, sameAs: "https://example.com" })).toHaveProperty(
      "sameAs",
      ["https://example.com"],
    );
  });

  it("REFERENCES the site's organization and catalog instead of restating them", () => {
    // Before: an inline `creator: { "@type": "Organization", ... }` on all 129
    // subnet pages, which minted a second publisher unrelated to the site's own
    // and left every Dataset an island. The @id references are what merge the
    // route's block with the server-injected one into a single graph.
    const out = subnetDatasetJsonLd(base) as unknown as Record<string, unknown>;
    expect(out.creator).toStrictEqual({ "@id": JSONLD_IDS.org });
    expect(out.publisher).toStrictEqual({ "@id": JSONLD_IDS.org });
    expect(out.includedInDataCatalog).toStrictEqual({ "@id": JSONLD_IDS.catalog });
    // And the referenced nodes must actually be declared on the page.
    const ids = (siteGraphNodes() as Array<Record<string, unknown>>).map((node) => node["@id"]);
    expect(ids).toContain(JSONLD_IDS.org);
    expect(ids).toContain(JSONLD_IDS.catalog);
  });

  it("prefers the subnet's own description but ignores a blank one", () => {
    expect(subnetDatasetJsonLd({ ...base, description: "Open competitions." }).description).toBe(
      "Open competitions.",
    );
    expect(subnetDatasetJsonLd({ ...base, description: "   " }).description).toContain(
      "Registry record",
    );
  });
});

describe("siteGraphNodes (#11204) — one graph, one publisher", () => {
  const nodes = () => siteGraphNodes() as Array<Record<string, unknown>>;
  const byId = (id: string) => nodes().find((node) => node["@id"] === id);

  it("declares each site-wide node exactly once, with a stable @id", () => {
    const ids = nodes().map((node) => node["@id"]);
    expect(ids).toStrictEqual([
      JSONLD_IDS.org,
      JSONLD_IDS.website,
      JSONLD_IDS.catalog,
      JSONLD_IDS.restApi,
      JSONLD_IDS.mcp,
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("REFERENCES the organization rather than restating it", () => {
    // The defect this replaces: server.ts open-coded an Organization and the
    // subnet route open-coded a second one inside its Dataset, so every subnet
    // page described two unrelated publishers and linked neither.
    for (const id of [JSONLD_IDS.website, JSONLD_IDS.catalog]) {
      expect(byId(id)?.publisher).toStrictEqual({ "@id": JSONLD_IDS.org });
    }
    for (const id of [JSONLD_IDS.restApi, JSONLD_IDS.mcp]) {
      expect(byId(id)?.provider).toStrictEqual({ "@id": JSONLD_IDS.org });
    }
  });

  it("gives an AI crawler a typed pointer to the MCP server", () => {
    // The whole point for answer engines: a crawler on any page learns, in
    // machine-readable form, that this data is reachable over MCP.
    const mcp = byId(JSONLD_IDS.mcp);
    expect(mcp?.["@type"]).toBe("WebAPI");
    expect(mcp?.url).toBe("https://api.metagraph.sh/mcp");
    expect(mcp?.documentation).toBe("https://metagraph.sh/docs/mcp");
    // The descriptor, not a restated tool list — that changes every release.
    expect(mcp?.sameAs).toStrictEqual([
      "https://api.metagraph.sh/.well-known/mcp/server-card.json",
    ]);
  });

  it("claims software only for services we actually operate", () => {
    // Describing a third-party subnet's API as an application we vouch for
    // would be an over-claim; describing OUR OWN is exactly what we may say.
    for (const id of [JSONLD_IDS.restApi, JSONLD_IDS.mcp]) {
      expect(String(byId(id)?.url)).toContain("api.metagraph.sh");
    }
  });

  it("exposes semantic search as the catalog's action, not keyword search", () => {
    const target = (byId(JSONLD_IDS.catalog)?.potentialAction as Record<string, unknown>)
      ?.target as Record<string, unknown>;
    expect(String(target?.urlTemplate)).toContain("/api/v1/search/semantic?q={search_term_string}");
  });
});

describe("apiRecordUrl (#11204) — the machine-readable copy of a page", () => {
  it("maps every entity detail route to its verified API record", () => {
    // Each of these answers 200 on the live API; an alternate pointing at a
    // 404 is worse than none, because it advertises a format that isn't there.
    expect(apiRecordUrl("/subnets/64")).toBe("https://api.metagraph.sh/api/v1/subnets/64");
    expect(apiRecordUrl("/validators/5Grwva")).toBe(
      "https://api.metagraph.sh/api/v1/validators/5Grwva",
    );
    expect(apiRecordUrl("/accounts/5Grwva")).toBe(
      "https://api.metagraph.sh/api/v1/accounts/5Grwva",
    );
    expect(apiRecordUrl("/providers/404-gen")).toBe(
      "https://api.metagraph.sh/api/v1/providers/404-gen",
    );
    expect(apiRecordUrl("/blocks/8725436")).toBe("https://api.metagraph.sh/api/v1/blocks/8725436");
    expect(apiRecordUrl("/extrinsics/0xabc")).toBe(
      "https://api.metagraph.sh/api/v1/extrinsics/0xabc",
    );
  });

  it("maps the hubs to their collection routes, including /apis/providers", () => {
    expect(apiRecordUrl("/subnets")).toBe("https://api.metagraph.sh/api/v1/subnets");
    expect(apiRecordUrl("/validators/")).toBe("https://api.metagraph.sh/api/v1/validators");
    expect(apiRecordUrl("/apis/providers")).toBe("https://api.metagraph.sh/api/v1/providers");
  });

  it("returns null for pages that are not one record", () => {
    for (const path of ["/", "/docs", "/docs/mcp", "/agents", "/subnets/64/history", "/status"]) {
      expect(apiRecordUrl(path), path).toBeNull();
    }
  });

  it("does not re-encode a segment the pathname already encoded", () => {
    // Double-encoding would produce %2520 and a 404 on an otherwise valid key.
    expect(apiRecordUrl("/accounts/5Grwva%20x")).toBe(
      "https://api.metagraph.sh/api/v1/accounts/5Grwva%20x",
    );
  });
});

describe("techArticleJsonLd (#11204) — the pages an answer engine quotes", () => {
  const base = { headline: "MCP", url: "https://metagraph.sh/docs/mcp" };

  it("ties the prose to the catalog it documents", () => {
    // `about` is what lets a consumer follow a quoted sentence back to the
    // machine-readable record, and from there to the REST and MCP endpoints.
    const out = techArticleJsonLd(base) as unknown as Record<string, unknown>;
    expect(out["@type"]).toBe("TechArticle");
    expect(out.about).toStrictEqual({ "@id": JSONLD_IDS.catalog });
    expect(out.isPartOf).toStrictEqual({ "@id": JSONLD_IDS.website });
    expect(out.author).toStrictEqual({ "@id": JSONLD_IDS.org });
    expect(out.publisher).toStrictEqual({ "@id": JSONLD_IDS.org });
    expect(out.mainEntityOfPage).toBe(base.url);
  });

  it("omits a blank description rather than emitting an empty string", () => {
    expect(techArticleJsonLd(base)).not.toHaveProperty("description");
    expect(techArticleJsonLd({ ...base, description: "   " })).not.toHaveProperty("description");
    expect(techArticleJsonLd({ ...base, description: " Tools. " })).toHaveProperty(
      "description",
      "Tools.",
    );
  });

  it("asserts no dateModified, because the loader carries no timestamp", () => {
    // A made-up date is a freshness claim we cannot support.
    expect(techArticleJsonLd(base)).not.toHaveProperty("dateModified");
    expect(techArticleJsonLd(base)).not.toHaveProperty("datePublished");
  });

  it("references only nodes the page actually declares", () => {
    const declared = new Set(
      (siteGraphNodes() as Array<Record<string, unknown>>).map((node) => node["@id"]),
    );
    const article = techArticleJsonLd(base) as unknown as Record<string, unknown>;
    for (const key of ["about", "isPartOf", "author", "publisher"]) {
      expect(declared).toContain((article[key] as { "@id": string })["@id"]);
    }
  });
});

describe("providerDatasetJsonLd (#11204) — 138 records that had no node", () => {
  const base = {
    slug: "404-gen",
    url: "https://metagraph.sh/providers/404-gen",
    apiUrl: "https://api.metagraph.sh/api/v1/providers/404-gen",
    artifactUrl: "https://api.metagraph.sh/metagraph/providers/404-gen.json",
  };

  it("carries the same catalog wiring the subnet records do", () => {
    // The reason both go through one builder: a second copy is exactly how the
    // creator/publisher/includedInDataCatalog wiring lands on one and not the
    // other.
    const out = providerDatasetJsonLd({ ...base, name: "404-GEN" }) as unknown as Record<
      string,
      unknown
    >;
    expect(out["@type"]).toBe("Dataset");
    expect(out.name).toBe("404-GEN — provider record");
    expect(out.identifier).toBe("404-gen");
    expect(out.creator).toStrictEqual({ "@id": JSONLD_IDS.org });
    expect(out.includedInDataCatalog).toStrictEqual({ "@id": JSONLD_IDS.catalog });
    expect((out.distribution as Array<{ contentUrl: string }>).map((d) => d.contentUrl)).toEqual([
      base.apiUrl,
      base.artifactUrl,
    ]);
  });

  it("falls back to the slug when the registry holds no name", () => {
    expect(providerDatasetJsonLd(base).name).toBe("404-gen — provider record");
    expect(providerDatasetJsonLd({ ...base, name: "  " }).name).toBe("404-gen — provider record");
  });

  it("describes OUR record, never the provider as an organization", () => {
    // Emitting an Organization would assert a third party's identity on their
    // behalf — the over-claim the registry exists not to make.
    const out = providerDatasetJsonLd(base) as unknown as Record<string, unknown>;
    expect(out["@type"]).not.toBe("Organization");
    expect(String(out.description)).toContain("Registry record for");
  });

  it("omits sameAs rather than attaching the record to nothing", () => {
    expect(providerDatasetJsonLd(base)).not.toHaveProperty("sameAs");
    expect(providerDatasetJsonLd({ ...base, sameAs: "https://www.404.xyz/" })).toHaveProperty(
      "sameAs",
      ["https://www.404.xyz/"],
    );
  });
});
