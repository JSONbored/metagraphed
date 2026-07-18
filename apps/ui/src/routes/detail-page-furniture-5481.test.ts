import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #5481: every entity-detail route (accounts, blocks, extrinsics, validators)
// already pairs a ShareButton with an ApiSourceFooter -- except the subnet and
// provider detail pages, the two busiest ones. This wires those two missing
// pieces into just those pages/their shared masthead. The route/component
// files compose TanStack Router/Query context a rendered test can't easily
// stand up, so this suite is node-environment source assertions, mirroring
// leaderboards-csv-export-menu.test.ts's own convention.
const mastheadSource = readFileSync(
  fileURLToPath(new URL("../components/metagraphed/subnet-masthead.tsx", import.meta.url)),
  "utf8",
);
const subnetRouteSource = readFileSync(
  fileURLToPath(new URL("./subnets.$netuid.tsx", import.meta.url)),
  "utf8",
);
const providerRouteSource = readFileSync(
  fileURLToPath(new URL("./providers.$slug.tsx", import.meta.url)),
  "utf8",
);

describe("subnet-masthead ShareButton (#5481)", () => {
  it("imports ShareButton from @jsonbored/ui-kit", () => {
    const importBlock = mastheadSource.slice(
      0,
      mastheadSource.indexOf('} from "@jsonbored/ui-kit"'),
    );
    expect(importBlock).toContain("ShareButton");
  });

  it("renders a bare ShareButton in the status row, reachable at every viewport (not md:hidden)", () => {
    const statusRow = mastheadSource.slice(
      mastheadSource.indexOf("Status row"),
      mastheadSource.indexOf("{banner ?"),
    );
    expect(statusRow).toContain("<ShareButton bare");
    // The ShareButton's own wrapper div must NOT carry md:hidden -- only the
    // HealthPill/CurationChip pair (moved into a nested div) stays mobile-only.
    const shareButtonWrapper = statusRow.slice(statusRow.indexOf('<div className="ml-auto'));
    expect(shareButtonWrapper.split("\n")[0]).not.toContain("md:hidden");
  });
});

describe("subnets.$netuid.tsx ApiSourceFooter (#5481)", () => {
  it("imports ApiSourceFooter", () => {
    expect(subnetRouteSource).toContain(
      'import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";',
    );
  });

  it("renders exactly one ApiSourceFooter outside the tab switch, citing the profile/overview/identity-history paths", () => {
    expect(subnetRouteSource.match(/<ApiSourceFooter/g)?.length).toBe(1);
    const footerCall = subnetRouteSource.slice(subnetRouteSource.indexOf("<ApiSourceFooter"));
    expect(footerCall).toContain("`/api/v1/subnets/${netuid}/profile`");
    expect(footerCall).toContain("`/api/v1/subnets/${netuid}/overview`");
    expect(footerCall).toContain("`/api/v1/subnets/${netuid}/identity-history`");
  });
});

describe("providers.$slug.tsx ShareButton + ApiSourceFooter (#5481)", () => {
  it("imports both ShareButton and ApiSourceFooter", () => {
    expect(providerRouteSource).toContain(
      'import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";',
    );
    const importBlock = providerRouteSource.slice(
      0,
      providerRouteSource.indexOf('} from "@jsonbored/ui-kit"'),
    );
    expect(importBlock).toContain("ShareButton");
  });

  it("passes a ShareButton via EntityHero's actions prop", () => {
    const heroCall = providerRouteSource.slice(
      providerRouteSource.indexOf("<EntityHero"),
      providerRouteSource.indexOf("<ProfileTabs"),
    );
    expect(heroCall).toContain("actions={<ShareButton />}");
  });

  it("renders exactly one ApiSourceFooter citing the provider + provider-endpoints paths", () => {
    expect(providerRouteSource.match(/<ApiSourceFooter/g)?.length).toBe(1);
    const footerCall = providerRouteSource.slice(providerRouteSource.indexOf("<ApiSourceFooter"));
    expect(footerCall).toContain("`/api/v1/providers/${slug}`");
    expect(footerCall).toContain("`/api/v1/providers/${slug}/endpoints`");
  });
});
