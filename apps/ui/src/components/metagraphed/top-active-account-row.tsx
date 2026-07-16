import { Link } from "@tanstack/react-router";
import { CopyButton } from "@jsonbored/ui-kit";
import { shortHash } from "@/lib/metagraphed/blocks";
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
 * shared `AccountAddress` idiom) so the full address can be copied without a
 * hover-only tooltip, which is unusable on touch/mobile (#5856). Replaces the
 * duplicated BarMini + pill list pair on `/accounts` (#5315).
 */
export function TopActiveAccountRowLink({ row }: TopActiveAccountRowLinkProps) {
  const label = shortHash(row.ss58) ?? row.ss58;
  return (
    <div className={TOP_ACTIVE_ACCOUNT_LINK_CLASS} data-testid="top-active-account-row">
      <span className="inline-flex min-w-0 items-center gap-1">
        <Link
          to="/accounts/$ss58"
          params={{ ss58: row.ss58 }}
          title={row.ss58}
          className="min-w-0 truncate rounded-sm hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 group-hover:text-accent"
          preload="intent"
        >
          {label}
        </Link>
        <CopyButton value={row.ss58} label="account" compact />
      </span>
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
