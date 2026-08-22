import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChartTooltip } from "./chart-tooltip";
import { Definition, DefinitionsProvider } from "./definition";
import { Raw, RawCode } from "./raw";

// SSR-markup checks in the suite's plain-node environment; the hover /
// focus / tap behaviour is covered by the Playwright interaction project.

describe("Definition", () => {
  it("renders nothing when the term is not in the glossary", () => {
    expect(renderToStaticMarkup(h(Definition, { term: "Nowhere" }))).toBe("");
  });

  it("renders a 'What is …' button for a glossary term, closed at rest", () => {
    const html = renderToStaticMarkup(
      h(DefinitionsProvider, {
        definitions: {
          "Emission share": "The slice of TAO a subnet mints per block.",
        },
        children: h(Definition, { term: "Emission share" }),
      }),
    );
    expect(html).toContain('aria-label="What is Emission share"');
    expect(html).toContain('class="mg-definition-button"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="tooltip"');
  });

  it("an explicit sentence overrides the glossary and needs no provider", () => {
    const html = renderToStaticMarkup(
      h(Definition, { term: "Take", sentence: "The validator's cut." }),
    );
    expect(html).toContain('aria-label="What is Take"');
  });
});

describe("Raw", () => {
  it("is a <details> row with the RAW chip, full copyable values and a code block", () => {
    const html = renderToStaticMarkup(
      h(Raw, {
        rows: [
          {
            label: "Coldkey",
            value: "5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9",
          },
          {
            label: "OpenAPI",
            value: "https://api.metagraph.sh/openapi.json",
            href: "https://api.metagraph.sh/openapi.json",
          },
        ],
        children: h(RawCode, {
          label: "curl",
          children: "curl https://api.metagraph.sh/api/v1/subnets/1",
        }),
      }),
    );
    expect(html).toMatch(/^<details[^>]*class="mg-raw"/);
    expect(html).toContain("Raw identifiers &amp; sources");
    expect(html).toContain('class="mg-raw-chip"');
    expect(html).toContain(
      "5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9</code>",
    );
    expect(html).toContain('href="https://api.metagraph.sh/openapi.json"');
    expect(html).toContain('aria-label="Copy Coldkey"');
    expect(html).toContain('class="mg-raw-code"');
    expect(html).not.toContain(" open");
  });

  it("defaultOpen renders the open attribute", () => {
    expect(
      renderToStaticMarkup(h(Raw, { defaultOpen: true, title: "Sources" })),
    ).toContain("<details");
    expect(
      renderToStaticMarkup(h(Raw, { defaultOpen: true, title: "Sources" })),
    ).toContain(" open");
  });
});

describe("ChartTooltip", () => {
  it("renders only its (display: contents) host without an active entity", () => {
    const html = renderToStaticMarkup(h("div", null, h(ChartTooltip, null)));
    expect(html).toContain("data-mg-tooltip-host");
    expect(html).not.toContain("mg-chart-tooltip");
  });
});
