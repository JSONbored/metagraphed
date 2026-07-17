import { describe, expect, it } from "vitest";
import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KeyChip } from "@/components/metagraphed/key-chip";
import { SparkLegend } from "@/components/metagraphed/charts/spark-legend";
import {
  DotRow,
  NoDataSpark,
  StatWithSpark,
} from "@/components/metagraphed/charts/stat-with-spark";

// Radix's Tooltip root calls useTooltipProviderContext with no `optional`
// flag, so @radix-ui/react-context throws
// "`Tooltip` must be used within `TooltipProvider`" the moment one renders
// with no Provider ancestor. These components used to rely on
// apps/ui's AppShell supplying a single global <TooltipProvider>, which made
// them unusable anywhere else (a standalone embed, a design-sync preview, a
// test harness). Each now self-wraps, matching InfoTooltip/EligibilityChip.
//
// Rendering on the server is enough to prove it: the throw happens during
// render, before any effect or browser API is needed -- which is why this fits
// the package's node-environment suite with no jsdom.
const render = (element: ReactElement) => () => renderToStaticMarkup(element);

describe("ui-kit tooltip components render without an ancestor TooltipProvider", () => {
  const cases: Array<[string, ReactElement]> = [
    [
      "KeyChip",
      React.createElement(KeyChip, {
        value: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
        label: "hotkey",
      }),
    ],
    [
      "SparkLegend",
      React.createElement(SparkLegend, {
        metric: "Health trend",
        source: "live-cron-prober",
        children: "child",
      }),
    ],
    [
      "StatWithSpark",
      React.createElement(StatWithSpark, { label: "Uptime", value: "99.9%" }),
    ],
    [
      "DotRow",
      React.createElement(DotRow, {
        dots: [
          { label: "registry", on: true },
          { label: "probe", on: false },
        ],
      }),
    ],
    ["NoDataSpark", React.createElement(NoDataSpark, {})],
  ];

  for (const [name, element] of cases) {
    it(`${name} does not throw with no provider ancestor`, () => {
      expect(render(element)).not.toThrow();
    });
  }

  // The regression these guard against: without a provider, Radix throws this
  // exact message. If a future edit drops a component's own TooltipProvider,
  // the assertion above fails with it.
  it("a bare Radix Tooltip still throws without a provider (the guarded failure)", async () => {
    const { Tooltip, TooltipContent, TooltipTrigger } =
      await import("@/components/ui/tooltip");
    expect(
      render(
        React.createElement(
          Tooltip,
          null,
          React.createElement(TooltipTrigger, null, "trigger"),
          React.createElement(TooltipContent, null, "content"),
        ),
      ),
    ).toThrow(/must be used within `TooltipProvider`/);
  });

  // Nested Radix providers are safe, so self-wrapping cannot regress the
  // components' existing use inside AppShell's global provider.
  it("still renders when nested inside an outer provider, as AppShell does", async () => {
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    for (const [, element] of cases) {
      expect(
        render(React.createElement(TooltipProvider, null, element)),
      ).not.toThrow();
    }
  });
});
