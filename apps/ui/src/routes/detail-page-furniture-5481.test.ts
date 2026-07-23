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

describe("subnet-masthead ShareButton", () => {
  it("imports ShareButton from @jsonbored/ui-kit", () => {
    const importBlock = mastheadSource.slice(
      0,
      mastheadSource.indexOf('} from "@jsonbored/ui-kit"'),
    );
    expect(importBlock).toContain("ShareButton");
  });

  it("keeps the status row to just the breadcrumb -- no separate 'stale' tag duplicating the freshness caption, no actions", () => {
    const statusRow = mastheadSource.slice(
      mastheadSource.indexOf("Status row"),
      mastheadSource.indexOf("{banner ?"),
    );
    expect(statusRow).toContain("Registry");
    expect(statusRow).not.toContain("<ActionBar");
    expect(statusRow).not.toContain("<ShareButton");
    expect(statusRow).not.toContain("<StaleBanner");
    expect(statusRow).not.toMatch(/>\s*stale\s*</);
  });

  it("consolidates HealthPill/CurationChip/freshness/Refresh into one identity-row meta strip, not a separate desktop-only side column", () => {
    expect(mastheadSource).not.toContain("hidden md:flex shrink-0 flex-col items-end");
    const identityBody = mastheadSource.slice(
      mastheadSource.indexOf('<div className="min-w-0">'),
      mastheadSource.indexOf("{description ?"),
    );
    expect(identityBody).toContain("<HealthPill");
    expect(identityBody).toContain("<CurationChip");
    expect(identityBody).toContain("<StaleBanner");
    // Refresh only when actually stale -- text (freshness caption) stays
    // visible unconditionally via StaleBanner's own default hideText=false.
    expect(identityBody).toContain("refreshQueryKeys={stale ? refreshQueryKeys : undefined}");
  });

  it("renders the Website/Docs/Repo/Dashboard + Share row as one connected icon bar, not separately boxed pills", () => {
    const linksRow = mastheadSource.slice(
      mastheadSource.indexOf("{description ?"),
      mastheadSource.indexOf("Stat spine"),
    );
    // One shared divide-x bar (SegmentedToggle/ViewModeToggle's look), not a
    // flex-wrap row of individually rounded-full-bordered pills.
    expect(linksRow).toContain("divide-x divide-border");
    expect(linksRow).not.toContain("rounded-full border border-border bg-card");
    // Icon-only -- no <span>{l.label}</span> text label alongside the icon.
    expect(linksRow).not.toContain("<span>{l.label}</span>");
    // Share lives in this same bar (a resource/link action, not a status
    // readout) -- `connected` matches PrimaryLinksRail's icon segments, and
    // the bar renders unconditionally so Share is always present even when
    // the subnet has no external links yet.
    expect(linksRow).toContain("<ShareButton connected />");
    expect(mastheadSource).not.toContain("{links.length > 0 ?");
  });
});

describe("subnets.$netuid.tsx ApiSourceFooter", () => {
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

describe("providers.$slug.tsx ShareButton + ApiSourceFooter", () => {
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

  it("shares one connected bar between PrimaryLinksRail and ShareButton via PageMasthead's actions prop", () => {
    const mastheadCall = providerRouteSource.slice(
      providerRouteSource.indexOf("<PageMasthead"),
      providerRouteSource.indexOf("<TabStrip"),
    );
    expect(mastheadCall).toContain("actions={");
    // `bare` so PrimaryLinksRail contributes bare icon segments (no own
    // border/rounded) into the shared divide-x bar below, instead of its own
    // separately-boxed connected bar nested inside this one.
    expect(mastheadCall).toContain("<PrimaryLinksRail");
    expect(mastheadCall).toContain("bare");
    // `connected` so Share is a borderless segment matching the link icons --
    // one shared bar (SegmentedToggle/ViewModeToggle's look), not a separately
    // spaced, individually-boxed button.
    expect(mastheadCall).toContain("<ShareButton connected />");
    expect(mastheadCall).toContain("divide-x divide-border");
  });

  it("renders exactly one ApiSourceFooter citing the provider + provider-endpoints paths", () => {
    expect(providerRouteSource.match(/<ApiSourceFooter/g)?.length).toBe(1);
    const footerCall = providerRouteSource.slice(providerRouteSource.indexOf("<ApiSourceFooter"));
    expect(footerCall).toContain("`/api/v1/providers/${slug}`");
    expect(footerCall).toContain("`/api/v1/providers/${slug}/endpoints`");
  });
});
