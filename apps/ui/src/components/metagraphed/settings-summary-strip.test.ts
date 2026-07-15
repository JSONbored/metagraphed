import { describe, expect, it } from "vitest";
import { SettingsSummaryStrip } from "./settings-summary-strip";
import { buildSettingsSummaryTiles } from "@/lib/metagraphed/settings-summary";

describe("SettingsSummaryStrip", () => {
  it("exports a renderable component", () => {
    expect(typeof SettingsSummaryStrip).toBe("function");
  });

  it("defaults to the three self-service action tiles", () => {
    const tiles = buildSettingsSummaryTiles();
    expect(tiles.map((t) => t.id)).toEqual(["create", "lookup", "delete"]);
  });
});
