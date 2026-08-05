import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The alpha-holders section (#9597), pinned by source assertions.
//
// The component composes Router/Query context a rendered test cannot easily
// stand up, so this follows the convention of subnets-total-stake-tile.test.ts
// and leaderboards-csv-export-menu.test.ts. What it pins is deliberately narrow:
// three properties where a plausible, well-intentioned edit produces a UI that
// states something false and looks entirely correct doing it.
const component = readFileSync(
  fileURLToPath(new URL("./subnet-holders-leaderboard.tsx", import.meta.url)),
  "utf8",
);
const page = readFileSync(
  fileURLToPath(new URL("../../routes/-subnets-netuid-page.tsx", import.meta.url)),
  "utf8",
);
const masthead = readFileSync(
  fileURLToPath(new URL("./subnet-masthead.tsx", import.meta.url)),
  "utf8",
);

describe("the decline branch precedes the empty branch", () => {
  it("checks degraded before holders.length === 0", () => {
    // BOTH states arrive as `holders: []`. Ordered the other way, a subnet
    // whose ranking is merely unproven renders "No alpha holders" -- a
    // confident claim about the chain, made from an absence of data. This is
    // the single most important line ordering in the file.
    const declineAt = component.indexOf("data?.degraded?.reason");
    const emptyAt = component.indexOf("holders.length === 0");
    expect(declineAt).toBeGreaterThan(-1);
    expect(emptyAt).toBeGreaterThan(-1);
    expect(declineAt).toBeLessThan(emptyAt);
  });

  it("renders a decline as an informational notice, not an EmptyState", () => {
    // role="status" + the muted-icon notice shape, matching
    // DataTierUnavailableNotice/NativeOnlyNotice. A dashed EmptyState would
    // read as "nothing here"; a red ErrorState would read as "something broke".
    expect(component).toMatch(/function DeclineNotice/);
    expect(component).toMatch(/role="status"/);
    for (const reason of ["pool_totals_unproven", "root_not_in_alpha_map", "unavailable"]) {
      expect(component).toContain(reason);
    }
  });

  it("keeps the empty-state copy explicit that it is a measurement", () => {
    expect(component).toMatch(/measurement, not a missing ranking/);
  });
});

describe("alpha is displayed in the unit the API serves", () => {
  it("does not divide by 1e9", () => {
    // The conviction leaderboard's fmtAlpha divides by 1e9 because
    // locked_mass/conviction arrive rao-scale. THIS route's producer converts
    // before writing (rao_to_alpha_f64), so `alpha` is already whole alpha.
    // Copying the sibling's helper would report every holder as a billionth of
    // its real size -- which renders as a plausible dust balance, not as an
    // obvious bug.
    expect(component).not.toMatch(/1_000_000_000/);
    expect(component).not.toMatch(/UNITS_PER_WHOLE/);
    expect(component).not.toMatch(/\/\s*1e9/);
  });

  it("renders a null share as an em dash rather than 0%", () => {
    expect(component).toMatch(/if \(share == null/);
    expect(component).toMatch(/return "—"/);
  });
});

describe("the section is wired into the page", () => {
  it("mounts under an anchor inside an error boundary", () => {
    expect(page).toContain('id="holders"');
    expect(page).toMatch(/<SubnetHoldersLeaderboard netuid=\{netuid\} \/>/);
    // Without the boundary, one failing section takes the whole tab down.
    const at = page.indexOf('id="holders"');
    expect(page.slice(at, at + 900)).toContain("QueryErrorBoundary");
  });

  it("registers the anchor in SECTION_TO_TAB", () => {
    // Missing here, a cross-tab deep link to /subnets/7#holders silently lands
    // on the wrong tab and scrolls nowhere -- useHashScroll reads this map.
    expect(page).toMatch(/holders: "metagraph"/);
  });

  it("declares the endpoint in the API drawer", () => {
    expect(masthead).toMatch(/\/holders`/);
  });

  it("states in the section info that the aggregates are whole-subnet", () => {
    // The one caveat a reader needs: holder_count describes the subnet, not the
    // rows on screen.
    const at = page.indexOf('id="holders"');
    expect(page.slice(at, at + 900)).toMatch(/whole subnet, not the returned rows/);
  });
});
