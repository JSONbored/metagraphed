import { useQuery } from "@tanstack/react-query";
import { DataTable, type DataTableColumn } from "@jsonbored/ui-kit";
import { topHoldersQuery } from "@/lib/metagraphed/queries";
import { EmptyState, ErrorState } from "@/components/metagraphed/states";
import { formatNumber, formatTao, formatRelative } from "@/lib/metagraphed/format";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import { RouterLink } from "@/components/metagraphed/router-link";
import type { TopHolder } from "@/lib/metagraphed/types";

const SHOWN = 15;

const tao = (value: unknown) => formatTao(typeof value === "number" ? value : null);

const COLUMNS: Array<DataTableColumn<TopHolder>> = [
  {
    key: "account",
    label: "Account",
    value: (a) => a.ss58,
    render: (a) => <AddressDisplay ss58={a.ss58} fallback={a.ss58} compact />,
  },
  {
    key: "free",
    label: "Free",
    kind: "number",
    sortable: true,
    value: (a) => a.free_tao,
    format: tao,
  },
  {
    key: "delegated",
    label: "Delegated",
    kind: "number",
    sortable: true,
    value: (a) => a.delegated_tao,
    format: tao,
  },
  {
    key: "total",
    label: "Total",
    kind: "number",
    sortable: true,
    value: (a) => a.total_tao,
    format: tao,
  },
  {
    key: "flow_30d",
    label: "30d flow",
    kind: "number",
    sortable: true,
    value: (a) => a.net_flow_30d,
    format: tao,
    // The marker is the point of the column: one window is not a direction.
    render: (a) => (
      <>
        {formatTao(a.net_flow_30d)}
        {flowsDisagree(a) ? (
          <span className="ml-1 text-ink-muted" aria-label="flow windows disagree">
            *
          </span>
        ) : null}
      </>
    ),
  },
];

/**
 * `/api/v1/accounts/top-holders` (#10300), published and rendered nowhere.
 *
 * The network-wide holder leaderboard. Two things it refuses to collapse:
 *
 * FREE AND DELEGATED ARE DIFFERENT POSITIONS. Delegated TAO is committed to a
 * validator and earning; free TAO is not. An account holding 10k free and one
 * holding 10k delegated have the same total and are doing opposite things, so
 * the split is shown rather than the total alone.
 *
 * THE FLOW WINDOWS CAN DISAGREE. The route publishes 7d, 30d and 90d because a
 * holder can be growing over the week and shrinking over the quarter. Showing
 * one window lets a short bounce read as a trend, so the panel names which
 * window it is showing and flags the holders whose direction is not consistent
 * across them.
 */
export function TopHoldersPanel() {
  const { data, isLoading, isError, error, refetch } = useQuery(topHoldersQuery(SHOWN));

  const h = data?.data;
  const rows = (h?.accounts ?? []).slice(0, SHOWN);

  return (
    <div className="space-y-3">
      {h ? (
        <p className="text-10 text-ink-muted">
          Largest {formatNumber(Math.min(SHOWN, h.accounts.length))} TAO holders network-wide
          {h.account_count == null ? "" : ` of ${formatNumber(h.account_count)} ranked`}
          {h.captured_at ? ` · captured ${formatRelative(h.captured_at)}` : ""}
        </p>
      ) : null}

      <DataTable
        rows={rows}
        columns={COLUMNS}
        rowKey={(a) => a.ss58}
        caption="Top holders"
        link={RouterLink}
        storageKey="top-holders"
        loading={isLoading}
        error={
          isError ? (
            <ErrorState error={error} onRetry={() => void refetch()} context="top holders" />
          ) : undefined
        }
        empty={
          <EmptyState
            title="No holder ranking"
            description="The network-wide holder leaderboard has not been captured."
          />
        }
      />

      <p className="text-11 text-ink-muted">
        * the 7d, 30d and 90d flows do not all point the same way — a move in one window is not a
        trend in the others.
      </p>
    </div>
  );
}

/** All three windows, so one number is never mistaken for the direction. */
export function flowTooltip(a: TopHolder): string {
  const part = (label: string, v: number | null) => `${label}: ${v == null ? "—" : formatTao(v)}`;
  return [part("7d", a.net_flow_7d), part("30d", a.net_flow_30d), part("90d", a.net_flow_90d)].join(
    " · ",
  );
}

/**
 * Whether the flow windows point in different directions.
 *
 * Only compares the windows that HAVE a value -- a missing window is not a
 * disagreement, and treating it as one would put a caveat marker on every
 * account with a gap in its history. Zero is treated as its own direction
 * rather than folded into positive or negative: no movement genuinely differs
 * from movement, and calling it "up" would invent a direction.
 */
export function flowsDisagree(a: TopHolder): boolean {
  const signs = [a.net_flow_7d, a.net_flow_30d, a.net_flow_90d]
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .map((v) => Math.sign(v));
  return new Set(signs).size > 1;
}
