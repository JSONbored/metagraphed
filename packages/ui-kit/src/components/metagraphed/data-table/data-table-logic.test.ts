import { describe, expect, it } from "vitest";
import {
  compareValues,
  csvField,
  defaultVisibleKeys,
  nextSort,
  pageCount,
  pageSlice,
  pageWindow,
  pickMobileMode,
  rangeLabel,
  resolveVisibleKeys,
  shouldBoundViewport,
  sortRows,
  toCsv,
  truncateIdentifier,
  visibleRangeLabel,
} from "./data-table-logic";

describe("nextSort", () => {
  it("cycles asc → desc → unsorted, and restarts on a different column", () => {
    expect(nextSort(null, "stake")).toEqual({ key: "stake", dir: "asc" });
    expect(nextSort({ key: "stake", dir: "asc" }, "stake")).toEqual({
      key: "stake",
      dir: "desc",
    });
    expect(nextSort({ key: "stake", dir: "desc" }, "stake")).toBeNull();
    expect(nextSort({ key: "stake", dir: "desc" }, "name")).toEqual({
      key: "name",
      dir: "asc",
    });
  });
});

describe("compareValues", () => {
  it("compares numbers numerically and strings naturally", () => {
    expect(compareValues(2, 10)).toBeLessThan(0);
    expect(compareValues("SN2", "SN10")).toBeLessThan(0);
    expect(compareValues("b", "a")).toBeGreaterThan(0);
  });

  it("sinks a missing value whichever way the column is sorted", () => {
    expect(compareValues(null, 1)).toBeGreaterThan(0);
    expect(compareValues(1, undefined)).toBeLessThan(0);
    expect(compareValues("", null)).toBe(0);
  });
});

describe("sortRows", () => {
  const rows = [
    { id: "a", n: 3 },
    { id: "b", n: 1 },
    { id: "c", n: 3 },
    { id: "d", n: null as number | null },
  ];
  const valueOf = (row: (typeof rows)[number]) => row.n;

  it("is stable and keeps unknowns last in both directions", () => {
    expect(
      sortRows(rows, { key: "n", dir: "asc" }, valueOf).map((r) => r.id),
    ).toEqual(["b", "a", "c", "d"]);
    expect(
      sortRows(rows, { key: "n", dir: "desc" }, valueOf).map((r) => r.id),
    ).toEqual(["a", "c", "b", "d"]);
  });

  it("returns the incoming order when nothing is sorted", () => {
    expect(sortRows(rows, null, valueOf).map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});

describe("paging", () => {
  const rows = Array.from({ length: 125 }, (_, i) => i);

  it("counts pages and slices them", () => {
    expect(pageCount(125, 50)).toBe(3);
    expect(pageCount(0, 50)).toBe(1);
    expect(pageSlice(rows, 3, 50)).toEqual(
      [100, 101, 102, 103, 104].concat(rows.slice(105)),
    );
    expect(pageSlice(rows, 1, 50)).toHaveLength(50);
  });

  it("labels the visible range against the true total", () => {
    expect(rangeLabel(1, 50, 1021)).toBe("1–50 of 1,021");
    expect(rangeLabel(3, 50, 125)).toBe("101–125 of 125");
    expect(rangeLabel(1, 50, 0)).toBe("0");
  });

  it("does not invent a total for a server page that only proves its slice", () => {
    expect(visibleRangeLabel(1, 50, 50)).toBe("1–50");
    expect(visibleRangeLabel(3, 50, 17)).toBe("101–117");
    expect(visibleRangeLabel(1, 50, 0)).toBe("0");
  });

  it("elides the pager once there are more than seven pages", () => {
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(1, 12)).toEqual([1, 2, 3, 4, null, 12]);
    expect(pageWindow(6, 12)).toEqual([1, null, 5, 6, 7, null, 12]);
    expect(pageWindow(12, 12)).toEqual([1, null, 9, 10, 11, 12]);
  });
});

describe("truncateIdentifier", () => {
  it("keeps both ends of a long key and leaves a short one alone", () => {
    expect(
      truncateIdentifier("5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9"),
    ).toBe("5GsbTg…SFpZX9");
    expect(truncateIdentifier("SN12")).toBe("SN12");
  });
});

describe("csv", () => {
  it("quotes only what needs it and doubles embedded quotes", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvField(null)).toBe("");
  });

  it("exports the visible columns of the sorted rows", () => {
    const rows = [{ id: "a", n: 1 }];
    expect(
      toCsv(
        rows,
        [
          { key: "id", label: "ID" },
          { key: "n", label: "Count" },
        ],
        (row, key) => (key === "id" ? row.id : row.n),
      ),
    ).toBe("ID,Count\r\na,1\r\n");
  });
});

describe("column visibility", () => {
  const columns = [{ key: "a" }, { key: "b", demote: true }, { key: "c" }];

  it("hides demoted columns by default", () => {
    expect(defaultVisibleKeys(columns)).toEqual(["a", "c"]);
  });

  it("honours a stored selection, ignores keys the table lost, and never empties it", () => {
    expect(resolveVisibleKeys(columns, ["a", "b", "gone"])).toEqual(["a", "b"]);
    expect(resolveVisibleKeys(columns, ["gone"])).toEqual(["a", "c"]);
    expect(resolveVisibleKeys(columns, null)).toEqual(["a", "c"]);
  });
});

describe("responsive choices", () => {
  it("uses cards for a narrow table and scroll for a wide one", () => {
    expect(pickMobileMode(4)).toBe("cards");
    expect(pickMobileMode(6)).toBe("cards");
    expect(pickMobileMode(7)).toBe("scroll");
  });

  it("bounds the viewport only once the list is long enough to need it", () => {
    expect(shouldBoundViewport(20)).toBe(false);
    expect(shouldBoundViewport(21)).toBe(true);
  });
});
