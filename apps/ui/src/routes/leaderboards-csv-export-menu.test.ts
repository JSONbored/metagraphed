import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #6577: the leaderboards page's ActionBar offered CSV export for two of its
// three boards. Two prior PR attempts fixed the gap by adding a third bare
// DownloadCsvButton -- both were rejected by the maintainer for looking like
// "3 repeating icons" (each `bare` button collapses to an unlabeled icon below
// `sm`, so nothing distinguishes one from another) and "utterly ridiculous and
// confusing". The fix is a single CsvExportMenu trigger with a Popover menu of
// the three exports, not a third icon. `leaderboards.tsx` composes TanStack
// Router/Query context a rendered test can't easily stand up, so this suite is
// node-environment source assertions, mirroring
// validators-index-empty-action.test.ts's own convention.
const source = readFileSync(fileURLToPath(new URL("./leaderboards.tsx", import.meta.url)), "utf8");

describe("leaderboards ActionBar CSV export", () => {
  it("renders exactly one CsvExportMenu trigger in the ActionBar, not a DownloadCsvButton per board", () => {
    const actionBar = source.slice(source.indexOf("<ActionBar>"), source.indexOf("</ActionBar>"));
    expect(actionBar).toContain("<CsvExportMenu");
    expect(actionBar).not.toContain("DownloadCsvButton");
    // Exactly one CsvExportMenu element -- not one per board.
    expect(actionBar.match(/<CsvExportMenu/g)?.length).toBe(1);
  });

  it("no longer imports DownloadCsvButton -- replaced entirely by the menu", () => {
    const importBlock = source.slice(0, source.indexOf('} from "@jsonbored/ui-kit"'));
    expect(importBlock).not.toContain("DownloadCsvButton");
  });

  it("CsvExportMenu lists all three exports with their own labels", () => {
    const menu = source.slice(
      source.indexOf("function CsvExportMenu"),
      source.indexOf("function useSubnetById"),
    );
    expect(menu).toContain('label: "Weight-setting CSV"');
    expect(menu).toContain('label: "Deregistrations CSV"');
    expect(menu).toContain('label: "Emissions CSV"');
  });

  it("scopes weight-setting/deregistrations to the window, but not emissions (economicsQuery takes no window)", () => {
    const menu = source.slice(
      source.indexOf("function CsvExportMenu"),
      source.indexOf("function useSubnetById"),
    );
    expect(menu).toContain('buildUrl("/api/v1/chain/weights", { window: win })');
    expect(menu).toContain('buildUrl("/api/v1/chain/deregistrations", { window: win })');
    expect(menu).toContain('buildUrl("/api/v1/economics")');
    expect(menu).not.toContain('buildUrl("/api/v1/economics", { window');
  });

  it("uses a single Popover trigger, never a per-export bare button visible outside the open menu", () => {
    const menu = source.slice(
      source.indexOf("function CsvExportMenu"),
      source.indexOf("function useSubnetById"),
    );
    expect(menu).toContain("<PopoverTrigger");
    expect(menu).toContain('aria-label="Download CSV"');
  });
});
