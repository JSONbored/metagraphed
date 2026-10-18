import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnalyticsSection, DataTable, type DataTableColumn } from "@jsonbored/ui-kit";
import { accountPositionsQuery } from "@/lib/metagraphed/queries";
import { RouterLink } from "@/components/metagraphed/router-link";
import { ErrorState } from "@/components/metagraphed/states";
import { formatNumber } from "@/lib/metagraphed/format";
import type { AccountPosition } from "@/lib/metagraphed/types";
import { useRelativeTime } from "@/hooks/use-time-format";
import { positionsBySubnet, type PositionRow } from "./account-detail-logic";

/**
 * Section 1 — recorded position relationships.
 *
 * The response does not establish token quantities or ownership shares.
 * Read only identities, including when old dehydrated numeric fields exist.
 */
export function PositionsSection({
  ss58,
  nameOf,
}: {
  ss58: string;
  nameOf: (netuid: number) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const formatRelative = useRelativeTime();
  const query = useQuery({ ...accountPositionsQuery(ss58), retry: 0 });
  const { data, isPending, isError } = query;
  const positions = data?.data.positions ?? [];
  const rows = positionsBySubnet(positions, nameOf);
  const unavailable = isError && !data;
  const incomplete = Boolean(data?.data.degraded);

  const subnetColumns: DataTableColumn<PositionRow>[] = [
    {
      key: "netuid",
      label: "Subnet",
      kind: "link",
      value: (row) => row.label,
      href: (row) => `/subnets/${row.netuid}`,
    },
    {
      key: "hotkeys",
      label: "Hotkeys",
      kind: "number",
      value: (row) => row.hotkeys,
      format: (value) => (typeof value === "number" ? formatNumber(value) : "—"),
    },
  ];

  const columns: DataTableColumn<AccountPosition>[] = [
    {
      key: "netuid",
      label: "Subnet",
      kind: "link",
      value: (row) => nameOf(row.netuid),
      href: (row) => `/subnets/${row.netuid}`,
    },
    { key: "hotkey", label: "Hotkey", kind: "identifier", value: (row) => row.hotkey ?? "—" },
  ];

  return (
    <AnalyticsSection
      id="positions"
      name="Positions"
      question="Recorded position relationships by subnet."
      visual={
        unavailable ? (
          <ErrorState
            error={query.error}
            onRetry={() => void query.refetch()}
            context="position snapshots"
          />
        ) : incomplete && rows.length === 0 ? (
          <p role="status">Position relationship coverage is unavailable.</p>
        ) : (
          <DataTable
            rows={rows}
            columns={subnetColumns}
            rowKey={(row) => row.key}
            caption="Recorded ties by subnet"
            link={RouterLink}
            source="account-subnet"
            loading={isPending}
            empty="No position relationships recorded in this response."
            mobile="cards"
            pageSize={10}
          />
        )
      }
      footnote={
        isPending ? (
          "Loading position snapshots"
        ) : unavailable ? (
          "Position snapshots unavailable"
        ) : (
          <>
            {incomplete ? "Incomplete position coverage · returned relationships only. " : null}
            Amounts and ownership shares are unavailable: this response does not identify an
            authoritative quantity basis. Root holdings are not covered. Recorded relationships do
            not establish wallet holdings.
            {data?.data.captured_at
              ? ` Snapshot ${formatRelative(data.data.captured_at)}.`
              : " Snapshot time unavailable."}
            {positions.length > 0 && !expanded ? (
              <button type="button" className="mg-section-more" onClick={() => setExpanded(true)}>
                Show recorded relationships ({formatNumber(positions.length)})
              </button>
            ) : null}
          </>
        )
      }
    >
      {expanded ? (
        <DataTable
          rows={positions}
          columns={columns}
          rowKey={(row) => `${row.hotkey}-${row.netuid}`}
          caption="Recorded position relationships"
          link={RouterLink}
          source="account-position"
          pageSize={25}
          storageKey="account-positions-columns"
          mobile="cards"
        />
      ) : null}
    </AnalyticsSection>
  );
}
