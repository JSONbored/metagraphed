import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CompareLedger,
  bestIndices,
  type CompareGroup,
} from "./compare-ledger";

const entities = [
  { key: "a", name: "Apex", sub: "SN1", href: "/subnets/1" },
  { key: "b", name: "Targon", sub: "SN4", href: "/subnets/4" },
];

const groups: CompareGroup[] = [
  {
    label: "Economics",
    rows: [
      {
        key: "emission",
        label: "Emission share",
        values: [0.061, 0.038],
        better: "high",
      },
      {
        key: "cost",
        label: "Registration cost",
        values: [12, 4],
        better: "low",
      },
      { key: "slots", label: "Open slots", values: [3, 3], better: "high" },
      { key: "symbol", label: "Symbol", values: ["α", "τ"] },
    ],
  },
];

const render = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    h(CompareLedger, {
      entities,
      groups,
      ariaLabel: "Subnet comparison",
      ...props,
    }),
  );

describe("bestIndices", () => {
  it("picks the highest or the lowest, by the row's own direction", () => {
    expect(
      bestIndices({ key: "k", label: "l", values: [1, 5, 3], better: "high" }),
    ).toEqual([1]);
    expect(
      bestIndices({ key: "k", label: "l", values: [1, 5, 3], better: "low" }),
    ).toEqual([0]);
  });

  it("has no winner for a tie, an undirected row, or one lone value", () => {
    expect(
      bestIndices({ key: "k", label: "l", values: [4, 4], better: "high" }),
    ).toEqual([]);
    expect(bestIndices({ key: "k", label: "l", values: [1, 2] })).toEqual([]);
    expect(
      bestIndices({ key: "k", label: "l", values: [1, null], better: "high" }),
    ).toEqual([]);
  });

  it("ignores unknowns and non-numeric values rather than ranking them", () => {
    expect(
      bestIndices({
        key: "k",
        label: "l",
        values: [null, 2, 9],
        better: "high",
      }),
    ).toEqual([2]);
    expect(
      bestIndices({ key: "k", label: "l", values: ["α", 2, 9], better: "low" }),
    ).toEqual([1]);
    expect(
      bestIndices({
        key: "k",
        label: "l",
        values: [Number.NaN, 3],
        better: "high",
      }),
    ).toEqual([]);
  });
});

describe("CompareLedger markup", () => {
  it("is one column per entity with a pinned label column", () => {
    const html = render();
    expect(html).toContain('aria-label="Subnet comparison"');
    expect(html).toContain('style="--mg-compare-cols:2"');
    expect((html.match(/<th scope="col">/g) ?? []).length).toBe(3);
    expect(html).toContain('<span class="sr-only">Metric</span>');
    expect(html).toContain('href="/subnets/1"');
    expect(html).toContain("<span>SN4</span>");
  });

  it("groups rows under a spanning heading", () => {
    expect(render()).toContain(
      '<th scope="colgroup" colSpan="3">Economics</th>',
    );
  });

  it("tints one winner per directed row, and nothing on a tie or an undirected row", () => {
    const html = render();
    // high → Apex wins emission; low → Targon wins cost; the tie and the
    // symbol row have no winner at all.
    expect((html.match(/data-best="true"/g) ?? []).length).toBe(2);
  });

  it("draws no winner at all when highlighting is off", () => {
    expect(render({ highlightBest: false })).not.toContain("data-best");
  });

  it("keeps the selected columns and metric labels while values load", () => {
    const html = render({ loading: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Emission share");
    expect(html).toContain("Apex");
    expect(html).not.toContain("6.1%");
    expect(html).not.toContain("data-best");
    expect((html.match(/animate-pulse/g) ?? []).length).toBe(
      entities.length * groups[0].rows.length,
    );
  });

  it("renders a missing value as an em dash and formats through the row's own formatter", () => {
    const html = renderToStaticMarkup(
      h(CompareLedger, {
        entities,
        ariaLabel: "x",
        groups: [
          {
            label: "G",
            rows: [
              {
                key: "r",
                label: "Stake",
                values: [1234, null],
                format: (v: number | string) => `${v} τ`,
              },
            ],
          },
        ],
      }),
    );
    expect(html).toContain("1234 τ");
    expect(html).toContain("—");
  });

  it("renders a per-entity spark under the value when the row carries one", () => {
    const html = renderToStaticMarkup(
      h(CompareLedger, {
        entities,
        ariaLabel: "x",
        groups: [
          {
            label: "G",
            rows: [
              {
                key: "r",
                label: "Price",
                values: [1, 2],
                spark: [h("i", { "data-spark": "a" }), null],
              },
            ],
          },
        ],
      }),
    );
    expect(html).toContain('<span class="mg-compare-spark"><i data-spark="a">');
    expect((html.match(/mg-compare-spark/g) ?? []).length).toBe(1);
  });

  it("offers a change control only where the caller wired one", () => {
    const html = render({
      entities: [entities[0], { ...entities[1], onChange: () => {} }],
    });
    expect((html.match(/class="mg-compare-change"/g) ?? []).length).toBe(1);
  });
});
