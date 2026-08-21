import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DataPageCanvas,
  DataPageDisclosure,
  DataPageHero,
  DataPageModule,
  DataPageStage,
  DataPageWindowTabs,
} from "./data-page";

describe("data page primitives", () => {
  it("renders a focused live hero and continuous canvas", () => {
    const html = renderToStaticMarkup(
      createElement(
        DataPageStage,
        null,
        createElement(DataPageHero, {
          eyebrow: "Network registry",
          title: "Subnets.",
          description: "Browse live network data.",
          live: true,
          id: "subnets-title",
          footer: createElement("span", null, "128 active"),
        }),
        createElement(
          DataPageCanvas,
          null,
          createElement(DataPageModule, {
            title: "Browse",
            caption: "Ranked by stake.",
            children: "Rows",
          }),
        ),
      ),
    );

    expect(html).toContain('class="mg-page-stage"');
    expect(html).toContain('aria-labelledby="subnets-title"');
    expect(html).toContain("mg-page-kicker-dot");
    expect(html).toContain('class="mg-page-canvas"');
    expect(html).toContain('class="mg-page-module mg-page-module--task"');
    expect(html).toContain("Ranked by stake.");
  });

  it("supports a quiet disclosure instead of adding explanatory page density", () => {
    const html = renderToStaticMarkup(
      createElement(DataPageDisclosure, {
        label: "How this is measured",
        children: "Methodology",
      }),
    );

    expect(html).toContain("mg-page-disclosure");
    expect(html).toContain("How this is measured");
    expect(html).toContain("Methodology");
  });

  it("offers an operations canvas without forcing routes to own a layout class", () => {
    const html = renderToStaticMarkup(
      createElement(DataPageCanvas, { variant: "operations", children: "Live health" }),
    );

    expect(html).toContain("mg-page-canvas--operations");
  });

  it("keeps a time-window choice inside the analytical module grammar", () => {
    const html = renderToStaticMarkup(
      createElement(DataPageWindowTabs, {
        label: "Analytics time window",
        options: [
          { value: "7d", label: "7 days" },
          { value: "30d", label: "30 days" },
        ],
        value: "7d",
        onValueChange: () => undefined,
      }),
    );

    expect(html).toContain('role="tablist"');
    expect(html).toContain("mg-data-window");
    expect(html).toContain('aria-selected="true"');
  });
});
