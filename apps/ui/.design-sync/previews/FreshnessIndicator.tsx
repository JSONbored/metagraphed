import { FreshnessIndicator } from "@jsonbored/ui-kit";

const fresh = new Date(Date.now() - 2 * 60 * 1000).toISOString();
// Either side of isStaleFreshness's 12h default threshold (packages/ui-kit/
// src/lib/format.ts) — data refreshes on a ~6h cycle, so a snapshot is only
// stale once it has clearly missed multiple cycles.
const stale = new Date(Date.now() - 14 * 60 * 60 * 1000).toISOString();

export function Fresh() {
  return <FreshnessIndicator at={fresh} />;
}

export function Stale() {
  return <FreshnessIndicator at={stale} />;
}

export function DotOnly() {
  return <FreshnessIndicator at={fresh} dotOnly />;
}
