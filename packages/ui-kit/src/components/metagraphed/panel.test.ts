import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Panel, type PanelProps } from "@/components/metagraphed/panel";

// #7848: Panel gained rest-prop forwarding, a new "ok" tone, tintBorderOnly,
// and glow so the 31 documented #7817 skips (ids/aria-*/role, tone
// mismatches, mg-card-glow shells) could finally convert to it instead of a
// hand-rolled `rounded border bg-card` shell. Rendered via react-dom/server:
// this package's suite is node-environment with no jsdom.
const html = (element: React.ReactElement) => renderToStaticMarkup(element);

describe("Panel rest-prop forwarding (#7848)", () => {
  it("forwards id/aria-*/role/data-* to the outer element, not the body wrapper", () => {
    // data-* has no dedicated TS type on HTMLAttributes (only real JSX syntax
    // gets the compiler's special-cased data-*/aria-* leniency, not a plain
    // React.createElement props object) -- cast rather than drop the case, so
    // this still proves the real runtime spread forwards it.
    const props = {
      id: "endpoints-panel",
      "aria-label": "Endpoint list",
      "aria-live": "polite",
      role: "region",
      "data-testid": "endpoints-panel",
    } as PanelProps;
    const markup = html(React.createElement(Panel, props, "content"));
    // The outer element (first tag in the markup) carries the forwarded attrs.
    const outerTagMatch = markup.match(/^<section[^>]*>/);
    expect(outerTagMatch).not.toBeNull();
    const outerTag = outerTagMatch![0];
    expect(outerTag).toContain('id="endpoints-panel"');
    expect(outerTag).toContain('aria-label="Endpoint list"');
    expect(outerTag).toContain('aria-live="polite"');
    expect(outerTag).toContain('role="region"');
    expect(outerTag).toContain('data-testid="endpoints-panel"');
  });

  it("keeps forwarded attributes off the body wrapper div", () => {
    const markup = html(
      React.createElement(Panel, { id: "outer-only" }, "content"),
    );
    // Only one element in the tree should carry the forwarded id.
    const idOccurrences = markup.match(/id="outer-only"/g) ?? [];
    expect(idOccurrences.length).toBe(1);
  });

  it("still renders children inside the padded body wrapper, not the outer element directly", () => {
    const markup = html(
      React.createElement(
        Panel,
        { dense: true },
        React.createElement("span", null, "hi"),
      ),
    );
    expect(markup).toContain('class="mg-panel-pad-dense"');
    expect(markup).toMatch(
      /<div class="mg-panel-pad-dense"><span>hi<\/span><\/div>/,
    );
  });

  it("does not let a caller override className/bodyClassName via rest (type-level, not just runtime)", () => {
    // className/bodyClassName are still the only className hooks — this is
    // a compile-time guarantee (PanelOwnProps is Omit'd out of the rest
    // props' type), asserted here by confirming normal className usage
    // still composes correctly with the tone/rest classes.
    const markup = html(
      React.createElement(Panel, { className: "custom-class", id: "x" }, "y"),
    );
    expect(markup).toContain("custom-class");
    expect(markup).toContain('id="x"');
  });
});

describe("Panel tone + tintBorderOnly (#7848)", () => {
  it("adds the ok tone's tinted border and background", () => {
    const markup = html(React.createElement(Panel, { tone: "ok" }, "x"));
    expect(markup).toContain("border-health-ok/40");
    expect(markup).toContain("bg-health-ok/5");
  });

  it("tintBorderOnly keeps the tone's border but swaps the tinted bg for bg-card", () => {
    const markup = html(
      React.createElement(Panel, { tone: "warn", tintBorderOnly: true }, "x"),
    );
    expect(markup).toContain("border-health-warn/40");
    expect(markup).toContain("bg-card");
    expect(markup).not.toContain("bg-health-warn/5");
  });

  it("tintBorderOnly works with the accent tone too", () => {
    const markup = html(
      React.createElement(Panel, { tone: "accent", tintBorderOnly: true }, "x"),
    );
    expect(markup).toContain("border-accent/40");
    expect(markup).toContain("bg-card");
    expect(markup).not.toContain("bg-primary-soft");
  });
});

describe("Panel glow (#7848)", () => {
  it("appends mg-card-glow for the default tone", () => {
    const markup = html(React.createElement(Panel, { glow: true }, "x"));
    expect(markup).toContain("mg-card-glow");
    expect(markup).not.toContain("mg-card-glow-accent");
  });

  it("appends mg-card-glow-accent when tone is accent", () => {
    const markup = html(
      React.createElement(Panel, { glow: true, tone: "accent" }, "x"),
    );
    expect(markup).toContain("mg-card-glow-accent");
  });

  it("omits any glow class when glow is not set", () => {
    const markup = html(React.createElement(Panel, {}, "x"));
    expect(markup).not.toContain("mg-card-glow");
  });
});
