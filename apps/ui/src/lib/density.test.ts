import React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useDensity } from "./density";

function DensityProbe() {
  const { density } = useDensity();
  return React.createElement("output", null, density);
}

describe("useDensity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to comfortable when localStorage.getItem throws during initial render", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() => {
          throw new Error("storage blocked");
        }),
      },
    });

    expect(() => renderToString(React.createElement(DensityProbe))).not.toThrow();
    expect(renderToString(React.createElement(DensityProbe))).toContain("comfortable");
  });
});
