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
    // Located by what is being asserted rather than by position. The previous
    // version indexed the first `{search.section === "rankings" ? (` in the
    // file and sliced forward to `) : (`; when the ActionBar moved into the
    // module's `actions` prop — same behaviour, one fewer nested tab strip —
    // that anchor silently matched a different conditional and the slice came
    // back empty. A source assertion should survive the file being reshuffled,
    // which is the whole reason it reads source instead of rendering.

    // Exactly one menu in the host, not one per board.
    expect(host.match(/<LeaderboardsCsvExportMenu/g)?.length).toBe(1);

    const menuAt = host.indexOf("<LeaderboardsCsvExportMenu");
    const barOpen = host.lastIndexOf("<ActionBar>", menuAt);
    const barClose = host.indexOf("</ActionBar>", menuAt);
    expect(barOpen).toBeGreaterThan(-1);
    expect(barClose).toBeGreaterThan(barOpen);

    const actionBar = host.slice(barOpen, barClose);
    expect(actionBar).toContain("<LeaderboardsCsvExportMenu");
    expect(actionBar).not.toContain("DownloadCsvButton");

    // And that ActionBar is gated on rankings: the registry's own export lives
    // in its local Controls sheet, not alongside the rankings action.
    const gate = host.slice(Math.max(0, barOpen - 400), barOpen);
    expect(gate).toContain('search.section === "rankings"');
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
