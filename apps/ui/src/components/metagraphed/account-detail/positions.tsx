import { useQuery } from "@tanstack/react-query";
import { AnalyticsSection, DataTable, type DataTableColumn } from "@jsonbored/ui-kit";
import { accountPositionsQuery } from "@/lib/metagraphed/queries";
import { RouterLink } from "@/components/metagraphed/router-link";
import { ErrorState } from "@/components/metagraphed/states";
import { formatPct } from "@/lib/metagraphed/format";
import { rawAlphaToAlpha, asRawAlpha } from "@/lib/metagraphed/units";
import type { AccountPosition } from "@/lib/metagraphed/types";

/** Each subnet names a different token: no cross-token rail, sum or share. */
export function PositionsSection({
  ss58,
  nameOf,
}: {
  ss58: string;
  nameOf: (netuid: number) => string;
}) {
  const query = useQuery({ ...accountPositionsQuery(ss58), retry: 0 });
  const positions = query.data?.data.positions ?? [];
  const columns: DataTableColumn<AccountPosition>[] = [
    {
      key: "netuid",
      label: "Subnet token",
      kind: "link",
      value: (row) => nameOf(row.netuid),
      href: (row) => `/subnets/${row.netuid}`,
    },
    { key: "hotkey", label: "Hotkey", kind: "identifier", value: (row) => row.hotkey },
    {
      key: "alpha_rao",
      label: "Snapshot Alpha",
      value: (row) =>
        row.alpha_rao == null
          ? "Unavailable"
          : `${rawAlphaToAlpha(asRawAlpha(BigInt(row.alpha_rao)))} α`,
    },
    {
      key: "share_fraction",
      label: "Observed pool ratio",
      value: (row) =>
        row.share_fraction == null ? "Unavailable" : formatPct(row.share_fraction, 4),
    },
    {
      key: "capture",
      label: "Amount observed",
      value: (row) => row.provenance?.captured_at ?? "Unqualified",
    },
  ];
  const degraded = query.data?.data.degraded != null;
  return (
    <AnalyticsSection
      id="positions"
      name="Positions"
      question="Observed delegation relationships and qualified snapshot amounts."
      footnote="Amounts describe their captured block. Unknown amounts preserve relationships; Root coverage and live wallet completeness are unavailable. Different subnet tokens are not summed."
    >
      <DataTable
        rows={positions}
        columns={columns}
        rowKey={(row) => `${row.hotkey}-${row.netuid}`}
        caption="Observed positions"
        link={RouterLink}
        source="account-position"
        pageSize={25}
        storageKey="account-positions-columns-v2"
        loading={query.isPending}
        error={
          query.isError && !query.data ? (
            <ErrorState
              error={query.error}
              onRetry={() => void query.refetch()}
              context="position relationships"
            />
          ) : undefined
        }
        empty={
          degraded
            ? "Position coverage is unavailable."
            : "No relationships recorded in this source."
        }
        mobile="cards"
      />
    </AnalyticsSection>
  );
}
