import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CopyButton } from "@/components/metagraphed/copy-button";
import { CopyableCode } from "@/components/metagraphed/copyable-code";
import { KeyChip } from "@/components/metagraphed/key-chip";
import { ShareButton } from "@/components/metagraphed/share-button";
import { DownloadCsvButton } from "@/components/metagraphed/download-csv-button";

// #6370/#6371/#6372: every copy/share control should be keyboard-focus-visible
// and should announce the copy result to a screen reader. Before this, only
// ShareButton had the live region and only DownloadCsvButton/KeyChip had a
// focus ring -- so tabbing an ActionBar lit up the CSV button and skipped
// Share, and a screen reader confirmed a copy from Share but from nothing else.
//
// Rendered via react-dom/server: this package's suite is node-environment with
// no jsdom, and class lists + the live region are both present in static markup.
const html = (element: React.ReactElement) =>
  renderToStaticMarkup(React.createElement(TooltipProvider, null, element));

const VALUE = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

describe("copy/share controls are keyboard-focus-visible (#6370, #6371)", () => {
  const cases: Array<[string, React.ReactElement]> = [
    ["CopyButton", React.createElement(CopyButton, { value: VALUE })],
    [
      "CopyButton (compact)",
      React.createElement(CopyButton, { value: VALUE, compact: true }),
    ],
    ["CopyableCode", React.createElement(CopyableCode, { value: VALUE })],
    ["KeyChip", React.createElement(KeyChip, { value: VALUE })],
    ["ShareButton", React.createElement(ShareButton, { url: "/subnets" })],
    [
      "ShareButton (bare)",
      React.createElement(ShareButton, { url: "/subnets", bare: true }),
    ],
  ];

  for (const [name, element] of cases) {
    it(`${name} renders a focus-visible utility`, () => {
      expect(html(element)).toMatch(/focus-visible:ring-2/);
    });
  }

  // The regression #6370 describes concretely: this exact toolbar composition
  // ships in apps/ui/src/routes/subnets.index.tsx, and Share used to be the one
  // control that lit up nothing on Tab.
  it("ShareButton bare matches its ActionBar sibling DownloadCsvButton", () => {
    const share = html(
      React.createElement(ShareButton, { url: "/subnets", bare: true }),
    );
    const csv = html(
      React.createElement(DownloadCsvButton, {
        // Absolute: buildCsvDownloadUrl parses this with `new URL`.
        url: "https://api.metagraph.sh/api/v1/subnets",
        bare: true,
      }),
    );
    for (const utility of [
      "focus:outline-none",
      "focus-visible:ring-2",
      "focus-visible:ring-ring",
    ]) {
      expect(csv).toContain(utility);
      expect(share).toContain(utility);
    }
  });
});

describe("copy controls announce the result to screen readers (#6372)", () => {
  const cases: Array<[string, React.ReactElement]> = [
    ["CopyButton", React.createElement(CopyButton, { value: VALUE })],
    ["CopyableCode", React.createElement(CopyableCode, { value: VALUE })],
    ["KeyChip", React.createElement(KeyChip, { value: VALUE })],
    ["ShareButton", React.createElement(ShareButton, { url: "/subnets" })],
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
