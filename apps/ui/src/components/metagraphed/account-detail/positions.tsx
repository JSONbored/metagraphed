import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnalyticsSection, DataTable, RankedRails, type DataTableColumn } from "@jsonbored/ui-kit";
import { accountPositionsQuery } from "@/lib/metagraphed/queries";
import { RouterLink } from "@/components/metagraphed/router-link";
import { formatNumber } from "@/lib/metagraphed/format";
import type { AccountPosition } from "@/lib/metagraphed/types";
import { fmtCompactTao, fmtTao, positionsBySubnet } from "./account-detail-logic";

/**
 * Section 1 — where the stake sits.
 *
 * Rails by SUBNET, with the raw per-hotkey rows behind the disclosure: an
 * account commonly holds one subnet through several hotkeys, and railing the
 * raw rows shows the same subnet repeatedly and leaves the addition to the
 * reader.
 */
export function PositionsSection({
  ss58,
  nameOf,
}: {
  ss58: string;
  nameOf: (netuid: number) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const { data } = useQuery({ ...accountPositionsQuery(ss58), retry: 0 });
  const positions = data?.data.positions ?? [];
  const rows = positionsBySubnet(positions, nameOf);

  const columns: DataTableColumn<AccountPosition>[] = [
    {
      key: "netuid",
      label: "Subnet",
      kind: "link",
      value: (row) => nameOf(row.netuid),
      href: (row) => `/subnets/${row.netuid}`,
    },
    { key: "hotkey", label: "Hotkey", kind: "identifier", value: (row) => row.hotkey ?? "—" },
    {
      key: "stake_tao",
      label: "Stake",
      kind: "number",
      sortable: true,
      value: (row) => row.stake_tao ?? null,
      format: (value) => (typeof value === "number" ? fmtTao(value, 4) : "—"),
    },
    {
      key: "share",
      label: "Share of subnet",
      kind: "number",
      sortable: true,
      value: (row) => row.share_fraction ?? null,
      format: (value) => (typeof value === "number" ? `${(value * 100).toFixed(4)}%` : "—"),
    },
  ];

  return (
    <AnalyticsSection
      id="positions"
      name="Positions"
      question="Where the stake sits."
      visual={
        rows.length > 0 ? (
          <RankedRails
            items={rows.map((row) => ({
              key: `sn-${row.netuid}`,
              label: row.label,
              value: row.value,
              href: `/subnets/${row.netuid}`,
              detail: [
                {
                  key: "share",
                  label: "Share of holdings",
                  value: `${(row.share * 100).toFixed(1)}%`,
                },
                { key: "hotkeys", label: "Hotkeys", value: String(row.hotkeys) },
                { key: "stake", label: "Stake", value: fmtTao(row.value, 4) },
              ],
            }))}
            formatValue={(value) => fmtCompactTao(value)}
            scale="sqrt"
            columns={{ value: "Stake", name: "Subnet", track: "Share of holdings" }}
            ariaLabel="Stake by subnet"
            source="account-subnet"
          />
        ) : null
      }
      footnote={
        // The rail is by subnet; the table is the per-hotkey evidence behind
        // it and is worth reaching even when the two happen to have the same
        // row count (an account holding every subnet through one hotkey).
        positions.length > 0 && !expanded ? (
          <button type="button" className="mg-section-more" onClick={() => setExpanded(true)}>
            Show every position ({formatNumber(positions.length)})
          </button>
        ) : (
          `${formatNumber(positions.length)} positions across ${formatNumber(rows.length)} subnets · live chain`
        )
      }
    >
      {expanded ? (
        <DataTable
          rows={positions}
          columns={columns}
          rowKey={(row) => `${row.hotkey}-${row.netuid}`}
          caption="Every position"
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
