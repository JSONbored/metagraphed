import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InteractiveDataField } from "./interactive-data-field";

describe("InteractiveDataField", () => {
  it("uses the largest displayed observation as the visual scale", () => {
    const html = renderToStaticMarkup(
      createElement(InteractiveDataField, {
        ariaLabel: "Price share distribution",
        data: [
          {
            id: "leader",
            label: "Leader",
            valueLabel: "5.00%",
            value: 0.05,
            ariaLabel: "Leader, 5.00%",
            tone: "chart-1",
          },
          {
            id: "second",
            label: "Second",
            valueLabel: "2.50%",
            value: 0.025,
            ariaLabel: "Second, 2.50%",
            tone: "chart-2",
          },
        ],
      }),
    );

    expect(html).toContain("--mg-data-field-bar-height:100%");
    expect(html).toContain("--mg-data-field-bar-height:50%");
  });
});
