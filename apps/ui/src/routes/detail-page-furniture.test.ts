import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #5481: the subnet-detail and provider-detail pages were the only two
// entity-detail routes missing the ShareButton (copy-current-URL) and
// ApiSourceFooter (data-provenance) affordances every sibling detail page
// already renders (validators.$hotkey.tsx, blocks.$ref.tsx, etc.). These
// components need a full router + query client to render, so — like
// api-source-context.test.tsx — this suite reads the route/component source
// and asserts the wiring is present rather than rendering it.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const providers = read("./providers.$slug.tsx");
const subnets = read("./subnets.$netuid.tsx");
const masthead = read("../components/metagraphed/subnet-masthead.tsx");

describe("provider detail page has the standard detail-page furniture (#5481)", () => {
  it("imports ShareButton from the ui-kit and ApiSourceFooter", () => {
    expect(providers).toContain("ShareButton");
    expect(providers).toMatch(/from "@jsonbored\/ui-kit"/);
    expect(providers).toContain("api-source-footer");
  });

  it("passes actions={<ShareButton />} to the EntityHero call", () => {
    expect(providers).toMatch(/actions=\{<ShareButton \/>\}/);
  });

  it("renders an ApiSourceFooter citing the provider detail API paths it reads", () => {
    expect(providers).toContain("<ApiSourceFooter");
    expect(providers).toContain("/api/v1/providers/${slug}");
    expect(providers).toContain("/api/v1/providers/${slug}/endpoints");
  });
});

describe("subnet detail page has the standard detail-page furniture (#5481)", () => {
  it("the masthead renders a ShareButton in its action area", () => {
    expect(masthead).toContain("ShareButton");
    expect(masthead).toContain("<ShareButton");
  });

  it("the route renders an ApiSourceFooter citing the subnet detail API paths it reads", () => {
    expect(subnets).toContain("api-source-footer");
    expect(subnets).toContain("<ApiSourceFooter");
    expect(subnets).toContain("/api/v1/subnets/${netuid}/profile");
  });
});
