import { lineSpecimen, stackedSpecimen } from "@jsonbored/ui-kit";
import { formatDecimal } from "@/lib/metagraphed/format";

/**
 * The fixed sample every specimen on /design/primitives renders from.
 *
 * Never `Date.now()`, and never a random series: the page must render
 * identically under SSR and hydration (docs/ssr-safety.md), and three
 * Playwright projects drive these specimens as the primitives' only
 * integration test — a series that changed between runs would make those
 * assertions flake rather than fail.
 */
export const SAMPLE_UPDATED_AT = "2026-07-24T18:44:00.000Z";

export const LINE_SPECIMEN = lineSpecimen(120);
export const STACKED_SPECIMEN = stackedSpecimen();

export const formatTokens = (value: number) => `${value}T`;
export const formatMillions = (value: number) => `${formatDecimal(value / 1_000_000, 2)}M τ`;
export const formatThousands = (value: number) => `${formatDecimal(value / 1000, 0)}k τ`;
