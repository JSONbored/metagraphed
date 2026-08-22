import { RankedRailList, type RankedRailItem } from "@jsonbored/ui-kit";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import { formatNumber } from "@/lib/metagraphed/format";
import { formatTopActiveShare, type TopActiveAccountRow } from "./top-active-accounts-ranking";

type TopActiveAccountsListProps = {
  rows: TopActiveAccountRow[];
};

/**
 * The most active accounts, as a ranked comparison.
 *
 * This was eight bordered cards stacked vertically — one box per row for two
 * values. A share of the cohort is exactly what a rail encodes, so the rows
 * now carry a bar you can compare at a glance instead of a percentage you have
 * to read one at a time (#11523).
 */
export function TopActiveAccountsList({ rows }: TopActiveAccountsListProps) {
  const items: RankedRailItem[] = rows.map((row) => ({
    id: row.ss58,
    // AddressDisplay keeps the copy affordance and the link to the account.
    label: (
      <AddressDisplay
        ss58={row.ss58}
        fallback={<>{row.ss58}</>}
        compact
        valueClassName="min-w-0 truncate"
        preload="intent"
      />
    ),
    value: row.txCount,
    valueLabel: `${formatNumber(row.txCount)} tx`,
    meta: formatTopActiveShare(row.shareOfTop),
  }));

  return (
    <div data-testid="top-active-accounts-list">
      <RankedRailList
        ariaLabel="Accounts ranked by extrinsics signed on chain"
        items={items}
        emptyLabel="No signing activity in this window."
      />
    </div>
  );
}
