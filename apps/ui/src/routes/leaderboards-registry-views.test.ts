import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #6995: /leaderboards gained registry opportunity + operational views. This
// suite is node-environment source assertions (same convention as
// leaderboards-csv-export-menu.test.ts) so TanStack Router/Query context does
// not need to be stood up.
const source = readFileSync(fileURLToPath(new URL("./leaderboards.tsx", import.meta.url)), "utf8");

describe("leaderboards registry views (#6995)", () => {
  it("defaults the view to opportunity and lists all three view chips", () => {
    expect(source).toContain(
      'fallback(z.enum(["opportunity", "registry", "chain"]), "opportunity")',
    );
    expect(source).toContain('{ id: "opportunity", label: "Opportunity" }');
    expect(source).toContain('{ id: "registry", label: "Registry" }');
    expect(source).toContain('{ id: "chain", label: "Chain" }');
  });

  it("wires both economic and operational board groups from the shared specs", () => {
    expect(source).toContain("ECONOMIC_BOARD_KEYS");
    expect(source).toContain("OPERATIONAL_BOARD_KEYS");
    expect(source).toContain("REGISTRY_BOARD_SPECS");
    expect(source).toContain("leaderboardsQuery");
    expect(source).toContain('"/api/v1/registry/leaderboards"');
  });

  it("keeps chain CSV export gated to the chain view only", () => {
    const actionBar = source.slice(source.indexOf("<ActionBar>"), source.indexOf("</ActionBar>"));
    expect(actionBar).toContain('view === "chain" ? <CsvExportMenu');
  });
});
