import { describe, expect, it } from "vitest";
import {
  placeTooltip,
  tooltipPlacement,
  TOOLTIP_GAP_PX,
} from "./chart-tooltip-logic";

const container = { left: 100, right: 700, width: 600 };

describe("placeTooltip", () => {
  it("sits 8px to the right of the mark, relative to the container", () => {
    const mark = { left: 150, right: 170, width: 20 };
    expect(placeTooltip(mark, container, 192)).toBe(170 - 100 + TOOLTIP_GAP_PX);
  });

  it("flips to the left of the mark when the right side would overflow", () => {
    const mark = { left: 600, right: 620, width: 20 };
    expect(placeTooltip(mark, container, 192)).toBe(
      600 - 100 - TOOLTIP_GAP_PX - 192,
    );
  });

  it("clamps at 0 when neither side fits", () => {
    const mark = { left: 120, right: 140, width: 20 };
    expect(placeTooltip(mark, { left: 100, right: 300, width: 200 }, 220)).toBe(
      0,
    );
  });

  it("rounds to whole pixels", () => {
    const mark = { left: 150.4, right: 170.6, width: 20.2 };
    expect(Number.isInteger(placeTooltip(mark, container, 192))).toBe(true);
  });
});

describe("tooltipPlacement", () => {
  it("is a static panel below 640px and floats from 640px up", () => {
    expect(tooltipPlacement(375)).toBe("static");
    expect(tooltipPlacement(639)).toBe("static");
    expect(tooltipPlacement(640)).toBe("float");
    expect(tooltipPlacement(1280)).toBe("float");
  });
});
