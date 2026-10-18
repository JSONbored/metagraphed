// Site-wide accounts leaderboard (#4324/5.3): every hotkey currently
// registered somewhere on the network, aggregated cross-subnet from the
// `neurons` store tier. Follows buildGlobalValidators (src/metagraph-neurons.ts)
// as its explicit precedent — the collection-level counterpart to
// /api/v1/validators — but is NOT validator-scoped: every registered hotkey
// appears here, miners included, with a role breakdown per entry.
//
// This neuron-derived directory does not establish wallet balances or capital.
// The metagraph's stake_tao is voting weight (alpha + tao_weight * root), not
// independent principal. Neither a subnet price nor a root membership establishes
// holdings value. Keep capital keys null, including for observed zero weight.
//
// Also distinct from account_events: this leaderboard deliberately only
// covers CURRENTLY-registered hotkeys (neurons is a live snapshot, overwritten
// on every refresh-metagraph run) — an address that only ever transferred TAO
// or delegated to someone else's validator, and never registered its own
// hotkey, never appears here. That is the same "hotkey-only" framing
// loadAccountPortfolio (src/account-portfolio.ts) and
// src/account-position-history.ts already carry for this exact reason — not
// a new gap this route introduces.

import { loadStoreAlphaPricesByNetuid } from "./metagraph-neurons.ts";
import { clampRowLimit } from "../workers/request-params.ts";
import {
  round9NonNegative,
  nonNegativeOrZero,
  raoBigToTao,
  toRaoBig,
} from "./lib/rao.ts";

// Page-size ceiling, single-sourced in route-limits.ts so the contract's
// published `maximum` and this route's enforcement cannot drift (#9127).
import {
  ACCOUNTS_LIST_LIMIT_DEFAULT,
  ACCOUNTS_LIST_LIMIT_MAX,
} from "./route-limits.ts";
import { recordOrNull } from "./read-store.ts";
export { ACCOUNTS_LIST_LIMIT_DEFAULT, ACCOUNTS_LIST_LIMIT_MAX };
export const ACCOUNTS_LIST_SORTS = [
  "total_stake",
  "total_emission",
  "subnet_count",
  "uid_count",
  "validator_count",
  "stake_dominance",
  "last_active",
];
export const DEFAULT_ACCOUNTS_LIST_SORT = "total_stake";
// Cap the per-account subnets[] slice the same way buildGlobalValidators caps
// GlobalValidatorSubnet — an account registered on 100+ subnets should not
// balloon this leaderboard's payload; the account-portfolio/validator-detail
// routes already exist for the full per-subnet breakdown of one account.
const ACCOUNTS_LIST_SUBNET_LIMIT = 10;

function toIso(ms: number | null): string | null {
  if (ms == null) return null;
  const n = Number(ms);
  /* v8 ignore next -- defensive: both call sites only ever pass null or an
     already Number.isFinite-and->0-checked ms value (the accumulation loop's
     own capturedAt guard), so this re-check is provably unreachable today. */
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function nonNegativeInt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

// Emission sums run in rao-integer BigInt space, not float space -- see
// src/lib/rao.ts for why, and for the shared overflow guard.

function primaryColdkey(coldkeys: Map<string, number>): string | null {
  const ranked = [...coldkeys.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  return ranked[0]?.[0] ?? null;
}

export interface AccountsListSubnetEntry {
  netuid: number;
  uid: number;
  /** Unavailable: metagraph voting weight does not establish alpha principal. */
  stake_alpha: number | null;
  emission_alpha: number;
}

interface AccountAccumulator {
  hotkey: string;
  coldkeys: Map<string, number>;
  netuids: Set<number>;
  uidCount: number;
  validatorCount: number;
  emissionTotalRao: bigint;
  latestCapturedAt: number | null;
  latestBlockNumber: number | null;
  subnets: AccountsListSubnetEntry[];
}

export interface AccountsListEntry {
  hotkey: string;
  coldkey: string | null;
  coldkey_count: number;
  subnet_count: number;
  uid_count: number;
  validator_count: number;
  miner_count: number;
  total_stake_tao: number | null;
  total_emission_tao: number;
  latest_captured_at: string | null;
  latest_block_number: number | null;
  subnets: AccountsListSubnetEntry[];
  stake_dominance: number | null;
}

/** A legacy page's financial selection cannot be repaired after truncation. */
export function hasLegacyAccountsListCapital(value: unknown): boolean {
  const data = recordOrNull(value);
  if (!data || !Array.isArray(data.accounts)) return true;
  return data.accounts.some((entry) => {
    const account = recordOrNull(entry);
    return (
      !account ||
      account.total_stake_tao !== null ||
      account.stake_dominance !== null ||
      !Array.isArray(account.subnets) ||
      account.subnets.some(
        (subnet) => recordOrNull(subnet)?.stake_alpha !== null,
      )
    );
  });
}

// A finite non-negative price, or null. Zero is a legal price (a fully
// drained pool values the alpha at nothing); negative/NaN are not.
function nullablePositivePrice(
  value: number | null | undefined,
): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function buildAccountEntry(entry: AccountAccumulator): AccountsListEntry {
  const subnets = entry.subnets
    .sort((a, b) => a.netuid - b.netuid || a.uid - b.uid)
    .slice(0, ACCOUNTS_LIST_SUBNET_LIMIT);
  return {
    hotkey: entry.hotkey,
    coldkey: primaryColdkey(entry.coldkeys),
    coldkey_count: entry.coldkeys.size,
    subnet_count: entry.netuids.size,
    uid_count: entry.uidCount,
    validator_count: entry.validatorCount,
    miner_count: entry.uidCount - entry.validatorCount,
    total_stake_tao: null,
    stake_dominance: null,
    total_emission_tao: round9NonNegative(raoBigToTao(entry.emissionTotalRao)),
    latest_captured_at: toIso(entry.latestCapturedAt),
    latest_block_number: entry.latestBlockNumber,
    subnets,
  };
}

const ACCOUNTS_LIST_SORT_FIELDS: Record<string, string> = {
  total_stake: "total_stake_tao",
  total_emission: "total_emission_tao",
  last_active: "latest_block_number",
};

function accountSortValue(row: AccountsListEntry, key: string): number {
  const field = ACCOUNTS_LIST_SORT_FIELDS[key] ?? key;
  const value = recordOrNull(row)?.[field];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : Number.NEGATIVE_INFINITY;
}

export interface AccountsListResult {
  schema_version: 1;
  sort: string;
  limit: number;
  captured_at: string | null;
  block_number: number | null;
  account_count: number;
  accounts: AccountsListEntry[];
}

export interface AccountsSnapshot {
  captured_at: string | null;
  block_number: number | null;
  accounts: AccountsListEntry[];
}

/**
 * Aggregate the complete neuron snapshot once, before any transport-specific
 * sort or limit is applied.
 *
 * Both the public sortable leaderboard and the website directory derive from
 * this canonical shape. Keeping the expensive cross-subnet fold here means a
 * directory containing several rankings does not repeat it once per ranking.
 */
export function buildAccountsSnapshot(
  rows: Array<Record<string, unknown>> | null | undefined,
  { priceByNetuid }: { priceByNetuid: Map<number, number | null> },
): AccountsSnapshot {
  const accountsByHotkey = new Map<string, AccountAccumulator>();
  let latestCapturedAt: number | null = null;
  let latestBlockNumber: number | null = null;

  for (const row of Array.isArray(rows) ? rows : []) {
    const hotkey =
      typeof row?.hotkey === "string" && row.hotkey.length > 0
        ? row.hotkey
        : null;
    const netuid = nonNegativeInt(row?.netuid);
    const uid = nonNegativeInt(row?.uid);
    if (!hotkey || netuid == null || uid == null) continue;

    const emission = nonNegativeOrZero(row?.emission_tao);
    const isValidator = Number(row?.validator_permit) === 1;
    const capturedAt =
      row?.captured_at == null ? null : Number(row.captured_at);
    const blockNumber = nonNegativeInt(row?.block_number);

    let entry = accountsByHotkey.get(hotkey);
    if (!entry) {
      entry = {
        hotkey,
        coldkeys: new Map(),
        netuids: new Set(),
        uidCount: 0,
        validatorCount: 0,
        emissionTotalRao: 0n,
        latestCapturedAt: null,
        latestBlockNumber: null,
        subnets: [],
      };
      accountsByHotkey.set(hotkey, entry);
    }
    if (typeof row?.coldkey === "string" && row.coldkey.length > 0) {
      entry.coldkeys.set(
        row.coldkey,
        (entry.coldkeys.get(row.coldkey) ?? 0) + 1,
      );
    }
    entry.netuids.add(netuid);
    entry.uidCount += 1;
    if (isValidator) entry.validatorCount += 1;
    const price =
      netuid === 0 ? 1 : nullablePositivePrice(priceByNetuid.get(netuid));
    if (price != null) {
      entry.emissionTotalRao += toRaoBig(emission * price);
    }
    if (capturedAt != null && Number.isFinite(capturedAt) && capturedAt > 0) {
      if (
        entry.latestCapturedAt == null ||
        capturedAt > entry.latestCapturedAt ||
        (capturedAt === entry.latestCapturedAt &&
          blockNumber != null &&
          (entry.latestBlockNumber == null ||
            blockNumber > entry.latestBlockNumber))
      ) {
        entry.latestCapturedAt = capturedAt;
        entry.latestBlockNumber = blockNumber;
      }
      if (
        latestCapturedAt == null ||
        capturedAt > latestCapturedAt ||
        (capturedAt === latestCapturedAt &&
          blockNumber != null &&
          (latestBlockNumber == null || blockNumber > latestBlockNumber))
      ) {
        latestCapturedAt = capturedAt;
        latestBlockNumber = blockNumber;
      }
    }
    entry.subnets.push({
      netuid,
      uid,
      stake_alpha: null,
      emission_alpha: round9NonNegative(emission),
    });
  }

  return {
    captured_at: toIso(latestCapturedAt),
    block_number: latestBlockNumber,
    accounts: [...accountsByHotkey.values()].map(buildAccountEntry),
  };
}

// Shape every currently-registered hotkey's cross-subnet footprint into a
// paginated, sortable leaderboard. `rows` is one row per (netuid, uid) —
// every neurons row, not just validator_permit=1 ones (that's
// buildGlobalValidators' job). Null-safe: no rows (cold store) yields a
// schema-stable empty leaderboard.
export function buildAccountsList(
  rows: Array<Record<string, unknown>> | null | undefined,
  {
    sort = DEFAULT_ACCOUNTS_LIST_SORT,
    limit = ACCOUNTS_LIST_LIMIT_DEFAULT,
    priceByNetuid,
  }: {
    sort?: string;
    limit?: number | string;
    /** REQUIRED, never defaulted -- see BuildGlobalValidatorsOptions (#9051). */
    priceByNetuid: Map<number, number | null>;
  },
): AccountsListResult {
  const normalizedSort = ACCOUNTS_LIST_SORTS.includes(sort)
    ? sort
    : DEFAULT_ACCOUNTS_LIST_SORT;
  // Floor at 0, not 1: an explicit limit=0 returns an empty leaderboard
  // rather than one row nobody asked for. clampRowLimit is that rule.
  const normalizedLimit = clampRowLimit(
    limit,
    ACCOUNTS_LIST_LIMIT_DEFAULT,
    ACCOUNTS_LIST_LIMIT_MAX,
  );
  const snapshot = buildAccountsSnapshot(rows, { priceByNetuid });
  // Legacy financial sort names stay accepted; unavailable values tie by hotkey.
  const accounts = [...snapshot.accounts].sort(
    (a, b) =>
      accountSortValue(b, normalizedSort) -
        accountSortValue(a, normalizedSort) || a.hotkey.localeCompare(b.hotkey),
  );

  return {
    schema_version: 1,
    sort: normalizedSort,
    limit: normalizedLimit,
    captured_at: snapshot.captured_at,
    block_number: snapshot.block_number,
    account_count: accounts.length,
    accounts: accounts.slice(0, normalizedLimit),
  };
}

// store read path shared by the REST handler and (future) MCP tool — same
// pattern as loadGlobalValidators. `d1` is a (sql, params) => Promise<rows[]>
// runner; a cold/unbound DB returns [] -> a schema-stable empty leaderboard.
export async function loadAccountsList(
  runner: (
    sql: string,
    params: unknown[],
  ) => Promise<Array<Record<string, unknown>>>,
  {
    sort = DEFAULT_ACCOUNTS_LIST_SORT,
    limit = ACCOUNTS_LIST_LIMIT_DEFAULT,
  }: {
    sort?: string;
    limit?: number | string;
  } = {},
): Promise<AccountsListResult> {
  const [rows, priceByNetuid] = await Promise.all([
    runner(
      "SELECT netuid, uid, hotkey, coldkey, validator_permit, emission_tao, " +
        "block_number, captured_at FROM neurons " +
        "WHERE hotkey IS NOT NULL " +
        "ORDER BY hotkey ASC, netuid ASC, uid ASC",
      [],
    ),
    // #9051: retain the emission-only pricing from the snapshot stores mirror.
    loadStoreAlphaPricesByNetuid(runner),
  ]);
  return buildAccountsList(rows, { sort, limit, priceByNetuid });
}
