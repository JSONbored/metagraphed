// Website-sized account holder directory derived from the same complete
// neuron snapshot as `/api/v1/accounts`.
//
// The public leaderboard intentionally accepts independent sort/limit
// variants. The website needs three fixed rankings at once, so asking that
// route three times repeats the same network-wide aggregation on legitimate
// cache misses. This projection folds the snapshot once and derives the three
// bounded views from that canonical result.

import {
  buildAccountsSnapshot,
  type AccountsListEntry,
} from "./accounts-list.ts";
import { raoBigToTao, toRaoBig } from "./lib/rao.ts";

export const ACCOUNT_HOLDER_DIRECTORY_LIMIT = 20;
export const ACCOUNT_HOLDER_RANKINGS = ["stake", "emission", "reach"] as const;
export type AccountHolderRanking = (typeof ACCOUNT_HOLDER_RANKINGS)[number];

export interface AccountHolderDirectoryEntry {
  hotkey: string;
  coldkey: string | null;
  subnet_count: number;
  uid_count: number;
  total_stake_tao: number;
  total_emission_tao: number;
  stake_dominance: number | null;
}

export interface AccountHolderDirectory {
  schema_version: 1;
  captured_at: string | null;
  block_number: number | null;
  account_count: number;
  limit: number;
  /** Total TAO-valued stake represented by rows with a usable subnet price. */
  priced_registered_stake_tao: number;
  rankings: Record<AccountHolderRanking, AccountHolderDirectoryEntry[]>;
}

function rankingValue(
  account: AccountsListEntry,
  metric: AccountHolderRanking,
): number {
  if (metric === "stake") return account.total_stake_tao;
  if (metric === "emission") return account.total_emission_tao;
  return account.subnet_count;
}

function compact(account: AccountsListEntry): AccountHolderDirectoryEntry {
  return {
    hotkey: account.hotkey,
    coldkey: account.coldkey,
    subnet_count: account.subnet_count,
    uid_count: account.uid_count,
    total_stake_tao: account.total_stake_tao,
    total_emission_tao: account.total_emission_tao,
    stake_dominance: account.stake_dominance ?? null,
  };
}

function ranking(
  accounts: readonly AccountsListEntry[],
  metric: AccountHolderRanking,
): AccountHolderDirectoryEntry[] {
  return [...accounts]
    .sort(
      (a, b) =>
        rankingValue(b, metric) - rankingValue(a, metric) ||
        a.hotkey.localeCompare(b.hotkey),
    )
    .slice(0, ACCOUNT_HOLDER_DIRECTORY_LIMIT)
    .map(compact);
}

export function buildAccountHolderDirectory(
  rows: Array<Record<string, unknown>> | null | undefined,
  { priceByNetuid }: { priceByNetuid: Map<number, number | null> },
): AccountHolderDirectory {
  const snapshot = buildAccountsSnapshot(rows, { priceByNetuid });
  const pricedStakeRao = snapshot.accounts.reduce(
    (sum, account) => sum + toRaoBig(account.total_stake_tao),
    0n,
  );

  return {
    schema_version: 1,
    captured_at: snapshot.captured_at,
    block_number: snapshot.block_number,
    account_count: snapshot.accounts.length,
    limit: ACCOUNT_HOLDER_DIRECTORY_LIMIT,
    priced_registered_stake_tao: raoBigToTao(pricedStakeRao),
    rankings: {
      stake: ranking(snapshot.accounts, "stake"),
      emission: ranking(snapshot.accounts, "emission"),
      reach: ranking(snapshot.accounts, "reach"),
    },
  };
}
