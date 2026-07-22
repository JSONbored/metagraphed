// Site-wide accounts leaderboard (#4324/5.3): every hotkey currently
// registered somewhere on the network, aggregated cross-subnet from the
// `neurons` D1 tier. Follows buildGlobalValidators (src/metagraph-neurons.mjs)
// as its explicit precedent — the collection-level counterpart to
// /api/v1/validators — but is NOT validator-scoped: every registered hotkey
// appears here, miners included, with a role breakdown per entry.
//
// Scope limitation vs the competitor benchmark this issue cites (Account /
// Free / Delegated / Total / Last-Update): "Free" (spendable TAO balance) and
// therefore "Total" (Free + Delegated) are NOT derivable from account_events
// or neurons — this codebase has no balance-tracking tier; the only place
// balance is known at all is a per-address LIVE RPC query
// (loadAccountBalance, src/account-balance.mjs), which doesn't scale to a
// full-table leaderboard (one RPC round trip per row). total_stake_tao below
// is the "Delegated" analog: for a validator hotkey this is the FULL stake
// pool delegated to it by every nominator (migrations/0007_neurons.sql's own
// stake_tao definition); for a miner hotkey it's typically just its own small
// self-stake. Named total_stake_tao, not delegated_tao, to stay accurate
// rather than imply a guarantee this data doesn't back for every row.
//
// Also distinct from account_events: this leaderboard deliberately only
// covers CURRENTLY-registered hotkeys (neurons is a live snapshot, overwritten
// on every refresh-metagraph run) — an address that only ever transferred TAO
// or delegated to someone else's validator, and never registered its own
// hotkey, never appears here. That is the same "hotkey-only" framing
// loadAccountPortfolio (src/account-portfolio.mjs) and
// src/account-position-history.mjs already carry for this exact reason — not
// a new gap this route introduces.

const RAO_PER_TAO = 1e9;

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
export const ACCOUNTS_LIST_LIMIT_DEFAULT = 20;
export const ACCOUNTS_LIST_LIMIT_MAX = 100;
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

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function nonNegativeInt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function roundTao(value: unknown): number {
  return Math.round(numberOrZero(value) * RAO_PER_TAO) / RAO_PER_TAO;
}

// Sum in rao-integer BigInt space, not float space — mirrors
// buildGlobalValidators' own toRaoBig/raoBigToTao pair and its cited
// rationale (metagraphed#2922): summing many already-rounded per-UID
// stake_tao/emission_tao values per hotkey with plain `+=` compounds
// float error across the accumulation even when each input is exact.
function toRaoBig(tao: number): bigint {
  return BigInt(Math.round(tao * RAO_PER_TAO));
}
function raoBigToTao(rao: bigint): number {
  return Number(rao / 1_000_000_000n) + Number(rao % 1_000_000_000n) / 1e9;
}

function round(value: number | null, dp = 6): number | null {
  /* v8 ignore next -- defensive: this module's one caller (applyStakeDominance)
     only ever divides a numberOrZero() result by an already-Number.isFinite-
     and->0-checked denominator, so this branch is provably unreachable today. */
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

function primaryColdkey(coldkeys: Map<string, number>): string | null {
  const ranked = [...coldkeys.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  return ranked[0]?.[0] ?? null;
}

export interface AccountsListSubnetEntry {
  netuid: number;
  uid: number;
  stake_tao: number;
  emission_tao: number;
}

interface AccountAccumulator {
  hotkey: string;
  coldkeys: Map<string, number>;
  netuids: Set<number>;
  uidCount: number;
  validatorCount: number;
  stakeTotalRao: bigint;
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
  total_stake_tao: number;
  total_emission_tao: number;
  latest_captured_at: string | null;
  latest_block_number: number | null;
  subnets: AccountsListSubnetEntry[];
  stake_dominance?: number | null;
}

function buildAccountEntry(entry: AccountAccumulator): AccountsListEntry {
  const subnets = entry.subnets
    .sort(
      (a, b) =>
        b.stake_tao - a.stake_tao ||
        b.emission_tao - a.emission_tao ||
        a.netuid - b.netuid ||
        a.uid - b.uid,
    )
    .slice(0, ACCOUNTS_LIST_SUBNET_LIMIT);
  return {
    hotkey: entry.hotkey,
    coldkey: primaryColdkey(entry.coldkeys),
    coldkey_count: entry.coldkeys.size,
    subnet_count: entry.netuids.size,
    uid_count: entry.uidCount,
    validator_count: entry.validatorCount,
    miner_count: entry.uidCount - entry.validatorCount,
    total_stake_tao: roundTao(raoBigToTao(entry.stakeTotalRao)),
    total_emission_tao: roundTao(raoBigToTao(entry.emissionTotalRao)),
    latest_captured_at: toIso(entry.latestCapturedAt),
    latest_block_number: entry.latestBlockNumber,
    subnets,
  };
}

// Network-wide share of an account's total_stake_tao — the "how much of the
// network's registered stake sits behind this one hotkey" figure. Sums the
// already-rounded per-account totals (rao-precision, see buildAccountEntry),
// mirroring buildGlobalValidators' applyStakeDominance exactly.
function applyStakeDominance(
  accounts: AccountsListEntry[],
): AccountsListEntry[] {
  const networkStakeRao = accounts.reduce(
    (sum, entry) => sum + toRaoBig(entry.total_stake_tao),
    0n,
  );
  const networkStakeTotal = raoBigToTao(networkStakeRao);
  if (!(networkStakeTotal > 0) || !Number.isFinite(networkStakeTotal)) {
    return accounts.map((entry) => ({ ...entry, stake_dominance: null }));
  }
  return accounts.map((entry) => ({
    ...entry,
    stake_dominance: round(
      numberOrZero(entry.total_stake_tao) / networkStakeTotal,
    ),
  }));
}

const ACCOUNTS_LIST_SORT_FIELDS: Record<string, string> = {
  total_stake: "total_stake_tao",
  total_emission: "total_emission_tao",
  last_active: "latest_block_number",
};

function accountSortValue(row: AccountsListEntry, key: string): number {
  const field = ACCOUNTS_LIST_SORT_FIELDS[key] ?? key;
  const value = (row as unknown as Record<string, unknown>)[field];
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
  }: { sort?: string; limit?: number | string } = {},
): AccountsListResult {
  const normalizedSort = ACCOUNTS_LIST_SORTS.includes(sort)
    ? sort
    : DEFAULT_ACCOUNTS_LIST_SORT;
  const flooredLimit = Math.floor(Number(limit));
  // Floor at 0, not 1, so an explicit limit=0 returns an empty leaderboard
  // rather than being silently bumped up to one account — mirrors
  // buildGlobalValidators' own clamp.
  const normalizedLimit = Number.isFinite(flooredLimit)
    ? Math.max(0, Math.min(flooredLimit, ACCOUNTS_LIST_LIMIT_MAX))
    : ACCOUNTS_LIST_LIMIT_DEFAULT;

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

    const stake = numberOrZero(row?.stake_tao);
    const emission = numberOrZero(row?.emission_tao);
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
        stakeTotalRao: 0n,
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
    entry.stakeTotalRao += toRaoBig(stake);
    entry.emissionTotalRao += toRaoBig(emission);
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
      stake_tao: roundTao(stake),
      emission_tao: roundTao(emission),
    });
  }

  const accounts = applyStakeDominance(
    [...accountsByHotkey.values()].map(buildAccountEntry),
  ).sort(
    (a, b) =>
      accountSortValue(b, normalizedSort) -
        accountSortValue(a, normalizedSort) || a.hotkey.localeCompare(b.hotkey),
  );

  return {
    schema_version: 1,
    sort: normalizedSort,
    limit: normalizedLimit,
    captured_at: toIso(latestCapturedAt),
    block_number: latestBlockNumber,
    account_count: accounts.length,
    accounts: accounts.slice(0, normalizedLimit),
  };
}

// D1 read path shared by the REST handler and (future) MCP tool — same
// pattern as loadGlobalValidators. `d1` is a (sql, params) => Promise<rows[]>
// runner; a cold/unbound DB returns [] -> a schema-stable empty leaderboard.
export async function loadAccountsList(
  d1: (
    sql: string,
    params: unknown[],
  ) => Promise<Array<Record<string, unknown>>>,
  {
    sort = DEFAULT_ACCOUNTS_LIST_SORT,
    limit = ACCOUNTS_LIST_LIMIT_DEFAULT,
  }: { sort?: string; limit?: number | string } = {},
): Promise<AccountsListResult> {
  const rows = await d1(
    "SELECT netuid, uid, hotkey, coldkey, validator_permit, emission_tao, " +
      "stake_tao, block_number, captured_at FROM neurons " +
      "WHERE hotkey IS NOT NULL " +
      "ORDER BY hotkey ASC, stake_tao DESC, netuid ASC, uid ASC",
    [],
  );
  return buildAccountsList(rows, { sort, limit });
}
