import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActiveEntityProvider } from "../interaction/active-entity";
import { momentumAriaLabel } from "./chart-aria";
import { LineWithWindow, lineSpecimen } from "./line-with-window";
import {
  StackedColumns,
  stackScrollState,
  stackedSpecimen,
} from "./stacked-columns";

// SSR-markup checks in the suite's plain-node environment; hover, keyboard
// and the scroll position are covered by the Playwright interaction project.

const render = (node: ReturnType<typeof h>) =>
  renderToStaticMarkup(h(ActiveEntityProvider, null, node));

describe("StackedColumns", () => {
  const spec = stackedSpecimen();
  const html = render(
    h(StackedColumns, {
      ...spec,
      ariaLabel: "Daily emission by subnet",
      formatValue: (v: number) => `${v}τ`,
    }),
  );

  it("is one column button per period, named by its period and total", () => {
    const buttons = html.match(/class="mg-stack-col"/g) ?? [];
    expect(buttons.length).toBe(spec.columns.length);
    const last = spec.columns[spec.columns.length - 1]!;
    expect(html).toContain(`aria-label="${last.label} · ${last.total}τ total"`);
    expect(html).toContain(
      'role="group" aria-label="Daily emission by subnet"',
    );
  });

  it("gives each series a ramp swatch in order and collapses the rest into Other", () => {
    for (let i = 0; i < spec.seriesOrder.length; i++) {
      expect(html).toContain(`--swatch:var(--chart-${i + 1})`);
    }
    expect(html).toContain('data-entity="Other"');
    expect(html).toContain("--swatch:var(--chart-residual)");
    expect(html).not.toContain("--chart-12");
  });

  it("hides every axis label that is off the weekly cadence at rest", () => {
    const hidden = html.match(/data-label-hidden="true"/g) ?? [];
    expect(hidden.length).toBe(
      spec.columns.length - Math.ceil(spec.columns.length / 7),
    );
    expect(html).toContain('class="mg-stack-axis-total"');
  });

  it("carries the same numbers in a visually hidden table", () => {
    expect(html).toContain(
      '<div class="mg-sr-table"><table><caption>Daily emission by subnet</caption>',
    );
    expect(html).toContain(
      '<th scope="col">Period</th><th scope="col">Total</th>',
    );
    const rows = html.match(/<th scope="row">/g) ?? [];
    expect(rows.length).toBe(spec.columns.length);
  });

  it("makes the bars row the marks group, so one tooltip and one Tab stop serve it", () => {
    expect(html).toContain(
      'class="mg-stack-bars" role="group" aria-label="Daily emission by subnet" data-marks',
    );
    // SSR renders the tooltip host empty; it fills in after mount.
    expect(html).not.toContain("mg-chart-tooltip-head");
  });

  it("keeps the temporal plot's geometry while its series is loading", () => {
    const loading = render(
      h(StackedColumns, {
        columns: [],
        seriesOrder: spec.seriesOrder,
        ariaLabel: "Daily emission by subnet",
        loading: true,
        loadingColumns: 7,
      }),
    );
    expect(loading).toContain('data-loading="true"');
    expect(loading).toContain(
      'class="mg-stack-bars" role="group" aria-label="Daily emission by subnet" aria-busy="true"',
    );
    expect((loading.match(/mg-stack-col--skeleton/g) ?? []).length).toBe(7);
    expect(loading).not.toContain("mg-sr-table");
  });

  it("reports an explicit horizontal-scroll boundary state instead of fading data", () => {
    expect(
      stackScrollState({ clientWidth: 240, scrollWidth: 600, scrollLeft: 0 }),
    ).toEqual({ overflow: true, atStart: true, atEnd: false });
    expect(
      stackScrollState({ clientWidth: 240, scrollWidth: 600, scrollLeft: 360 }),
    ).toEqual({ overflow: true, atStart: false, atEnd: true });
    expect(
      stackScrollState({ clientWidth: 240, scrollWidth: 240, scrollLeft: 0 }),
    ).toEqual({ overflow: false, atStart: true, atEnd: true });
  });
});

describe("LineWithWindow", () => {
  const spec = lineSpecimen(90);
  const html = render(
    h(LineWithWindow, {
      ...spec,
      unit: "tokens",
      ariaLabel: "Tokens per day",
      formatValue: (v: number) => `${v}T`,
    }),
  );

  it("reads the window end and its delta in the summary and the end chip", () => {
    const end = spec.points[spec.points.length - 1]!.v;
    expect(html).toContain(`<strong>${end}T</strong>`);
    const chips =
      html.match(/class="mg-line-(delta|end)" data-state="positive"/g) ?? [];
    expect(chips.length).toBe(2);
    expect(html).toMatch(/class="mg-line-delta" data-state="positive">\+\d+%</);
  });

  it("draws the muted history under the accent window, with three markers and no fill", () => {
    expect(html).toContain('class="mg-line-muted" d="M0 ');
    expect(html).toContain('class="mg-line-active" d="M');
    const markers = html.match(/class="mg-line-marker"/g) ?? [];
    expect(markers.length).toBe(3);
    expect(
      (html.match(/class="mg-line-marker" data-window="true"/g) ?? []).length,
    ).toBe(2);
    expect(html).not.toContain("<rect");
    expect(html).not.toContain("fill=");
  });

  it("is one mark per point, named by date and value, plus a months row", () => {
    const hits = html.match(/class="mg-line-hit"/g) ?? [];
    expect(hits.length).toBe(spec.points.length);
    expect(html).toContain(`aria-label="APR 24 · ${spec.points[0]!.v}T total"`);
    expect(html).toContain('class="mg-line-months"');
    expect(html).toMatch(/<span style="left:[\d.]+%">MAY<\/span>/);
    expect(html).toContain(
      'aria-label="Tokens: ' + spec.points[spec.points.length - 1]!.v + "T, ",
    );
  });

  it("compact drops the summary and the months row but keeps the marks and the table", () => {
    const compact = render(
      h(LineWithWindow, {
        ...spec,
        unit: "tokens",
        ariaLabel: "Tokens per day",
        compact: true,
      }),
    );
    expect(compact).toContain('data-compact="true"');
    expect(compact).not.toContain("mg-line-summary");
    expect(compact).not.toContain("mg-line-months");
    expect((compact.match(/class="mg-line-hit"/g) ?? []).length).toBe(
      spec.points.length,
    );
    expect(compact).toContain("<caption>Tokens per day</caption>");
  });

  it("an empty window renders no chip and says so in the group name", () => {
    const empty = render(
      h(LineWithWindow, {
        points: spec.points,
        window: { from: 0, to: 1 },
        unit: "tokens",
        ariaLabel: "Tokens per day",
      }),
    );
    expect(empty).toContain('data-state="empty"');
    expect(empty).not.toContain("mg-line-end");
    expect(empty).toContain('aria-label="Tokens: no data in the window"');
    expect(empty).toContain("<strong>—</strong>");
  });

  it("keeps the chart's full geometry while a time series is loading", () => {
    const loading = render(
      h(LineWithWindow, {
        ...spec,
        unit: "tokens",
        ariaLabel: "Tokens per day",
        loading: true,
      }),
    );
    expect(loading).toContain('data-loading="true"');
    expect(loading).toContain('class="mg-line-summary"');
    expect(loading).toContain(
      'class="mg-line-plot" role="group" aria-label="Tokens per day" aria-busy="true"',
    );
    expect(loading).not.toContain("mg-line-hit");
  });
});

describe("momentumAriaLabel", () => {
  it("is the unit, the end value, the delta and the range", () => {
    expect(momentumAriaLabel("tokens", "254T", "+89%", "JUN 28 → AUG 22")).toBe(
      "Tokens: 254T, +89% over JUN 28 → AUG 22",
    );
    expect(momentumAriaLabel("TAO", "1.2k", "—", "")).toBe("TAO: 1.2k, —");
    expect(momentumAriaLabel("tokens", null, "—", "x")).toBe(
      "Tokens: no data in the window",
    );
  });
});
