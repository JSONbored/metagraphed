import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Sparkline } from "@/components/metagraphed/charts/sparkline";
import { CandlestickMini } from "@/components/metagraphed/charts/candlestick-mini";
import {
  CANDLESTICK_MINI_EMPTY_ARIA_LABEL,
  SPARKLINE_EMPTY_ARIA_LABEL,
} from "@/components/metagraphed/charts/chart-aria";

// #6375: both primitives' empty-data branch rendered an <svg> with no
// role="img" and, when ariaLabel was omitted, no accessible name at all -- while
// their own populated branches set both, and every sibling primitive
// (BarMini/Donut via chart-aria, NoDataSpark, MiniStack) has a safety net. A
// screen-reader user hit an unlabeled graphic.
const html = (element: React.ReactElement) => renderToStaticMarkup(element);

const CANDLE = {
  label: "12:00 UTC",
  open: 1,
  high: 2,
  low: 0.5,
  close: 1.5,
};

describe("chart primitives' empty state keeps an accessible name (#6375)", () => {
  const empties: Array<[string, React.ReactElement, string]> = [
    [
      "Sparkline",
      React.createElement(Sparkline, { values: [] }),
      SPARKLINE_EMPTY_ARIA_LABEL,
    ],
    [
      "CandlestickMini",
      React.createElement(CandlestickMini, { data: [] }),
      CANDLESTICK_MINI_EMPTY_ARIA_LABEL,
    ],
  ];

  for (const [name, element, fallback] of empties) {
    it(`${name}'s empty state is a named role="img"`, () => {
      const markup = html(element);
      expect(markup).toContain('role="img"');
      expect(markup).toContain(`aria-label="${fallback}"`);
    });
  }

  it("an explicit ariaLabel still wins over the synthesized fallback", () => {
    expect(
      html(
        React.createElement(Sparkline, { values: [], ariaLabel: "Emission" }),
      ),
    ).toContain('aria-label="Emission"');
    expect(
      html(
        React.createElement(CandlestickMini, {
          data: [],
          ariaLabel: "TAO price",
        }),
      ),
    ).toContain('aria-label="TAO price"');
  });

  // The empty branch is now no worse than the populated one, which is the
  // parity the issue asks for -- both are named graphics.
  it("matches the populated branch, which already set role + label", () => {
    const populatedSpark = html(
      React.createElement(Sparkline, { values: [1, 2, 3], ariaLabel: "Trend" }),
    );
    expect(populatedSpark).toContain('role="img"');
    expect(populatedSpark).toContain('aria-label="Trend"');

    const populatedCandles = html(
      React.createElement(CandlestickMini, {
        data: [CANDLE, { ...CANDLE, label: "13:00 UTC" }],
        ariaLabel: "Price",
      }),
    );
    expect(populatedCandles).toContain('role="img"');
    expect(populatedCandles).toContain('aria-label="Price"');
  });

  // Phrasing is pinned so the fallbacks keep matching chart-aria's existing
  // synthesizeBarMiniAriaLabel/synthesizeDonutAriaLabel convention.
  it("fallback phrasing matches the sibling helpers' convention", () => {
    expect(SPARKLINE_EMPTY_ARIA_LABEL).toMatch(/ with no data$/);
    expect(CANDLESTICK_MINI_EMPTY_ARIA_LABEL).toMatch(/ with no data$/);
  });
});
