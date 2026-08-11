import { describe, it, expect } from "vitest";
import {
  isMeasured,
  notObservedNote,
  partitionAndSort,
  provenanceOptions,
  toCoverageRows,
  type CoverageRow,
} from "./coverage-leaderboard-model";

// #10478: the ordering is where this table can do harm. Sorting `null` as `0`
// would rank 127 subnets as the network's worst performers — a claim about each
// of them at once. These tests exist for that.

function row(over: Partial<CoverageRow> = {}): CoverageRow {
  return {
    netuid: 1,
    name: null,
    provenance: null,
    coverage_ratio: null,
    subsidy_multiple: null,
    revenue_usd: null,
    emission_usd: 1000,
    ...over,
  };
}

describe("unmeasured subnets are never ranked", () => {
  const rows = [
    row({ netuid: 64, revenue_usd: 5000, subsidy_multiple: 8.2, provenance: "probe-derived" }),
    row({ netuid: 51, revenue_usd: 200, subsidy_multiple: 40, provenance: "probe-derived" }),
    row({ netuid: 7 }),
    row({ netuid: 3 }),
  ];

  it("partitions them out instead of sorting them to the bottom", () => {
    const { measured, notObserved } = partitionAndSort(rows, "subsidy_multiple", "asc");
    expect(measured.map((r) => r.netuid)).toEqual([64, 51]);
    expect(notObserved.map((r) => r.netuid)).toEqual([3, 7]);
  });

  it("keeps them out of the ranking in BOTH directions", () => {
    // Sorted ascending by subsidy multiple, a null-as-zero would put every
    // unmeasured subnet at the very top as the "best covered" — the same lie
    // wearing the opposite face.
    for (const dir of ["asc", "desc"] as const) {
      const { measured } = partitionAndSort(rows, "subsidy_multiple", dir);
      expect(measured.every(isMeasured)).toBe(true);
      expect(measured).toHaveLength(2);
    }
  });

  it("orders the unmeasured group by netuid — a fact about them", () => {
    const { notObserved } = partitionAndSort(rows, "revenue_usd", "desc");
    expect(notObserved.map((r) => r.netuid)).toEqual([3, 7]);
  });

  it("says why they are listed separately, never '0% covered'", () => {
    const note = notObservedNote(127, 129);
    expect(note).toContain("no observable external revenue");
    expect(note).toContain("not one the data supports");
    expect(note).not.toMatch(/0%|worst performer(?!s —)/);
  });
});

describe("ranking the measured group", () => {
  it("treats an OBSERVED zero as a real value", () => {
    // A subnet measured at zero revenue has been measured. It ranks.
    const rows = [
      row({ netuid: 1, revenue_usd: 0, coverage_ratio: 0 }),
      row({ netuid: 2, revenue_usd: 100, coverage_ratio: 0.5 }),
    ];
    const { measured, notObserved } = partitionAndSort(rows, "coverage_ratio", "desc");
    expect(notObserved).toHaveLength(0);
    expect(measured.map((r) => r.netuid)).toEqual([2, 1]);
  });

  it("sorts a null column LAST in either direction, not as a zero", () => {
    // A measured subnet whose emission side could not be priced has no ratio.
    // It must not top the ascending sort on that column.
    const rows = [
      row({ netuid: 1, revenue_usd: 100, coverage_ratio: null }),
      row({ netuid: 2, revenue_usd: 100, coverage_ratio: 0.9 }),
    ];
    expect(partitionAndSort(rows, "coverage_ratio", "asc").measured.map((r) => r.netuid)).toEqual([
      2, 1,
    ]);
    expect(partitionAndSort(rows, "coverage_ratio", "desc").measured.map((r) => r.netuid)).toEqual([
      2, 1,
    ]);
  });

  it("breaks ties by netuid so the order is stable across renders", () => {
    const rows = [
      row({ netuid: 9, revenue_usd: 100, subsidy_multiple: 2 }),
      row({ netuid: 4, revenue_usd: 100, subsidy_multiple: 2 }),
    ];
    expect(
      partitionAndSort(rows, "subsidy_multiple", "desc").measured.map((r) => r.netuid),
    ).toEqual([4, 9]);
  });
});

describe("the provenance filter", () => {
  const rows = [
    row({ netuid: 64, revenue_usd: 1, provenance: "probe-derived" }),
    row({ netuid: 51, revenue_usd: 1, provenance: "probe-derived" }),
    row({ netuid: 7, provenance: "operator-attested" }),
    row({ netuid: 3 }),
  ];

  it("counts each tier so the thinness of the verified set is visible", () => {
    const options = provenanceOptions(rows);
    expect(options[0]).toEqual({
      value: "probe-derived",
      count: 2,
      headlineEligible: true,
    });
    expect(options.find((o) => o.value === "none")?.count).toBe(1);
    expect(options.find((o) => o.value === "operator-attested")?.headlineEligible).toBe(false);
  });

  it("shows every tier by default", () => {
    const { measured, notObserved } = partitionAndSort(rows, "netuid", "asc");
    expect(measured.length + notObserved.length).toBe(4);
  });

  it("narrows to one tier without reordering the partition rule", () => {
    const { measured, notObserved } = partitionAndSort(rows, "netuid", "asc", {
      provenance: "probe-derived",
    });
    expect(measured.map((r) => r.netuid)).toEqual([51, 64]);
    expect(notObserved).toHaveLength(0);
  });
});

describe("reading the served artifact", () => {
  it("takes the nested revenue block and the emission price", () => {
    const [r] = toCoverageRows([
      {
        netuid: 64,
        name: "Chutes",
        revenue: {
          provenance: "probe-derived",
          coverage_ratio: 0.12,
          subsidy_multiple: 8.2,
          revenue_usd: 5000,
          emission: { usd: 41000 },
        },
      },
    ]);
    expect(r.name).toBe("Chutes");
    expect(r.provenance).toBe("probe-derived");
    expect(r.emission_usd).toBe(41000);
  });

  it("drops a row with no netuid rather than rendering a nameless one", () => {
    expect(toCoverageRows([{ name: "x" }, null, "nope"])).toEqual([]);
    expect(toCoverageRows(null)).toEqual([]);
  });
});
