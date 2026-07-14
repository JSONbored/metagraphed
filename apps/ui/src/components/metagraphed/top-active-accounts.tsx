import { useSuspenseQuery } from "@tanstack/react-query";
import { chainSignersQuery } from "@/lib/metagraphed/queries";
import { TopActiveAccountsList } from "./top-active-account-row";
import {
  TOP_ACTIVE_ACCOUNTS_LIMIT,
  buildTopActiveAccountRows,
} from "./top-active-accounts-ranking";

/**
 * Top accounts ranked by extrinsics signed in the last 7 days (#5315).
 *
 * Shown once as a navigable list (account + tx count + share of the top-N
 * cohort). The previous BarMini + identical pill list pairing was removed so
 * the ranking is not duplicated across two visual forms.
 */
export function TopActiveAccounts() {
  const signers = useSuspenseQuery(chainSignersQuery()).data.data.signers;
  const rows = buildTopActiveAccountRows(signers, TOP_ACTIVE_ACCOUNTS_LIMIT);

  if (rows.length === 0) {
    return (
      <p className="font-mono text-[12px] text-ink-muted">
        No account activity in this window yet.
      </p>
    );
  }

  return <TopActiveAccountsList rows={rows} />;
}
