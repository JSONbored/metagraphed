import { describe, expect, it } from "vitest";

import { breadcrumbListJsonLd, stringifyJsonLd, subnetDatasetJsonLd } from "./json-ld";

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

  it("prefers the subnet's own description but ignores a blank one", () => {
    expect(subnetDatasetJsonLd({ ...base, description: "Open competitions." }).description).toBe(
      "Open competitions.",
    );
    expect(subnetDatasetJsonLd({ ...base, description: "   " }).description).toContain(
      "Registry record",
    );
  });
});
