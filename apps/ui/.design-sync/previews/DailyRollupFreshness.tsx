import { DailyRollupFreshness } from "@jsonbored/ui-kit";

// Matches FreshnessIndicator.tsx's own timestamps deliberately — this
// component composes that one (dot-only) plus an InfoTooltip, so using the
// same fresh/stale pair makes the two preview cards directly comparable.
// isStaleFreshness's real threshold is 12h (@/lib/metagraphed/format.ts).
const fresh = new Date(Date.now() - 2 * 60 * 1000).toISOString();
const stale = new Date(Date.now() - 14 * 60 * 60 * 1000).toISOString();

export function Fresh() {
  return <DailyRollupFreshness at={fresh} />;
}

export function Stale() {
  return <DailyRollupFreshness at={stale} />;
}

// `at` is optional and nullable, and tierFreshnessLabel has a dedicated
// "No freshness data" branch for it — a real state (a section whose rollup
// hasn't run yet), not a degenerate one, so it earns a card.
export function NoData() {
  return <DailyRollupFreshness at={null} />;
}
