import { useQuery } from "@tanstack/react-query";
import { validatorEconomicsQuery } from "@/lib/metagraphed/queries";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import type { ExcludedSubnet } from "@/lib/metagraphed/types";

const SHOWN = 15;

/**
 * `/api/v1/validators/economics` (#10300), published and rendered nowhere.
 *
 * The cross-subnet answer to "where is it cheapest to start validating". The
 * per-subnet panel already exists; this is the ranking, and it carries one
 * thing a ranking must never drop:
 *
 * `excluded` IS RENDERED, NOT FILTERED. The route returns the subnets it could
 * NOT rank, each with a reason, and a leaderboard that silently omits them
 * reports a subset as the whole. The reasons matter on their own terms too:
 * "no validators" and "the read failed" are different facts, and only one of
 * them is about the subnet.
 */
export function ValidatorEconomicsRanking() {
  const { data, isLoading, isError, error, refetch } = useQuery(validatorEconomicsQuery(SHOWN));

  if (isLoading) return <Skeleton className="h-[240px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const e = data?.data;
  if (!e || e.rows.length === 0) {
    return (
      <EmptyState
        title="No validator economics"
        description="No subnet reported the stake thresholds a validator permit and earning require."
      />
    );
  }

  const grouped = groupExclusions(e.excluded);

  return (
    <Panel as="section">
      <p className="mb-3 text-10 text-ink-muted">
        What it costs to start validating — cheapest {formatNumber(Math.min(SHOWN, e.rows.length))}{" "}
        of {formatNumber(e.total)} ranked subnets
        {e.tao_weight != null ? ` · tao weight ${formatNumber(e.tao_weight)}` : ""}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-10">
          <thead>
            <tr className="text-11 text-ink-muted">
              <th className="py-1 text-left">subnet</th>
              <th className="py-1 text-right">permit floor</th>
              <th className="py-1 text-right">earning floor</th>
              <th className="py-1 text-right">×</th>
              <th className="py-1 text-right">slots</th>
            </tr>
          </thead>
          <tbody>
            {e.rows.slice(0, SHOWN).map((r) => (
              <tr key={r.netuid} className="border-t border-border/50">
                <td className="py-1 text-ink">
                  SN{r.netuid}
                  {/* A degraded row is still a row, but it is labelled -- a
                      figure derived under a stated degradation is not the same
                      claim as one that was not. */}
                  {r.degraded_reason ? (
                    <span className="ml-1 text-11 text-ink-muted">degraded</span>
                  ) : null}
                  {r.emission_gate_open === false ? (
                    <span className="ml-1 text-11 text-ink-muted">gate shut</span>
                  ) : null}
                </td>
                <td className="py-1 text-right tabular-nums text-ink">
                  {formatTao(r.permit_floor_cost_tao)}
                </td>
                <td className="py-1 text-right tabular-nums text-ink">
                  {formatTao(r.earning_floor_cost_tao)}
                </td>
                <td className="py-1 text-right tabular-nums text-ink">
                  {r.permit_to_earning_multiple == null
                    ? "—"
                    : `${formatNumber(r.permit_to_earning_multiple)}×`}
                </td>
                <td className="py-1 text-right tabular-nums text-ink">
                  {formatNumber(r.validator_slots_open)}
                  {r.cap_binding ? <span className="ml-1 text-ink-muted">cap</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The subnets that could not be ranked, grouped by why. Named, because a
          ranking that hides its exclusions describes a subset as the whole. */}
      {grouped.length > 0 ? (
        <div className="mt-4">
          <p className="text-11 text-ink-muted">
            Not ranked ({e.excluded.length} subnet{e.excluded.length === 1 ? "" : "s"}):
          </p>
          <ul className="mt-1 space-y-0.5">
            {grouped.map(([reason, netuids]) => (
              <li key={reason} className="text-11 text-ink-muted">
                {reason} — {netuids.map((n) => `SN${n}`).join(", ")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}

/**
 * Exclusions grouped by reason, largest group first.
 *
 * Grouped rather than listed one per line because the reason is the
 * information: thirty subnets excluded for one cause is a different story from
 * thirty excluded for thirty causes, and a flat list tells neither. A missing
 * reason becomes an explicit "unstated" bucket rather than being dropped --
 * silently discarding the ones that did not say why would understate the count
 * the heading just published.
 */
export function groupExclusions(excluded: readonly ExcludedSubnet[]): Array<[string, number[]]> {
  const by = new Map<string, number[]>();
  for (const e of excluded) {
    const reason = e.reason ?? "reason unstated";
    const list = by.get(reason);
    if (list) list.push(e.netuid);
    else by.set(reason, [e.netuid]);
  }
  return [...by.entries()].sort((a, b) => b[1].length - a[1].length);
}
