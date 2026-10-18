// Website-sized account holder directory derived from the same complete
// neuron snapshot as `/api/v1/accounts`.
//
// Fold the snapshot once for bounded emission and reach rankings. Metagraph
// voting weight does not establish holdings value; the legacy stake ranking
// stays empty rather than presenting a financially selected subset.

import {
  buildAccountsSnapshot,
  type AccountsListEntry,
} from "./accounts-list.ts";
import { recordOrNull } from "./read-store.ts";

export const ACCOUNT_HOLDER_DIRECTORY_LIMIT = 20;
export const ACCOUNT_HOLDER_RANKINGS = ["stake", "emission", "reach"] as const;
export type AccountHolderRanking = (typeof ACCOUNT_HOLDER_RANKINGS)[number];

export interface AccountHolderDirectoryEntry {
  hotkey: string;
  coldkey: string | null;
  subnet_count: number;
  uid_count: number;
  total_stake_tao: number | null;
  total_emission_tao: number;
  stake_dominance: number | null;
}

export interface AccountHolderDirectory {
  schema_version: 1;
  captured_at: string | null;
  block_number: number | null;
  account_count: number;
  limit: number;
  /** Unavailable: voting weight does not establish registered holdings value. */
  priced_registered_stake_tao: number | null;
  rankings: Record<AccountHolderRanking, AccountHolderDirectoryEntry[]>;
}

/** Cached financial rankings cannot be repaired after selecting their top rows. */
export function hasLegacyAccountHolderCapital(value: unknown): boolean {
  const directory = recordOrNull(value);
  const rankings = recordOrNull(directory?.rankings);
  if (
    !directory ||
    directory.priced_registered_stake_tao !== null ||
    !rankings ||
    !Array.isArray(rankings.stake) ||
    rankings.stake.length > 0
  ) {
    return true;
  }
  return ACCOUNT_HOLDER_RANKINGS.some((metric) => {
    const entries = rankings[metric];
    return (
      !Array.isArray(entries) ||
      entries.some((entry) => {
        const account = recordOrNull(entry);
        return (
          !account ||
          account.total_stake_tao !== null ||
          account.stake_dominance !== null
        );
      })
    );
  });
}

function rankingValue(
  account: AccountsListEntry,
  metric: Exclude<AccountHolderRanking, "stake">,
): number {
  if (metric === "emission") return account.total_emission_tao;
  return account.subnet_count;
}

function compact(account: AccountsListEntry): AccountHolderDirectoryEntry {
  return {
    hotkey: account.hotkey,
    coldkey: account.coldkey,
    subnet_count: account.subnet_count,
    uid_count: account.uid_count,
    total_stake_tao: null,
    total_emission_tao: account.total_emission_tao,
    stake_dominance: null,
  };
}

function ranking(
  accounts: readonly AccountsListEntry[],
  metric: Exclude<AccountHolderRanking, "stake">,
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
  return {
    schema_version: 1,
    captured_at: snapshot.captured_at,
    block_number: snapshot.block_number,
    account_count: snapshot.accounts.length,
    limit: ACCOUNT_HOLDER_DIRECTORY_LIMIT,
    priced_registered_stake_tao: null,
    rankings: {
      stake: [],
      emission: ranking(snapshot.accounts, "emission"),
      reach: ranking(snapshot.accounts, "reach"),
    },
  };
}
