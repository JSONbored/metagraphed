import { useQuery } from "@tanstack/react-query";
import { DataTable, type DataTableColumn } from "@jsonbored/ui-kit";
import { validatorEconomicsQuery } from "@/lib/metagraphed/queries";
import { EmptyState, ErrorState } from "@/components/metagraphed/states";
import { RouterLink } from "@/components/metagraphed/router-link";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import type { ExcludedSubnet, ValidatorEconomicsRow } from "@/lib/metagraphed/types";

const SHOWN = 15;

const tao = (value: unknown) => formatTao(typeof value === "number" ? value : null);

const COLUMNS: Array<DataTableColumn<ValidatorEconomicsRow>> = [
  {
    key: "subnet",
    label: "Subnet",
    value: (r) => `SN${r.netuid}`,
    // A degraded row is still a row, but it is labelled -- a figure derived
    // under a stated degradation is not the same claim as one that was not.
    render: (r) => (
      <>
        SN{r.netuid}
        {r.degraded_reason ? <span className="ml-1 text-11 text-ink-muted">degraded</span> : null}
        {r.emission_gate_open === false ? (
          <span className="ml-1 text-11 text-ink-muted">gate shut</span>
        ) : null}
      </>
    ),
  },
  {
    key: "permit_floor",
    label: "Permit floor",
    kind: "number",
    sortable: true,
    value: (r) => r.permit_floor_cost_tao,
    format: tao,
  },
  {
    key: "earning_floor",
    label: "Earning floor",
    kind: "number",
    sortable: true,
    value: (r) => r.earning_floor_cost_tao,
    format: tao,
  },
  {
    key: "multiple",
    label: "×",
    kind: "number",
    sortable: true,
    value: (r) => r.permit_to_earning_multiple,
    format: (v) => (typeof v === "number" ? `${formatNumber(v)}×` : "—"),
  },
  {
    key: "slots",
    label: "Slots",
    kind: "number",
    sortable: true,
    value: (r) => r.validator_slots_open,
    format: (v) => formatNumber(typeof v === "number" ? v : null),
    render: (r) => (
      <>
        {formatNumber(r.validator_slots_open)}
        {r.cap_binding ? <span className="ml-1 text-ink-muted">cap</span> : null}
      </>
    ),
  },
];

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

  const e = data?.data;
  const rows = (e?.rows ?? []).slice(0, SHOWN);
  const grouped = groupExclusions(e?.excluded ?? []);

  return (
    <div className="space-y-3">
      {e ? (
        <p className="text-10 text-ink-muted">
          What it costs to start validating — cheapest{" "}
          {formatNumber(Math.min(SHOWN, e.rows.length))} of {formatNumber(e.total)} ranked subnets
          {e.tao_weight != null ? ` · tao weight ${formatNumber(e.tao_weight)}` : ""}
        </p>
      ) : null}

      <DataTable
        rows={rows}
        columns={COLUMNS}
        rowKey={(r) => String(r.netuid)}
        caption="Validator entry cost"
        link={RouterLink}
        storageKey="validator-economics"
        loading={isLoading}
        error={
          isError ? (
            <ErrorState
              error={error}
              onRetry={() => void refetch()}
              context="validator economics"
            />
          ) : undefined
        }
        empty={
          <EmptyState
            title="No validator economics"
            description="No subnet reported the stake thresholds a validator permit and earning require."
          />
        }
      />

      {/* The subnets that could not be ranked, grouped by why. Named, because a
          ranking that hides its exclusions describes a subset as the whole. */}
      {grouped.length > 0 && e ? (
        <div>
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
    </div>
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
