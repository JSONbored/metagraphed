import { describe, expect, test } from "vitest";
import { groupByOperator } from "./group-validators";
import type { GlobalValidator } from "./types";

function v(hotkey: string, name: string | null, extra: Partial<GlobalValidator> = {}) {
  return {
    hotkey,
    coldkey: `ck-${hotkey}`,
    coldkey_identity:
      name == null ? { has_identity: false, name: null } : { has_identity: true, name },
    ...extra,
  } as GlobalValidator;
}

describe("groupByOperator", () => {
  test("pulls an operator's later keys up adjacent to its best-ranked row", () => {
    // Sorted input (e.g. by stake): Ventura's keys sit at ranks 1, 3 and 5.
    const rows = [
      v("A", "Ventura Labs"),
      v("B", null),
      v("C", "Ventura Labs"),
      v("D", "Yuma"),
      v("E", "Ventura Labs"),
    ];
    const { list, info } = groupByOperator(rows);
    expect(list.map((r) => r.hotkey)).toEqual(["A", "C", "E", "B", "D"]);
    expect(info.get("A")).toEqual({ size: 3, index: 0 });
    expect(info.get("C")).toEqual({ size: 3, index: 1 });
    expect(info.get("E")).toEqual({ size: 3, index: 2 });
    // Single-key rows are their own group of one, in their original order.
    expect(info.get("B")).toEqual({ size: 1, index: 0 });
    expect(info.get("D")).toEqual({ size: 1, index: 0 });
  });

  test("rows without a declared identity never merge, even together", () => {
    const rows = [v("A", null), v("B", null), v("C", null)];
    const { list, info } = groupByOperator(rows);
    expect(list.map((r) => r.hotkey)).toEqual(["A", "B", "C"]);
    for (const key of ["A", "B", "C"]) {
      expect(info.get(key)).toEqual({ size: 1, index: 0 });
    }
  });

  test("a blank or whitespace-only name is treated as no identity", () => {
    const rows = [v("A", "  "), v("B", "  ")];
    const { list, info } = groupByOperator(rows);
    expect(list.map((r) => r.hotkey)).toEqual(["A", "B"]);
    expect(info.get("A")).toEqual({ size: 1, index: 0 });
  });

  test("has_identity:false rows never group even when a name string leaks through", () => {
    const rows = [
      {
        hotkey: "A",
        coldkey: "ck-A",
        coldkey_identity: { has_identity: false, name: "Ghost" },
      } as GlobalValidator,
      {
        hotkey: "B",
        coldkey: "ck-B",
        coldkey_identity: { has_identity: false, name: "Ghost" },
      } as GlobalValidator,
    ];
    const { info } = groupByOperator(rows);
    expect(info.get("A")).toEqual({ size: 1, index: 0 });
    expect(info.get("B")).toEqual({ size: 1, index: 0 });
  });

  test("names differing only by surrounding whitespace group together", () => {
    const rows = [v("A", "Yuma"), v("B", " Yuma ")];
    const { list, info } = groupByOperator(rows);
    expect(list.map((r) => r.hotkey)).toEqual(["A", "B"]);
    expect(info.get("B")).toEqual({ size: 2, index: 1 });
  });
});
