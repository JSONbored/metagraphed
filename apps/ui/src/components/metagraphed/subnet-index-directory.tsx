import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SUBNETS_ALL_LIMIT, subnetsQuery } from "@/lib/metagraphed/queries";
import { EntityIndexDirectory } from "./entity-index-directory";

/**
 * A complete, crawlable index of every subnet (#11204).
 *
 * See EntityIndexDirectory for why this exists and why it is not a duplicate of
 * the virtualized table above it.
 */
export function SubnetIndexDirectory() {
  // The same query the table issues, minus the reader's `q` filter — a
  // directory that shrinks when someone types a search is not an index. On the
  // first (and crawled) render there is no `q`, so this shares the table's
  // cache entry and costs no extra request.
  const { data } = useSuspenseQuery(subnetsQuery({ limit: SUBNETS_ALL_LIMIT }));
  const subnets = [...data.data].sort((a, b) => a.netuid - b.netuid);

  return (
    <EntityIndexDirectory label="subnets" count={subnets.length}>
      {subnets.map((subnet) => (
        <li key={subnet.netuid} className="break-inside-avoid py-0.5">
          <Link
            to="/subnets/$netuid"
            params={{ netuid: subnet.netuid }}
            className="mg-type-caption text-ink-muted hover:text-accent"
          >
            <span className="text-ink-strong">SN{subnet.netuid}</span>
            {subnet.name ? ` · ${subnet.name}` : ""}
          </Link>
        </li>
      ))}
    </EntityIndexDirectory>
  );
}
