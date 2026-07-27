import { describe, expect, it } from "vitest";
import {
  buildParameterGroups,
  formatParameterValue,
  type ParameterRow,
} from "./network-parameters-panel";
import type { NetworkParameters } from "@/lib/metagraphed/types";

const params = (overrides: Partial<NetworkParameters> = {}): NetworkParameters => ({
  tao_weight: 0.18,
  stake_threshold_tao: 1000,
  pending_childkey_cooldown_blocks: 7200,
  queried_at: "2026-07-20T12:00:00.000Z",
  ...overrides,
});

describe("buildParameterGroups", () => {
  it("groups the three known keys into issuance/emission/timing sections", () => {
    const groups = buildParameterGroups(params());
    expect(groups.map((g) => g.label)).toEqual(["Issuance & supply", "Emission", "Timing & tempo"]);
    expect(groups[0].rows[0]).toMatchObject({ key: "stake_threshold_tao", value: 1000 });
    expect(groups[1].rows[0]).toMatchObject({ key: "tao_weight", value: 0.18 });
    expect(groups[2].rows[0]).toMatchObject({
      key: "pending_childkey_cooldown_blocks",
      value: 7200,
    });
  });

  it("never surfaces queried_at as its own row", () => {
    const groups = buildParameterGroups(params());
    const keys = groups.flatMap((g) => g.rows.map((r) => r.key));
    expect(keys).not.toContain("queried_at");
  });

  it("carries an independently-null field through as null, not dropped or coerced", () => {
    const groups = buildParameterGroups(params({ tao_weight: null }));
    const row = groups[1].rows[0];
    expect(row.value).toBeNull();
  });

  it("puts a key outside the known display map into a trailing Other group", () => {
    const withExtra = { ...params(), new_future_param: 42 } as NetworkParameters;
    const groups = buildParameterGroups(withExtra);
    const other = groups.at(-1);
    expect(other?.label).toBe("Other");
    expect(other?.rows).toEqual([
      { key: "new_future_param", label: "new_future_param", kind: "raw", value: 42 },
    ]);
  });

  it("adds no Other group when every key is known", () => {
    const groups = buildParameterGroups(params());
    expect(groups.every((g) => g.label !== "Other")).toBe(true);
  });
});

describe("formatParameterValue", () => {
  const row = (partial: Partial<ParameterRow>): ParameterRow => ({
    key: "x",
    label: "x",
    kind: "raw",
    value: null,
    ...partial,
  });

  it("formats a percent-kind value to two decimal places", () => {
    expect(formatParameterValue(row({ kind: "percent", value: 0.18 }))).toEqual({ text: "18.00%" });
  });

  it("falls back to an em-dash for a null percent value", () => {
    expect(formatParameterValue(row({ kind: "percent", value: null }))).toEqual({ text: "—" });
  });

  it("formats a tao-kind value via formatTao, carrying full precision in the title", () => {
    expect(formatParameterValue(row({ kind: "tao", value: 1000 }))).toEqual({
      text: "1.0k τ",
      title: "1000 τ",
    });
  });

  it("formats a count-kind value with plain tabular grouping", () => {
    expect(formatParameterValue(row({ kind: "count", value: 7200 }))).toEqual({ text: "7,200" });
  });

  it("stringifies a raw-kind value with no special formatting", () => {
    expect(formatParameterValue(row({ kind: "raw", value: 42 }))).toEqual({ text: "42" });
  });

  it("falls back to an em-dash for a null raw value", () => {
    expect(formatParameterValue(row({ kind: "raw", value: null }))).toEqual({ text: "—" });
  });
});
