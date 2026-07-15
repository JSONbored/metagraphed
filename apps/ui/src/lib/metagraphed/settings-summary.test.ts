import { describe, expect, it } from "vitest";
import {
  SETTINGS_CHANGE_KINDS,
  SETTINGS_SUMMARY_ACTIONS,
  buildSettingsHeroKpis,
  buildSettingsSummaryTiles,
} from "./settings-summary";

describe("settings-summary", () => {
  it("exposes the three self-service webhook actions", () => {
    expect(SETTINGS_SUMMARY_ACTIONS).toHaveLength(3);
    expect(SETTINGS_SUMMARY_ACTIONS.map((a) => a.id)).toEqual(["create", "lookup", "delete"]);
    expect(SETTINGS_SUMMARY_ACTIONS.map((a) => a.method)).toEqual(["POST", "GET", "DELETE"]);
  });

  it("exposes the change-feed kinds the forms can filter on", () => {
    expect(SETTINGS_CHANGE_KINDS).toEqual(["subnets", "artifacts"]);
  });

  it("builds PageHero KPIs with short action / kind / auth / API cells", () => {
    const kpis = buildSettingsHeroKpis();
    expect(kpis).toHaveLength(4);
    expect(kpis[0]).toEqual({
      label: "Actions",
      value: "3",
      hint: "forms",
    });
    expect(kpis[1]).toEqual({
      label: "Kinds",
      value: "2",
      hint: "feeds",
    });
    expect(kpis[2]).toEqual({
      label: "Auth",
      value: "2",
      hint: "keys",
    });
    expect(kpis[3]).toEqual({
      label: "API",
      value: "live",
      hint: "public",
    });
  });

  it("honors custom action and kind list lengths when building hero KPIs", () => {
    const kpis = buildSettingsHeroKpis(
      [{ id: "create", label: "Create", method: "POST", hint: "token-gated" }],
      ["subnets"],
    );
    expect(kpis[0]).toMatchObject({ value: "1", hint: "forms" });
    expect(kpis[1]).toMatchObject({ value: "1", hint: "feeds" });
  });

  it("builds StatTile rows with an accent create tile", () => {
    const tiles = buildSettingsSummaryTiles();
    expect(tiles).toHaveLength(3);
    expect(tiles[0]).toEqual({
      id: "create",
      eyebrow: "Create",
      value: "POST",
      hint: "token-gated",
      tone: "accent",
    });
    expect(tiles[1]).toMatchObject({
      id: "lookup",
      eyebrow: "Look up",
      value: "GET",
      tone: "default",
    });
    expect(tiles[2]).toMatchObject({
      id: "delete",
      eyebrow: "Delete",
      value: "DELETE",
      tone: "default",
    });
  });

  it("marks only the first tile as accent when given a custom action list", () => {
    const tiles = buildSettingsSummaryTiles([
      { id: "lookup", label: "Look up", method: "GET", hint: "by id" },
      { id: "delete", label: "Delete", method: "DELETE", hint: "secret" },
    ]);
    expect(tiles[0].tone).toBe("accent");
    expect(tiles[1].tone).toBe("default");
  });
});
