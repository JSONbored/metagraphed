import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The route/component files compose TanStack Router/Query context a rendered
// test can't easily stand up, so this suite is node-environment source
// assertions, mirroring leaderboards-csv-export-menu.test.ts's convention.
const mastheadSource = readFileSync(
  fileURLToPath(new URL("../components/metagraphed/subnet-masthead.tsx", import.meta.url)),
  "utf8",
);
const subnetRouteSource = readFileSync(
  fileURLToPath(new URL("./-subnets-netuid-page.tsx", import.meta.url)),
  "utf8",
);
const providerRouteSource = readFileSync(
  fileURLToPath(new URL("./-providers-slug-page.tsx", import.meta.url)),
  "utf8",
);

describe("subnet dossier masthead", () => {
  it("uses shared page-system primitives instead of route-local masthead furniture", () => {
    const importBlock = mastheadSource.slice(
      0,
      mastheadSource.indexOf('} from "@jsonbored/ui-kit"'),
    );
    expect(importBlock).toContain("DataPageHero");
    expect(importBlock).toContain("DataPageSignalRail");
    expect(mastheadSource).toContain("<DataPageHero");
    expect(mastheadSource).toContain("<DataPageSignalRail");
  });

  it("keeps the app-shell breadcrumb canonical and moves profile tools out of the first decision", () => {
    expect(mastheadSource).not.toContain('aria-label="Breadcrumb"');
    expect(mastheadSource).not.toContain("<ActionBar");
    expect(mastheadSource).not.toContain("<ShareButton");
    // Alerts, compare, and share are configuration in the dossier's Records
    // view rather than headline actions competing with Build/Research/Participate.
    expect(subnetRouteSource).toContain('id="watch"');
    expect(subnetRouteSource).toContain("<CopyLinkButton");
  });

  it("shows health, readiness, and source coverage with per-reading provenance", () => {
    expect(mastheadSource).not.toContain("hidden md:flex shrink-0 flex-col items-end");
    expect(mastheadSource).toContain("<HealthPill");
    expect(mastheadSource).toContain("<CurationChip");
    expect(mastheadSource).toContain("<StaleBanner");
    expect(mastheadSource).toContain('label: "Availability"');
    expect(mastheadSource).toContain('label: "Build readiness"');
    expect(mastheadSource).toContain('label: "Source coverage"');
    expect(mastheadSource).toContain("Probe record");
    expect(mastheadSource).toContain("Probe timestamp unavailable");
    expect(mastheadSource).not.toContain("generated_at ?? generatedAt");
    expect(mastheadSource).toContain("Profile record");
    expect(mastheadSource).toContain("refreshQueryKeys={stale ? refreshQueryKeys : undefined}");
  });

  it("puts the three visitor jobs alongside the title and keeps references quiet", () => {
    expect(mastheadSource).toContain('search={{ tab: "build" }}');
    expect(mastheadSource).toContain('search={{ tab: "research" }}');
    expect(mastheadSource).toContain('search={{ tab: "participate" }}');
    expect(mastheadSource).toContain("Explore integration");
    expect(mastheadSource).toContain("Research economics");
    expect(mastheadSource).toContain("Watch, compare & share");
    expect(mastheadSource).toContain("footer={");
  });
});

// #8247: the subnet detail page's "data sources"/"artifacts" ApiSourceFooter
// strip was itself a duplicate-fact the redesign audit flagged -- the
// masthead (mounted on every tab) now owns the same registration via
// useRegisterApiSource, surfaced through a visible `{ } API` chip that opens
// the identical drawer. The route no longer renders ApiSourceFooter at all.
describe("subnets.$netuid.tsx API source registration (moved to the masthead)", () => {
  it("no longer imports or renders ApiSourceFooter", () => {
    expect(subnetRouteSource).not.toContain("api-source-footer");
    expect(subnetRouteSource).not.toContain("<ApiSourceFooter");
  });

  it("subnet-masthead.tsx registers the profile/overview/identity-history paths and opens the drawer from a visible chip", () => {
    expect(mastheadSource).toMatch(
      /import \{ useApiSourceCtx, useRegisterApiSource \} from "@\/lib\/metagraphed\/api-source-context";/,
    );
    const registerCall = mastheadSource.slice(mastheadSource.indexOf("useRegisterApiSource("));
    expect(registerCall).toContain("`/api/v1/subnets/${netuid}/profile`");
    expect(registerCall).toContain("`/api/v1/subnets/${netuid}/overview`");
    expect(registerCall).toContain("`/api/v1/subnets/${netuid}/identity-history`");
    expect(mastheadSource).toContain("const { open: openApiDrawer } = useApiSourceCtx();");
    expect(mastheadSource).toContain("onClick={openApiDrawer}");
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

  it("#7853: no longer renders its own standalone <Breadcrumbs> -- migrates the provider name into AppShell's crumbLabel prop instead", () => {
    expect(providerRouteSource).not.toContain("<Breadcrumbs");
    const componentBody = providerRouteSource.slice(
      providerRouteSource.indexOf("function ProviderDetail"),
      providerRouteSource.indexOf("function ProviderShell"),
    );
    expect(componentBody).toContain("<AppShell crumbLabel={loaderData?.name ?? undefined}>");
  });
});

describe("#7853 breadcrumb de-duplication: AppShell crumbLabel wiring", () => {
  const appShellSource = readFileSync(
    fileURLToPath(new URL("../components/metagraphed/app-shell.tsx", import.meta.url)),
    "utf8",
  );
  const blocksRouteSource = readFileSync(
    fileURLToPath(new URL("./-blocks-ref-page.tsx", import.meta.url)),
    "utf8",
  );

  it("app-shell.tsx accepts a crumbLabel prop and uses it to override only the trailing crumb", () => {
    expect(appShellSource).toContain("crumbLabel?: string");
    const memo = appShellSource.slice(
      appShellSource.indexOf("const crumbs = useMemo"),
      appShellSource.indexOf("const parent = useMemo"),
    );
    expect(memo).toContain("buildCrumbs(pathname)");
    expect(memo).toContain("crumbLabel");
  });

  it("subnets.$netuid.tsx passes the zero-padded netuid as the shell's crumbLabel", () => {
    expect(subnetRouteSource).toContain('crumbLabel={String(netuid).padStart(3, "0")}');
  });

  it("blocks.$ref.tsx passes the loader-resolved, comma-formatted block number as the shell's crumbLabel instead of a second custom breadcrumb trail", () => {
    expect(blocksRouteSource).not.toContain("hideBreadcrumbs={false}");
    expect(blocksRouteSource).toContain("<AppShell crumbLabel={crumbLabel}>");
  });
});
