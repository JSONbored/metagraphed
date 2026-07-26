import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #6577: the leaderboards page's ActionBar offered CSV export for two of its
// three boards. Two prior PR attempts fixed the gap by adding a third bare
// DownloadCsvButton -- both were rejected by the maintainer for looking like
// "3 repeating icons" (each `bare` button collapses to an unlabeled icon below
// `sm`, so nothing distinguishes one from another) and "utterly ridiculous and
// confusing". The fix is a single CsvExportMenu trigger with a Popover menu of
// the three exports, not a third icon. These pages compose TanStack
// Router/Query context a rendered test can't easily stand up, so this suite is
// node-environment source assertions, mirroring
// validators-index-empty-action.test.ts's own convention.
//
// #8311: the boards moved into /subnets?section=rankings, so the ActionBar
// that hosts the trigger now lives on the subnets index while the menu itself
// stays with the boards. Both files are read.
const source = readFileSync(
  fileURLToPath(new URL("./-leaderboards-page.tsx", import.meta.url)),
  "utf8",
);
const host = readFileSync(
  fileURLToPath(new URL("./-subnets-index-page.tsx", import.meta.url)),
  "utf8",
);

/** The CsvExportMenu declaration, however the file around it is reshuffled. */
function csvMenuSource() {
  return source.slice(
    source.indexOf("function CsvExportMenu"),
    source.indexOf("function useSubnetById"),
  );
}

describe("leaderboards ActionBar CSV export", () => {
  it("renders exactly one CSV-export trigger in the rankings ActionBar, not one per board", () => {
    const actionBar = host.slice(host.indexOf("<ActionBar>"), host.indexOf("</ActionBar>"));
    expect(actionBar).toContain("<LeaderboardsCsvExportMenu");
    // Exactly one menu element -- not one per board.
    expect(actionBar.match(/<LeaderboardsCsvExportMenu/g)?.length).toBe(1);
    // The subnets CSV button is the registry section's, and must not render
    // alongside the menu in the rankings section.
    expect(actionBar).toContain('search.section === "rankings"');
  });

  it("no longer imports DownloadCsvButton -- replaced entirely by the menu", () => {
    const importBlock = source.slice(0, source.indexOf('} from "@jsonbored/ui-kit"'));
    expect(importBlock).not.toContain("DownloadCsvButton");
  });

  it("CsvExportMenu lists all three exports with their own labels", () => {
    const menu = csvMenuSource();
    expect(menu).toContain('label: "Weight-setting CSV"');
    expect(menu).toContain('label: "Deregistrations CSV"');
    expect(menu).toContain('label: "Emissions CSV"');
  });

  it("scopes weight-setting/deregistrations to the window, but not emissions (economicsQuery takes no window)", () => {
    const menu = csvMenuSource();
    expect(menu).toContain('buildUrl("/api/v1/chain/weights", { window: win })');
    expect(menu).toContain('buildUrl("/api/v1/chain/deregistrations", { window: win })');
    expect(menu).toContain('buildUrl("/api/v1/economics")');
    expect(menu).not.toContain('buildUrl("/api/v1/economics", { window');
  });

  it("uses a single Popover trigger, never a per-export bare button visible outside the open menu", () => {
    const menu = csvMenuSource();
    expect(menu).toContain("<PopoverTrigger");
    expect(menu).toContain('aria-label="Download CSV"');
  });
});
