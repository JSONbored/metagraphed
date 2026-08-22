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

describe("it reads as a leaderboard, not a list of labelled fields", () => {
  it("carries a rank derived from the list order", () => {
    // The first version had none: the order carried all the meaning and a
    // reader had to count rows to recover it. It is now a real column, so it
    // survives the reader re-sorting the table on another key.
    expect(component).toMatch(
      /holders\.map\(\(entry, i\) => \(\{ \.\.\.entry, rank: i \+ 1 \}\)\)/,
    );
    expect(component).toMatch(/key: "rank"/);
  });

  it("encodes share as a tint, not only a percentage", () => {
    // Concentration is the question this section exists to answer, and a column
    // of percentages does not answer it at a glance. The `tint` cell kind
    // paints the cell in proportion to the share at every breakpoint, so both
    // say the same thing without a hand-rolled bar.
    const share = component.slice(component.indexOf('key: "share"'));
    expect(share.slice(0, 400)).toContain('kind: "tint"');
    expect(share.slice(0, 400)).toMatch(/tint: \(entry\) => entry\.share_of_total/);
  });

  it("keeps the share's accessible value the percentage, not the tint", () => {
    // The tint is a redundant encoding -- the cell text a screen reader gets is
    // still pctStr, never a bare fraction.
    const share = component.slice(component.indexOf('key: "share"'));
    expect(share.slice(0, 400)).toMatch(/format: \(v\) => pctStr\(/);
  });

  it("renders a missing hotkey count as an em dash rather than a 1", () => {
    // null means unread rather than one, and formatNumber's own fallback is
    // the em dash -- never a fabricated count.
    expect(component).toMatch(/value: \(entry\) => entry\.hotkey_count/);
    expect(component).toMatch(/formatNumber\(typeof v === "number" \? v : null\)/);
  });
});

describe("the summary is labelled stats, not a run-on strip", () => {
  it("gives each headline figure its own labelled cell", () => {
    // It was `520 holders · 152.3k α held · top 5 shown` with the ranks tacked
    // underneath as `TOP 5 31.4% 10 44.1% 20 58.7%` -- three different KINDS of
    // fact in one sentence, and a rank row that read as unpaired digits.
    expect(component).toContain("FactCell");
    for (const label of ['label="Holders"', 'label="Alpha held"', 'label="Top 10 share"']) {
      expect(component).toContain(label);
    }
  });

  it("explains each stat in a Definition rather than a clipped hint", () => {
    // The two hints that did exist truncated to "coldkeys with …" at 375px in a
    // two-column grid, which is worse than no hint at all. A FactCell `hint`
    // is a Definition beside the label (#11606/#11607), never clipped.
    expect(component.match(/hint=/g) ?? []).toHaveLength(3);
  });

  it("says the aggregates are whole-subnet, not the rows shown", () => {
    expect(component).toMatch(/rather than the rows shown below/);
  });

  it("moves list-scoped facts out of the tiles and under the list", () => {
    // How many rows are on screen and how fresh the pass is are facts about the
    // LIST, not about the subnet, so they belong with it.
    expect(component).toMatch(/Showing the top \$\{formatNumber\(shown\)\}/);
    const footerAt = component.indexOf("Showing the top");
    const tableAt = component.indexOf("<DataTable");
    expect(tableAt).toBeGreaterThan(-1);
    expect(footerAt).toBeGreaterThan(tableAt);
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
