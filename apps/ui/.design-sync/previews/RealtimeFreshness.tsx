import { RealtimeFreshness } from "@jsonbored/ui-kit";

// Same timestamps as DailyRollupFreshness.tsx / FreshnessIndicator.tsx so the
// three cards line up side by side. The visual shape is identical to
// DailyRollupFreshness by design — what differs is the tooltip's tier prefix
// ("Live chain read" vs "Daily rollup snapshot"), which is exactly why both
// need their own card: a grader can't tell them apart from the dot alone.
const fresh = new Date(Date.now() - 2 * 60 * 1000).toISOString();
const stale = new Date(Date.now() - 14 * 60 * 60 * 1000).toISOString();

export function Fresh() {
  return <RealtimeFreshness at={fresh} />;
}

export function Stale() {
  return <RealtimeFreshness at={stale} />;
}

export function NoData() {
  return <RealtimeFreshness at={null} />;
}
