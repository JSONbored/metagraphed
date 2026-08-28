import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalyticsSection } from "./analytics-section";
import { AnalyticsPage, MAX_SECTIONS, sectionItems } from "./analytics-page";
import {
  pickActiveSection,
  sectionNavScrollState,
  SectionNav,
} from "./section-nav";
import { FactCell, FactStrip, type FactCells } from "./fact-strip";
import { Fact, FactSentence } from "./fact-sentence";
import { LiveMeta } from "./live-meta";
import { RangeControl } from "./range-control";
import { EntityHero } from "./entity-hero";

const section = (n: number) =>
  h(AnalyticsSection, {
    key: n,
    id: `s${n}`,
    name: `Section ${n}`,
    question: "What it answers.",
    visual: h("div", null, "viz"),
  });

describe("AnalyticsSection", () => {
  it("composes the heading as `Name. One sentence.` in one h2 with two weights", () => {
    const html = renderToStaticMarkup(
      h(AnalyticsSection, {
        id: "top",
        name: "Top subnets",
        question: "Who earns the emission.",
      }),
    );
    expect(html).toContain(
      '<section id="top" class="mg-section" aria-labelledby="top-heading"',
    );
    expect(html).toContain(
      '<h2 id="top-heading" class="mg-section-h"><strong>Top subnets.</strong> Who earns the emission.</h2>',
    );
  });

  it("does not double the full stop and renders visual, legend and footnote in order", () => {
    const html = renderToStaticMarkup(
      h(AnalyticsSection, {
        id: "a",
        name: "Emission.",
        question: "Per block.",
        visual: h("i", null, "V"),
        legend: h("b", null, "L"),
        footnote: "7d · chain",
        controls: h("u", null, "C"),
      }),
    );
    expect(html).toContain("<strong>Emission.</strong>");
    expect(html.indexOf("mg-section-controls")).toBeLessThan(
      html.indexOf("mg-section-visual"),
    );
    expect(html.indexOf("<i>V</i>")).toBeLessThan(html.indexOf("<b>L</b>"));
    expect(html.indexOf("<b>L</b>")).toBeLessThan(html.indexOf("7d · chain"));
    expect(html).toContain('<p class="mg-section-note">7d · chain</p>');
  });
});

describe("AnalyticsPage", () => {
  it("lists its AnalyticsSection children for the section nav", () => {
    expect(
      sectionItems([section(1), section(2), h("div", { key: "x" })]),
    ).toEqual([
      { id: "s1", name: "Section 1" },
      { id: "s2", name: "Section 2" },
    ]);
  });

  it(`renders ${MAX_SECTIONS} sections and refuses ${MAX_SECTIONS + 1}`, () => {
    const seven = Array.from({ length: MAX_SECTIONS }, (_, i) =>
      section(i + 1),
    );
    const html = renderToStaticMarkup(h(AnalyticsPage, null, seven));
    expect(html.match(/class="mg-section"/g)).toHaveLength(MAX_SECTIONS);
    expect(html).toContain('aria-label="Sections"');
    const eight = [...seven, section(MAX_SECTIONS + 1)];
    expect(() => renderToStaticMarkup(h(AnalyticsPage, null, eight))).toThrow(
      /at most 7/,
    );
  });
});

describe("SectionNav", () => {
  it("picks the first on-screen section in document order and keeps the current one otherwise", () => {
    const ids = ["a", "b", "c"];
    expect(pickActiveSection(ids, new Set(["b", "c"]), null)).toBe("b");
    expect(pickActiveSection(ids, new Set(["c"]), "a")).toBe("c");
    expect(pickActiveSection(ids, new Set(), "b")).toBe("b");
  });

  it("marks the active link with aria-current=location", () => {
    const html = renderToStaticMarkup(
      h(SectionNav, {
        items: [
          { id: "a", name: "Alpha" },
          { id: "b", name: "Beta" },
        ],
      }),
    );
    expect(html).toContain('href="#a" aria-current="location"');
    expect(html).toContain('href="#b">Beta');
    expect(html).toContain('class="mg-section-nav-scroll"');
  });

  it("keeps the scroll cue state accurate at both edges", () => {
    expect(
      sectionNavScrollState({
        scrollWidth: 300,
        clientWidth: 300,
        scrollLeft: 0,
      }),
    ).toEqual({ hasOverflow: false, atStart: true, atEnd: true });
    expect(
      sectionNavScrollState({
        scrollWidth: 400,
        clientWidth: 300,
        scrollLeft: 0,
      }),
    ).toEqual({ hasOverflow: true, atStart: true, atEnd: false });
    expect(
      sectionNavScrollState({
        scrollWidth: 400,
        clientWidth: 300,
        scrollLeft: 50,
      }),
    ).toEqual({ hasOverflow: true, atStart: false, atEnd: false });
    expect(
      sectionNavScrollState({
        scrollWidth: 400,
        clientWidth: 300,
        scrollLeft: 100,
      }),
    ).toEqual({ hasOverflow: true, atStart: false, atEnd: true });
  });
});

describe("FactStrip", () => {
  it("is a <dl> of cells with the count and variant as data attributes", () => {
    const cells: FactCells = [
      {
        label: "Emission",
        value: "4.3%",
        delta: { text: "+0.2", tone: "good" },
      },
      { label: "UIDs", value: "247/256" },
    ];
    const html = renderToStaticMarkup(h(FactStrip, { cells }));
    expect(html).toMatch(
      /^<dl class="mg-facts" data-variant="row" data-count="2">/,
    );
    expect(html).toContain("<dt>Emission</dt>");
    expect(html).toContain(
      '<span class="mg-fact-value">4.3%</span><span class="mg-fact-delta" data-tone="good">+0.2</span>',
    );
    expect(
      renderToStaticMarkup(h(FactStrip, { cells, variant: "grid" })),
    ).toContain('data-variant="grid"');
  });

  it("distinguishes a pending value from zero or unavailable data", () => {
    const cells: FactCells = [
      { label: "Head block", value: "—", loading: true },
      { label: "Finalized", value: "0" },
    ];
    const html = renderToStaticMarkup(h(FactStrip, { cells }));
    expect(html).toContain('<dd aria-busy="true">');
    expect(html).toContain(
      '<span class="mg-fact-loading" aria-hidden="true"></span>',
    );
    expect(html).toContain('<span class="sr-only">Loading Head block</span>');
    expect(html).not.toContain('<span class="mg-fact-value">—</span>');
    expect(html).toContain('<span class="mg-fact-value">0</span>');
  });

  it("counts composed fact cells as well as the shorthand array", () => {
    const html = renderToStaticMarkup(
      h(
        FactStrip,
        null,
        h(FactCell, { label: "One", value: "1" }),
        h(FactCell, { label: "Two", value: "2" }),
        h(FactCell, { label: "Three", value: "3" }),
      ),
    );
    expect(html).toContain('data-count="3"');
  });

  it("renders a text reading with the compact text treatment", () => {
    const cells: FactCells = [
      { label: "Metagraphed itself", value: "operational", kind: "text" },
      { label: "Open incidents", value: "0" },
    ];
    expect(renderToStaticMarkup(h(FactStrip, { cells }))).toContain(
      '<span class="mg-fact-value mg-fact-value--text">operational</span>',
    );
  });
});

describe("FactSentence", () => {
  it("renders facts as inline chips inside one paragraph", () => {
    const html = renderToStaticMarkup(
      h(FactSentence, null, "Ranked ", h(Fact, null, "#04"), " by emission"),
    );
    expect(html).toBe(
      '<p class="mg-fact-sentence">Ranked <span class="mg-fact-chip">#04</span> by emission</p>',
    );
  });
});

describe("LiveMeta", () => {
  it("is one line: Updated <time> · source · refresh", () => {
    const html = renderToStaticMarkup(
      h(LiveMeta, {
        updatedAt: new Date(Date.now() - 9000).toISOString(),
        source: "chain",
        onRefresh: () => {},
      }),
    );
    expect(html).toMatch(
      /^<p class="mg-live-meta" data-mg-live-meta="">Updated /,
    );
    expect(html).toContain(" · chain");
    expect(html).toContain(
      '<button type="button" class="mg-live-meta-refresh">refresh</button>',
    );
  });
});

describe("RangeControl", () => {
  it("is a radiogroup with one checked option and one Tab stop", () => {
    const html = renderToStaticMarkup(
      h(RangeControl, {
        label: "Window",
        options: [
          { value: "7d", label: "7d" },
          { value: "30d", label: "30d" },
        ],
        value: "30d",
        onChange: () => {},
      }),
    );
    expect(html).toContain('role="radiogroup" aria-label="Window"');
    expect(html).toContain('role="radio" aria-checked="false" tabindex="-1"');
    expect(html).toContain('role="radio" aria-checked="true" tabindex="0"');
  });
});

describe("EntityHero", () => {
  it("renders crumbs, the h1, one action, the sentence, the strip and the liveness line", () => {
    const html = renderToStaticMarkup(
      h(EntityHero, {
        crumbs: [{ label: "Subnets", href: "/subnets" }, { label: "SN19" }],
        name: "Nineteen",
        action: h("a", { className: "mg-hero-action", href: "/x" }, "Delegate"),
        sentence: h(FactSentence, null, "Ranked ", h(Fact, null, "#04")),
        cells: [
          { label: "Emission", value: "4.3%" },
          { label: "UIDs", value: "247" },
        ],
        live: { updatedAt: new Date().toISOString() },
      }),
    );
    expect(html).toMatch(/^<header class="mg-hero" data-mg-hero="">/);
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain("<h1>Nineteen</h1>");
    expect(html.indexOf("mg-hero-action")).toBeLessThan(
      html.indexOf("mg-fact-sentence"),
    );
    expect(html.indexOf("mg-fact-sentence")).toBeLessThan(
      html.indexOf("mg-facts"),
    );
    expect(html.indexOf("mg-facts")).toBeLessThan(html.indexOf("mg-live-meta"));
  });
});
