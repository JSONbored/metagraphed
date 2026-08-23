import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActiveEntityProvider } from "../interaction/active-entity";
import { CompositionBreakdown } from "./composition-breakdown";
import { RESIDUAL_KEY } from "./series-palette";
import { LeaderCards, deltaLabel } from "./leader-cards";
import { MarkerRail, markerPosition } from "./marker-rail";
import { RankGrid } from "./rank-grid";
import { RankedRails, railFill } from "./ranked-rails";
import {
  COMPOSITION_SPECIMEN,
  LEADER_SPECIMEN,
  MARKER_SPECIMEN,
  RAIL_SPECIMEN,
} from "./rank-specimens";

const render = (node: ReturnType<typeof h>) =>
  renderToStaticMarkup(h(ActiveEntityProvider, null, node));
const fmt = (v: number) => `${Math.round(v / 1000)}k`;

describe("railFill", () => {
  it("is the linear share of max, or its square root for heavy tails", () => {
    expect(railFill(50, 200)).toBe(25);
    expect(railFill(50, 200, "sqrt")).toBe(50);
    expect(railFill(400, 200)).toBe(100);
    expect(railFill(0, 200)).toBe(0);
    expect(railFill(5, 0)).toBe(0);
  });
});

describe("markerPosition", () => {
  it("clamps to the rail and is null without a value", () => {
    expect(markerPosition(99.8, 100)).toBe(99.8);
    expect(markerPosition(0.5, 1)).toBe(50);
    expect(markerPosition(140, 100)).toBe(100);
    expect(markerPosition(null, 100)).toBeNull();
    expect(markerPosition(Number.NaN, 100)).toBeNull();
  });
});

describe("RankedRails", () => {
  it("renders `limit` rows as marks with a Show all button, and a second track when secondary values exist", () => {
    const html = render(
      h(RankedRails, {
        items: RAIL_SPECIMEN,
        formatValue: fmt,
        ariaLabel: "Validators by stake",
        columns: {
          value: "Stake",
          name: "Validator",
          track: "0–100%",
          secondary: "Emission",
        },
      }),
    );
    expect((html.match(/class="mg-rails-row"/g) ?? []).length).toBe(10);
    expect(html).toContain(">Show all 12<");
    expect(html).toContain('data-secondary="true"');
    expect(html).toContain('aria-label="Targon · 1890k total"');
    expect(html).toContain("--fill:100%");
    expect(html).toContain(
      '<div class="mg-rails-head" aria-hidden="true"><span>Stake</span>',
    );
    expect(html).toContain(
      'role="group" aria-label="Validators by stake" data-marks',
    );
  });

  it("scales the second track against its own largest when asked", () => {
    // Shared is right for commensurate series (stake in / stake out). It is
    // wrong when they are not: a validator's stake beside its emission is
    // four orders of magnitude apart, so on a shared cap every emission track
    // drew the same flat line and carried no information.
    const items = [
      { key: "a", label: "A", value: 1_000_000, secondary: 120 },
      { key: "b", label: "B", value: 500_000, secondary: 60 },
    ];
    const shared = render(
      h(RankedRails, { items, formatValue: String, ariaLabel: "x" }),
    );
    const own = render(
      h(RankedRails, {
        items,
        formatValue: String,
        secondaryScale: "own",
        ariaLabel: "x",
      }),
    );
    // Shared: both emissions round to nothing against a 1,000,000 cap.
    expect((shared.match(/--fill:0%/g) ?? []).length).toBe(2);
    // Own: the largest emission fills its track and the other is half of it.
    expect(own).toContain("--fill:100%");
    expect(own).toContain("--fill:50%");
    expect(own).not.toContain("--fill:0%");
  });

  it("pins the scale to `max` and renders links as anchors", () => {
    const html = render(
      h(RankedRails, {
        items: [{ key: "a", label: "A", value: 50, href: "/a" }],
        formatValue: String,
        max: 200,
        ariaLabel: "x",
      }),
    );
    expect(html).toContain("--fill:25%");
    expect(html).toMatch(/<a [^>]*href="\/a"[^>]*class="mg-rails-row"/);
    expect(html).not.toContain("mg-rails-more");
  });
});

describe("MarkerRail", () => {
  it("always shows the header and leaves a null value without a marker", () => {
    const html = render(
      h(MarkerRail, {
        items: MARKER_SPECIMEN,
        formatValue: (v: number) => `${v.toFixed(1)}%`,
        columns: { ratio: "Uptime", name: "Surface", scale: "0–100%" },
        ariaLabel: "Uptime by surface",
      }),
    );
    expect(html).toContain(
      "<span>Uptime</span><span>Surface</span><span>0–100%</span>",
    );
    expect(html).toContain("--pos:99.8%");
    expect(html).toContain('class="mg-marker-rail-track" data-empty="true"');
    expect(html).toContain('<span class="mg-rails-value">—</span>');
    expect(html).toContain('<span class="mg-rails-tag">openapi</span>');
    expect(html).toContain('aria-label="SSE feed"');
  });
});

describe("RankGrid", () => {
  it("numbers rows from `start`, carries the column count and outlines the current row", () => {
    const html = render(
      h(RankGrid, {
        items: [
          {
            key: "a",
            label: "Apex",
            value: "1.2k",
            share: "40%",
            swatch: "var(--chart-1)",
          },
          {
            key: "b",
            label: "Bitmind",
            value: "900",
            share: "30%",
            href: "/subnets/2",
            current: true,
          },
        ],
        cols: 5,
        start: 9,
        ariaLabel: "Peers",
      }),
    );
    expect(html).toContain('style="--cols:5"');
    expect(html).toContain('<span class="mg-rank-grid-rank">09</span>');
    expect(html).toContain('<span class="mg-rank-grid-rank">10</span>');
    expect(html).toContain('<li data-current="true"><a ');
    expect(html).toContain('href="/subnets/2"');
    expect(html).toContain("--swatch:var(--chart-1)");
    expect(html).toContain("--swatch:var(--faint)");
  });
});

describe("LeaderCards", () => {
  it("splits featured from compact and formats deltas", () => {
    const html = render(
      h(LeaderCards, { items: LEADER_SPECIMEN, ariaLabel: "Top subnets" }),
    );
    expect((html.match(/data-variant="featured"/g) ?? []).length).toBe(3);
    expect((html.match(/data-variant="compact"/g) ?? []).length).toBe(9);
    expect((html.match(/class="mg-leader-watermark"/g) ?? []).length).toBe(3);
    expect(html).toContain(
      '<span class="mg-leader-delta" data-state="new">New</span>',
    );
    expect(html).toContain('aria-label="#1 Targon · 1.89M τ total"');
  });

  it("deltaLabel", () => {
    expect(deltaLabel(0.89)).toEqual({ text: "+89%", state: "positive" });
    expect(deltaLabel(-0.12)).toEqual({ text: "−12%", state: "negative" });
    expect(deltaLabel(0.001)).toEqual({ text: "0%", state: "flat" });
    expect(deltaLabel("new")).toEqual({ text: "New", state: "new" });
    expect(deltaLabel(undefined)).toEqual({ text: "", state: "none" });
  });
});

describe("CompositionBreakdown", () => {
  it("shares one key between each segment and its legend row, largest first", () => {
    const html = render(
      h(CompositionBreakdown, {
        segments: COMPOSITION_SPECIMEN,
        formatValue: (v: number) => `${v}%`,
        ariaLabel: "Emission split",
      }),
    );
    expect(html).toContain('data-entity="Targon"');
    expect(html).toContain("--share:41%");
    expect(html).toContain(
      'aria-label="Emission split: Targon 41%, Chutes 41%, Affine 18%"',
    );
    expect(html).toContain('aria-label="Targon · 41% total"');
    expect(html).toContain("--swatch:var(--chart-1)");
  });

  it("collapses past `limit` into Other", () => {
    const html = render(
      h(CompositionBreakdown, {
        segments: [
          { key: "a", label: "A", value: 5 },
          { key: "b", label: "B", value: 4 },
          { key: "c", label: "C", value: 1 },
        ],
        limit: 2,
        formatValue: String,
        ariaLabel: "Mix",
      }),
    );
    expect(html).toContain('data-entity="Other"');
    expect(html).not.toContain('data-entity="c"');
    expect(html).toContain("--swatch:var(--chart-11)");
  });
});

describe("CompositionBreakdown residual ordering (#11616)", () => {
  const segments = [
    { key: "a", label: "Alpha", value: 10 },
    { key: RESIDUAL_KEY, label: "595 more operators", value: 90 },
    { key: "b", label: "Beta", value: 20 },
  ];
  const html = renderToStaticMarkup(
    h(CompositionBreakdown, {
      segments,
      formatValue: (v: number) => String(v),
      ariaLabel: "Test composition",
    }),
  );
  const order = [...html.matchAll(/data-entity="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((key, i, all) => all.indexOf(key) === i);

  it("pins a caller's residual last however large it is", () => {
    // A residual is not a peer of the named segments; sorting it by value put
    // "595 more operators" at rank 01 of a concentration chart -- the reading
    // the chart exists to give, stated backwards.
    expect(order).toHaveLength(3);
    expect(order.slice(0, 2)).toEqual(["b", "a"]);
  });

  it("keeps the caller's own label on it, rather than the ramp's Other", () => {
    // The caller knows what it rolled up; the ramp does not.
    expect(html).toContain("595 more operators");
    expect(html).not.toMatch(/mg-rank-grid-name">Other</);
  });
});
