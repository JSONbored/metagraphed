import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CopyButton } from "@/components/metagraphed/copy-button";
import { CopyableCode } from "@/components/metagraphed/copyable-code";

// #6370/#6371/#6372: every copy control should be keyboard-focus-visible and
// should announce the copy result to a screen reader. The share and CSV
// buttons this once also covered were retired with the list toolbars in
// #11610 -- copying a link and exporting a table now live in DataTable's own
// menu -- and KeyChip went with the legacy grammar in #11628, so the rule
// holds for the two copy controls that remain.
//
// Rendered via react-dom/server: this package's suite is node-environment with
// no jsdom, and class lists + the live region are both present in static markup.
const html = (element: React.ReactElement) => renderToStaticMarkup(element);

const VALUE = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

describe("copy/share controls are keyboard-focus-visible (#6370, #6371)", () => {
  const cases: Array<[string, React.ReactElement]> = [
    ["CopyButton", React.createElement(CopyButton, { value: VALUE })],
    [
      "CopyButton (compact)",
      React.createElement(CopyButton, { value: VALUE, compact: true }),
    ],
    ["CopyableCode", React.createElement(CopyableCode, { value: VALUE })],
  ];

  for (const [name, element] of cases) {
    it(`${name} renders a focus-visible utility`, () => {
      expect(html(element)).toMatch(/focus-visible:ring-2/);
    });
  }
});

describe("copy controls announce the result to screen readers (#6372)", () => {
  const cases: Array<[string, React.ReactElement]> = [
    ["CopyButton", React.createElement(CopyButton, { value: VALUE })],
    ["CopyableCode", React.createElement(CopyableCode, { value: VALUE })],
  ];

  for (const [name, element] of cases) {
    it(`${name} renders a polite sr-only status region`, () => {
      const markup = html(element);
      expect(markup).toMatch(
        /<span role="status" aria-live="polite" class="sr-only">/,
      );
    });
  }

  // The region must stay mounted while idle: assistive tech announces a
  // CONTENT CHANGE inside a live region, so a region that only appears on
  // success may never be announced at all. Idle renders it empty, not absent.
  it("keeps the region mounted and empty before any copy", () => {
    const markup = html(React.createElement(CopyButton, { value: VALUE }));
    expect(markup).toContain(
      '<span role="status" aria-live="polite" class="sr-only"></span>',
    );
  });

  // sr-only is absolutely positioned, so adding the region beside a button
  // inside a flex row cannot shift layout.
  it("uses sr-only so the region adds no layout", () => {
    for (const [, element] of cases) {
      expect(html(element)).toContain('class="sr-only"');
    }
  });
});
