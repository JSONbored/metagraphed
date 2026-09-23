import type { AccountEventsRow } from "../generated/lakehouse/types.ts";
import { loadIndexedAccountFeedAggregate } from "./indexed-account-feeds.ts";
import {
  STAKE_ADDED_KIND,
  STAKE_REMOVED_KIND,
} from "./validator-nominators.ts";

interface Query {
  coldkey?: string | null;
  sort: string;
  limit: number;
  offset: number;
}
interface Group extends Record<string, unknown> {
  coldkey: string | null;
  staked_tao: number;
  unstaked_tao: number;
  net_staked_tao: number | null;
  gross_staked_tao: number | null;
  event_count: number;
  last_observed: number;
}

/** Read only this validator's two stake-event ranges. Both the ranked page and
 * its true total come from the same complete, source-fenced selection. */
export function loadIndexedValidatorNominators(
  env: unknown,
  hotkey: string,
  cutoff: number,
  query: Query,
): Promise<{ rows: Group[]; totalCount: number } | null | undefined> {
  return loadIndexedAccountFeedAggregate(
    env,
    [STAKE_ADDED_KIND, STAKE_REMOVED_KIND].map((kind) => ({
      side: "hotkey",
      account: hotkey,
      kind,
      observedStart: cutoff,
    })),
    (rows) => foldValidatorNominators(rows, query),
  );
}

/** SQL DESC puts null aggregate cells first; coldkey ASC puts null last.
 * Compare addresses by code point, independent of the host's locale. */
function descending(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return b - a;
}
function addressOrder(a: string | null, b: string | null): number {
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/** Keep bounded aggregate cells, never the full event window. Physical
 * duplicates count independently; the shared feed merge removes only overlap
 * between selectors. Nullable SUMs retain their SQL sorting semantics. */
export async function foldValidatorNominators(
  rows: AsyncIterable<AccountEventsRow>,
  query: Query,
): Promise<{ rows: Group[]; totalCount: number }> {
  const groups = new Map<string | null, Group>();
  for await (const row of rows) {
    if (query.coldkey != null && row.coldkey !== query.coldkey) continue;
    let group = groups.get(row.coldkey);
    if (!group) {
      if (groups.size >= 131072)
        throw new Error("Validator nominator group budget exceeded");
      group = {
        coldkey: row.coldkey,
        staked_tao: 0,
        unstaked_tao: 0,
        net_staked_tao: null,
        gross_staked_tao: null,
        event_count: 0,
        last_observed: row.observed_at!,
      };
      groups.set(row.coldkey, group);
    }
    group.event_count++;
    group.last_observed = Math.max(group.last_observed, row.observed_at!);
    if (row.amount_tao === null) continue;
    const added = row.event_kind === STAKE_ADDED_KIND;
    group[added ? "staked_tao" : "unstaked_tao"] += row.amount_tao;
    group.net_staked_tao =
      (group.net_staked_tao ?? 0) + (added ? row.amount_tao : -row.amount_tao);
    group.gross_staked_tao = (group.gross_staked_tao ?? 0) + row.amount_tao;
    if (
      ![
        group.staked_tao,
        group.unstaked_tao,
        group.net_staked_tao,
        group.gross_staked_tao,
      ].every(Number.isFinite)
    )
      throw new Error("Validator nominator aggregate exceeds numeric range");
  }
  const key =
    query.sort === "gross_staked"
      ? "gross_staked_tao"
      : query.sort === "last_activity"
        ? "last_observed"
        : "net_staked_tao";
  return {
    rows: [...groups.values()]
      .sort(
        (a, b) =>
          descending(a[key], b[key]) || addressOrder(a.coldkey, b.coldkey),
      )
      .slice(0, query.limit + query.offset),
    totalCount: groups.size,
  };
}
