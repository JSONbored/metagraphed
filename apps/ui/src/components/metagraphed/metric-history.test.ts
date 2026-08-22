import { describe, expect, it } from "vitest";
import { dayToMs, toLinePoints } from "./metric-history";

describe("dayToMs", () => {
  it("reads a YYYY-MM-DD day as UTC midnight and an ISO timestamp as itself", () => {
    expect(dayToMs("2026-08-22")).toBe(Date.UTC(2026, 7, 22));
    expect(dayToMs("2026-08-22T13:45:00Z")).toBe(Date.UTC(2026, 7, 22, 13, 45));
    expect(Number.isNaN(dayToMs("not a date"))).toBe(true);
  });
});

describe("toLinePoints", () => {
  const rows = [
    { snapshot_date: "2026-08-03", v: 3 },
    { snapshot_date: "2026-08-01", v: 1 },
    { snapshot_date: "2026-08-02", v: null },
    { snapshot_date: "", v: 9 },
    { snapshot_date: "2026-08-04", v: Number.NaN },
    { snapshot_date: "2026-08-05", v: "5" },
  ];

  it("keeps only rows with a date and a finite number, oldest first", () => {
    expect(
      toLinePoints(
        rows,
        (r) => r.snapshot_date,
        (r) => r.v,
      ),
    ).toEqual([
      { t: Date.UTC(2026, 7, 1), v: 1 },
      { t: Date.UTC(2026, 7, 3), v: 3 },
    ]);
  });

  it("is empty for no rows", () => {
    expect(
      toLinePoints(
        [],
        () => "2026-08-01",
        () => 1,
      ),
    ).toEqual([]);
  });
});
