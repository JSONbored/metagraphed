import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  COMPOSITION_TIMELINE_TONES,
  CompositionTimeline,
  compositionToneAt,
  type CompositionTimelineColumn,
  type CompositionTimelineSeries,
  formatCompositionShare,
  resolveColumnEmphasis,
  resolveSegmentEmphasis,
  segmentRows,
} from "./composition-timeline";

// This package's suite is node-environment with no jsdom, so interaction is
// pinned through the pure resolvers that decide it and the SSR markup that
// exposes it. The resolvers are the contract; the component only spends them.

const series: CompositionTimelineSeries[] = [
  { id: "subnet:1", label: "SN1", tone: "chart-1" },
  { id: "subnet:2", label: "SN2", tone: "chart-2" },
  { id: "other", label: "Other", residual: true },
];

const columns: CompositionTimelineColumn[] = [
  {
    id: "2026-06-01",
    label: "1 June 2026",
    axisLabel: "06/01",
    caption: "128 priced subnets",
    shares: { "subnet:1": 0.6, "subnet:2": 0.3, other: 0.1 },
  },
  {
    id: "2026-06-02",
    label: "2 June 2026",
    axisLabel: "06/02",
    caption: "129 priced subnets",
    shares: { "subnet:1": 0.5, "subnet:2": 0.4, other: 0.1 },
  },
];

describe("the #11547 cross-filter contract", () => {
  it("keeps every series vivid at rest, so the chart is not dull until hovered", () => {
    for (const column of columns) {
      for (const entry of series) {
        expect(
          resolveSegmentEmphasis({ kind: "none" }, column.id, entry.id),
        ).toBe("vivid");
      }
    }
  });

  it("turns the OTHER days graphite when one day is inspected, keeping that day's full palette", () => {
    const inspection = { kind: "column", id: "2026-06-01" } as const;

    // The inspected day keeps every one of its series vivid.
    for (const entry of series) {
      expect(resolveSegmentEmphasis(inspection, "2026-06-01", entry.id)).toBe(
        "vivid",
      );
    }
    // Every series on every other day recedes.
    for (const entry of series) {
      expect(resolveSegmentEmphasis(inspection, "2026-06-02", entry.id)).toBe(
        "graphite",
      );
    }
  });

  it("keeps one series vivid across ALL days when that series is inspected", () => {
    const inspection = { kind: "series", id: "subnet:2" } as const;

    for (const column of columns) {
      expect(resolveSegmentEmphasis(inspection, column.id, "subnet:2")).toBe(
        "vivid",
      );
      expect(resolveSegmentEmphasis(inspection, column.id, "subnet:1")).toBe(
        "graphite",
      );
      expect(resolveSegmentEmphasis(inspection, column.id, "other")).toBe(
        "graphite",
      );
    }
  });

  it("does not single out a day while a series is inspected", () => {
    // The claim being made is about the whole span, so no lane may take the
    // active treatment — that would read as "this series, on this day".
    const inspection = { kind: "series", id: "subnet:1" } as const;
    for (const column of columns) {
      expect(resolveColumnEmphasis(inspection, column.id)).toBe("rest");
    }
  });

  it("recedes the lanes around an inspected day", () => {
    const inspection = { kind: "column", id: "2026-06-02" } as const;
    expect(resolveColumnEmphasis(inspection, "2026-06-02")).toBe("active");
    expect(resolveColumnEmphasis(inspection, "2026-06-01")).toBe("receded");
  });
});

describe("compositionToneAt", () => {
  it("never gives two adjacent series neighbouring ramp positions", () => {
    // Walking the ramp in order produced four adjacent violets in a six-subnet
    // cohort. Adjacent stack segments must land far apart on the wheel.
    const ramp = COMPOSITION_TIMELINE_TONES;
    for (let i = 0; i < 6; i += 1) {
      const a = ramp.indexOf(compositionToneAt(i));
      const b = ramp.indexOf(compositionToneAt(i + 1));
      const gap = Math.min(Math.abs(a - b), ramp.length - Math.abs(a - b));
      expect(gap).toBeGreaterThanOrEqual(3);
    }
  });

  it("visits every tone before repeating one", () => {
    const seen = new Set(
      Array.from({ length: COMPOSITION_TIMELINE_TONES.length }, (_, i) =>
        compositionToneAt(i),
      ),
    );
    expect(seen.size).toBe(COMPOSITION_TIMELINE_TONES.length);
  });

  it("is a pure function of the cohort index, so a colour is stable", () => {
    expect(compositionToneAt(3)).toBe(compositionToneAt(3));
    expect(compositionToneAt(0)).toBe(COMPOSITION_TIMELINE_TONES[0]);
  });
});

describe("segmentRows", () => {
  it("lays segments out against the observed total, not an assumed 1.0", () => {
    // Six-decimal source rounding leaves a total just under one. Dividing by
    // the real total keeps the stack flush rather than leaving a sliver of
    // rail showing on some columns and not others.
    const { rows, total } = segmentRows(series, {
      "subnet:1": 0.599999,
      "subnet:2": 0.3,
      other: 0.1,
    });
    expect(total).toBeCloseTo(0.999999, 6);
    const percentages = rows.split(" ").map((row) => Number.parseFloat(row));
    expect(percentages.reduce((sum, value) => sum + value, 0)).toBeCloseTo(
      100,
      6,
    );
  });

  it("treats a missing, negative, or non-finite share as absent rather than as a mark", () => {
    const { rows, total } = segmentRows(series, {
      "subnet:1": 1,
      "subnet:2": -0.5,
      other: Number.NaN,
    });
    expect(total).toBe(1);
    expect(rows).toBe("100% 0% 0%");
  });

  it("reports an empty total for a column with nothing in it", () => {
    expect(segmentRows(series, {})).toEqual({ rows: "", total: 0 });
  });
});

describe("formatCompositionShare", () => {
  it("keeps small shares legible instead of collapsing them to 0.0%", () => {
    expect(formatCompositionShare(0.4213)).toBe("42.1%");
    expect(formatCompositionShare(0.0512)).toBe("5.12%");
    expect(formatCompositionShare(0.00042)).toBe("0.042%");
  });

  it("renders a genuine absence as a flat zero", () => {
    expect(formatCompositionShare(0)).toBe("0%");
    expect(formatCompositionShare(Number.NaN)).toBe("0%");
  });
});

describe("CompositionTimeline markup", () => {
  const html = renderToStaticMarkup(
    createElement(CompositionTimeline, {
      ariaLabel: "Daily price-share composition.",
      series,
      columns,
    }),
  );

  it("makes each day a real control, with one roving tab stop", () => {
    expect(html).toContain('aria-label="1 June 2026. 128 priced subnets"');
    // Exactly one lane is in the tab order; arrow keys reach the rest.
    expect(html.match(/tabindex="0"/g) ?? []).toHaveLength(1);
    expect(html).toContain('tabindex="-1"');
  });

  it("ships the nonvisual table this genre usually omits", () => {
    // The reference implementation at opencode.ai/data has no table and no
    // sr-only region at all, so this is deliberately stricter than the model.
    // The hidden table must carry its own containment class: the shared
    // sr-only utility does not constrain a table's layout box.
    expect(html).toContain('<table class="mg-composition-timeline-data"');
    expect(html).toContain("<caption>Daily price-share composition.</caption>");
    // Every day contributes a row carrying the same numbers as the marks.
    expect(html).toContain('<th scope="row">1 June 2026</th>');
    expect(html).toContain('<th scope="row">2 June 2026</th>');
    expect(html).toContain("<td>60.0%</td>");
    expect(html).toContain("<td>30.0%</td>");
  });

  it("orders a derived residual last and says that it is derived", () => {
    const otherHeader = html.indexOf("Other (derived)");
    const sn2Header = html.indexOf("SN2");
    expect(otherHeader).toBeGreaterThan(-1);
    expect(otherHeader).toBeGreaterThan(sn2Header);
  });

  it("gives every series a stable tone and never spends mint on data", () => {
    expect(html).toContain('data-tone="chart-1"');
    expect(html).toContain('data-tone="chart-2"');
    // The residual draws neutral, never as a categorical tone — a ramp colour
    // here reads as an alert state on what is only "everything else".
    expect(html).toContain('data-tone="residual"');
    expect(html).not.toContain('data-tone="chart-11"');
    // Mint is the focus ring only; it must not appear as a datum's tone.
    expect(html).not.toContain("brand-green");
  });

  it("renders nothing rather than an empty frame when there is no data", () => {
    expect(
      renderToStaticMarkup(
        createElement(CompositionTimeline, {
          ariaLabel: "Empty.",
          series,
          columns: [],
        }),
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        createElement(CompositionTimeline, {
          ariaLabel: "Empty.",
          series: [],
          columns,
        }),
      ),
    ).toBe("");
  });
});
