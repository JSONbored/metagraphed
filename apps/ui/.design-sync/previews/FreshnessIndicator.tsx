import { FreshnessIndicator } from "metagraphed-ui";

const fresh = new Date(Date.now() - 2 * 60 * 1000).toISOString();
// isStaleFreshness's real default threshold is 12h (see @/lib/metagraphed/format.ts) —
// the component's own JSDoc says "default 5 min", which is stale documentation.
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
