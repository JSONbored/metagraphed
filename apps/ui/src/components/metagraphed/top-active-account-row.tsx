import { AddressDisplay } from "@/components/metagraphed/address-display";
import { formatNumber } from "@/lib/metagraphed/format";
import {
  TOP_ACTIVE_ACCOUNTS_LIST_CLASS,
  TOP_ACTIVE_ACCOUNT_LINK_CLASS,
  formatTopActiveShare,
  type TopActiveAccountRow,
} from "./top-active-accounts-ranking";

type TopActiveAccountRowLinkProps = {
  row: TopActiveAccountRow;
};

/**
 * Single ranked account row — account short-hash link + copy button + tx count +
 * cohort share. The ss58 address is paired with a `CopyButton` (matching the
 * shared `AddressDisplay` idiom) so the full address can be copied without a
 * hover-only tooltip, which is unusable on touch/mobile (#5856). Replaces the
 * duplicated BarMini + pill list pair on `/accounts` (#5315).
 */
export function TopActiveAccountRowLink({ row }: TopActiveAccountRowLinkProps) {
  return (
    <div className={TOP_ACTIVE_ACCOUNT_LINK_CLASS} data-testid="top-active-account-row">
      <AddressDisplay
        ss58={row.ss58}
        fallback={<>{row.ss58}</>}
        compact
        valueClassName="min-w-0 truncate rounded group-hover:text-accent"
        preload="intent"
      />
      <span className="shrink-0 tabular-nums text-ink-muted">
        {formatNumber(row.txCount)} tx
        <span className="ml-2 text-ink-muted/70">{formatTopActiveShare(row.shareOfTop)}</span>
      </span>
    </div>
  );
}

type TopActiveAccountsListProps = {
  rows: TopActiveAccountRow[];
};

export function TopActiveAccountsList({ rows }: TopActiveAccountsListProps) {
  return (
    <ul className={TOP_ACTIVE_ACCOUNTS_LIST_CLASS} data-testid="top-active-accounts-list">
      {rows.map((row) => (
        <li key={row.ss58}>
          <TopActiveAccountRowLink row={row} />
        </li>
      ))}
    </ul>
  );
}
