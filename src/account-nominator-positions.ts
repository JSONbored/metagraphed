// Nominator-side (coldkey) position reconstruction (#5233): "what does this
// coldkey actually hold, across every hotkey/subnet it delegates to" — the
// coldkey-scoped counterpart to buildAccountPortfolio's hotkey-scoped view
// (src/account-portfolio.ts), which only ever showed near-zero for a pure
// delegator (its stake lives on someone ELSE's hotkey row, not its own).
//
// Sourced from nominator_positions (migration 0044, populated by the same
// SubtensorModule::Alpha scan as validator_nominator_counts, #2549) joined
// against the live neurons stake_tao for each referenced (hotkey, netuid) --
// see that migration's header comment for why this table stores a
// dimensionless share_fraction rather than a snapshotted TAO figure. Pure +
// exported for tests; the Worker does the Postgres reads and calls
// buildAccountPositions with both result sets.
//
// Known scope limitation (documented in the fetch script + migration too):
// root (netuid 0) stake is NOT covered -- SubtensorModule::Alpha carries no
// root data at all (root is TAO-denominated 1:1, no alpha pool, #2550), so a
// coldkey that only holds root-delegated stake shows zero positions here,
// not because it holds nothing but because this source can't see it yet.
//
// That same limitation is why the aggregate is `total_stake_alpha`, renamed
// from total_stake_tao in #8803. Because root is excluded, EVERY position
// here sits on a netuid != 0, and non-root neurons.stake_tao is that
// subnet's alpha token rather than TAO (src/metagraph-neurons.ts, #2550) --
// so the aggregate is a sum of different subnets' alpha, which is a count,
// not a TAO value. It is named for what it is instead of being converted:
// unlike /accounts/top-holders (#8803), nothing here adds it to real TAO, so
// the only harm was the name, and a rename cannot silently change a number
// under an existing consumer the way a conversion would. positions[] keeps
// its per-row `stake_tao` -- that is the on-chain column name every
// neurons-tier route uses, and renaming it repo-wide is its own change.

export const NOMINATOR_POSITION_INSERT_COLUMNS = [
  "coldkey",
  "hotkey",
  "netuid",
  "share_fraction",
  "captured_at",
];

// A finite, non-negative TAO cell, or null when absent/blank/non-numeric.
// Blank Postgres cells coerce via Number("") -> 0; skip those rather than
// joining a phantom zero-stake hotkey (mirrors buildGlobalValidators/
// numberOrZero's sibling null-safety elsewhere in this codebase).
function nullableTao(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function nonNegativeInt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function nullableFraction(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// 1 TAO = 1e9 rao; round tao outputs to that precision (matches the sibling
// account-tier modules' own round9/roundTao helpers).
const RAO_PER_TAO = 1e9;
function roundTao(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * RAO_PER_TAO) / RAO_PER_TAO;
}

function round6(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 1e6) / 1e6;
}

function toIso(ms: number): string | null {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export interface AccountNominatorPosition {
  hotkey: string;
  netuid: number;
  share_fraction: number | null;
  stake_tao: number;
}

/**
 * Both tiers declined -- this zero is a read failure, not a measurement.
 * Same vocabulary as workers/request-handlers/analytics.ts's
 * DEGRADED_TIER_UNAVAILABLE, which labels the identical condition on the
 * analytics routes.
 */
export const POSITIONS_DEGRADED_TIER_UNAVAILABLE = "tier_unavailable";

/**
 * The ledger answered zero, but this coldkey has stake activity on chain that
 * is NEWER than the ledger's own snapshot -- so the zero cannot be trusted.
 *
 * This is the #9273 failure in one field. Four of five coldkeys sampled from a
 * live /validators/{hotkey}/nominators response -- all of them provably
 * delegating right now -- got `positions: 0, total_stake_alpha: 0` from a
 * ledger frozen before they started. An honest decline beats a confident wrong
 * zero.
 */
export const POSITIONS_DEGRADED_SNAPSHOT_PREDATES_ACTIVITY =
  "snapshot_predates_stake_activity";

/**
 * The ledger HAS rows for this coldkey, but one or more of them could not be
 * priced, so they are absent from `positions` and from `total_stake_alpha`.
 *
 * Positions are priced off the live `neurons` table, which carries only
 * CURRENTLY-registered neurons, while the position ledger is a snapshot. A
 * hotkey that has since deregistered -- or that the ledger saw and `neurons`
 * has not -- prices to nothing, and the position is excluded rather than
 * reported with a fabricated 0 stake_tao (#9066's rule: no unpriced values).
 *
 * Excluding it is right. Saying nothing about it was not. Sampling eight
 * distinct hotkeys from the live ledger, only ONE was present in `neurons`, so
 * a coldkey whose positions all price to nothing published
 * `position_count: 0, total_stake_alpha: 0` with no marker at all -- a
 * confident zero over real holdings, indistinguishable from "delegates
 * nothing" (#9305).
 *
 * Fires whenever ANY row was dropped, not only when all of them were: a
 * partially-priced total understates the account's real position just as
 * silently, it is merely harder to notice.
 */
export const POSITIONS_DEGRADED_UNPRICEABLE = "positions_unpriceable";

/**
 * Every reason this surface can publish, as the tuple the schema enum is built
 * from.
 *
 * The enum used to be re-typed by hand in schemas-src/routes/account-positions.ts
 * and listed two of these three, so production served `positions_unpriceable`
 * against a contract that said it was impossible (#9804). A client validating
 * strictly rejected a valid response; a client switching on the enum fell
 * through silently -- on the one field whose entire job is telling a caller not
 * to trust the number beside it.
 *
 * Declared here, next to the constants, so a reason cannot exist in code
 * without appearing in the published contract. Adding one below and forgetting
 * the schema is no longer possible; there is only one list.
 */
export const POSITIONS_DEGRADED_REASONS = [
  POSITIONS_DEGRADED_TIER_UNAVAILABLE,
  POSITIONS_DEGRADED_SNAPSHOT_PREDATES_ACTIVITY,
  POSITIONS_DEGRADED_UNPRICEABLE,
] as const;

export interface AccountPositionsDegraded {
  reason: string;
  /** The LEDGER's own capture stamp, not this account's -- present even when
   * the account has no rows in it, which is the case this exists for. */
  snapshot_captured_at: string | null;
  /** The newest StakeAdded/StakeRemoved this coldkey has on chain, when that
   * is what contradicts the zero. */
  latest_stake_event_at: string | null;
}

export interface AccountPositionsResult {
  schema_version: 1;
  ss58: string;
  captured_at: string | null;
  position_count: number;
  total_stake_alpha: number;
  positions: AccountNominatorPosition[];
  /**
   * Present ONLY when this payload's zero is not a measurement. Absent on
   * every trustworthy answer, so a consumer that ignores it reads exactly what
   * it read before -- and one that checks it can tell "delegates nothing" from
   * "we cannot currently say".
   */
  degraded?: AccountPositionsDegraded;
}

// hotkeyNetuidStake: a Map keyed by "hotkey|netuid" -> stake_tao, built by
// the caller (loadNeuronStakeByHotkey below) from a live neurons read. A
// position whose hotkey+netuid isn't in the map (the hotkey deregistered,
// or the daily neurons snapshot hasn't caught up to a brand-new stake
// event) is excluded rather than reported with a fabricated 0 stake_tao --
// same null-never-fabricated convention as nominator_count/apy_estimate.
export function buildAccountPositions(
  positionRows: Array<Record<string, unknown>> | null | undefined,
  hotkeyNetuidStake: Map<string, number> | null | undefined,
  ss58: string,
): AccountPositionsResult {
  const rows = Array.isArray(positionRows) ? positionRows : [];
  const stakeByKey =
    hotkeyNetuidStake instanceof Map ? hotkeyNetuidStake : new Map();
  const positions: AccountNominatorPosition[] = [];
  let totalStakeAlpha = 0;
  let latestCapturedAt: number | null = null;
  // Rows the ledger holds that no live `neurons` row could price. Counted
  // rather than merely skipped so the payload can say so -- see
  // POSITIONS_DEGRADED_UNPRICEABLE.
  let unpriceable = 0;

  for (const row of rows) {
    const hotkey = typeof row?.hotkey === "string" ? row.hotkey : null;
    const netuid = nonNegativeInt(row?.netuid);
    const fraction = nullableFraction(row?.share_fraction);
    if (!hotkey || netuid == null || fraction == null) continue;

    const hotkeyStake = stakeByKey.get(`${hotkey}|${netuid}`);
    if (hotkeyStake == null) {
      unpriceable += 1;
      continue;
    }

    const stakeTao = roundTao(fraction * hotkeyStake);
    if (stakeTao == null) continue;
    totalStakeAlpha += stakeTao;

    const capturedAt = nonNegativeInt(row?.captured_at);
    if (
      capturedAt != null &&
      (latestCapturedAt == null || capturedAt > latestCapturedAt)
    ) {
      latestCapturedAt = capturedAt;
    }

    positions.push({
      hotkey,
      netuid,
      share_fraction: round6(fraction),
      stake_tao: stakeTao,
    });
  }

  // Biggest position first; tie-break by hotkey then netuid for a stable order.
  positions.sort(
    (a, b) =>
      b.stake_tao - a.stake_tao ||
      a.hotkey.localeCompare(b.hotkey) ||
      a.netuid - b.netuid,
  );

  const result: AccountPositionsResult = {
    schema_version: 1,
    ss58,
    captured_at: latestCapturedAt != null ? toIso(latestCapturedAt) : null,
    position_count: positions.length,
    total_stake_alpha: roundTao(totalStakeAlpha) ?? 0,
    positions,
  };
  // The two provenance stamps belong to the LEDGER and to this coldkey's chain
  // activity, neither of which this pure builder can see -- the callers that
  // do have them attach the stronger `snapshot_predates_stake_activity` reason
  // over this one when it also applies, which is the right precedence: both
  // say "do not trust this total", and that one says why more usefully.
  if (unpriceable > 0) {
    result.degraded = {
      reason: POSITIONS_DEGRADED_UNPRICEABLE,
      snapshot_captured_at: null,
      latest_stake_event_at: null,
    };
  }
  return result;
}

// Distinct, order-stable, non-empty hotkeys referenced by a coldkey's
// position rows -- the input to loadNeuronStakeByHotkey's IN-list query.
export function distinctHotkeys(
  positionRows: Array<Record<string, unknown>> | null | undefined,
): string[] {
  const seen = new Set<string>();
  for (const row of Array.isArray(positionRows) ? positionRows : []) {
    if (typeof row?.hotkey === "string" && row.hotkey.length > 0) {
      seen.add(row.hotkey);
    }
  }
  return [...seen];
}

/**
 * The empty card served when EVERY tier declined -- labelled as such (#9273).
 *
 * The unlabelled `buildAccountPositions([], new Map(), ss58)` this replaces
 * was indistinguishable from a coldkey that genuinely delegates nothing: same
 * `position_count: 0`, same `total_stake_alpha: 0`, same 200. That is the
 * defect this route shares with #9260/#9263, and it is worse here because the
 * payload carries a confident TOTAL rather than merely an empty list.
 */
/**
 * Give a forwarded tier's payload the `degraded` shape this route's contract
 * declares.
 *
 * The Postgres arm forwards an upstream response verbatim instead of building
 * it here, so it is the one path that can publish a `degraded` block this file
 * never shaped -- and production does exactly that, serving a bare
 * `{"reason":"tier_unavailable"}` while the schema declares
 * `snapshot_captured_at` and `latest_stake_event_at` required (nullable, but
 * required). Every locally-built decline already carries all three.
 *
 * Null is the honest value for a stamp an upstream did not send: "we don't know
 * when" is a statement the schema can carry, and a missing key is not. Anything
 * the upstream DID send is preserved -- this fills gaps, it does not overwrite.
 *
 * Same reasoning as the rpc-usage composer refusing to trust a forwarded tier's
 * `observed_at` (#9794): a tier whose representation is taken on faith is how a
 * field ends up meaning different things on different paths.
 */
export function shapeForwardedPositions<T>(payload: T): T {
  const row = payload as Record<string, unknown> | null;
  const degraded = row?.degraded as Record<string, unknown> | undefined;
  if (!degraded || typeof degraded !== "object") return payload;
  return {
    ...row,
    degraded: {
      snapshot_captured_at: null,
      latest_stake_event_at: null,
      ...degraded,
    },
  } as T;
}

export function unavailableAccountPositions(
  ss58: string,
): AccountPositionsResult {
  return {
    ...buildAccountPositions([], new Map(), ss58),
    degraded: {
      reason: POSITIONS_DEGRADED_TIER_UNAVAILABLE,
      snapshot_captured_at: null,
      latest_stake_event_at: null,
    },
  };
}

/**
 * Attach a snapshot's own provenance to a result that came back empty.
 *
 * Two things happen here, both only when the account resolved to ZERO
 * positions (a non-empty result already carries its own `captured_at` from its
 * own rows, and needs no help being read correctly):
 *
 *  1. `captured_at` becomes the LEDGER's stamp rather than null. A null stamp
 *     beside a zero total tells a caller nothing at all; the ledger's stamp
 *     tells them exactly how old the answer is, which is requirement 2's floor.
 *  2. When the coldkey has a stake event NEWER than that stamp, the zero is
 *     labelled `degraded`. The account was demonstrably staking after the
 *     ledger was captured, so "holds nothing" is a claim the ledger is not
 *     entitled to make.
 *
 * A missing ledger stamp with a known stake event still degrades: an
 * unstamped ledger is strictly less trustworthy than a stamped one, so it
 * cannot be the thing that rescues the zero.
 *
 * Pure -- no clock, no store -- so both edges are testable directly.
 */
export function annotatePositionsSnapshot(
  result: AccountPositionsResult,
  snapshot: {
    snapshotCapturedAtMs: number | null;
    latestStakeEventMs: number | null;
  },
): AccountPositionsResult {
  if (result.position_count > 0) return result;
  const { snapshotCapturedAtMs, latestStakeEventMs } = snapshot;
  const snapshotCapturedAt =
    snapshotCapturedAtMs != null ? toIso(snapshotCapturedAtMs) : null;
  const annotated: AccountPositionsResult = {
    ...result,
    captured_at: result.captured_at ?? snapshotCapturedAt,
  };
  const contradicted =
    latestStakeEventMs != null &&
    (snapshotCapturedAtMs == null || latestStakeEventMs > snapshotCapturedAtMs);
  if (contradicted) {
    annotated.degraded = {
      reason: POSITIONS_DEGRADED_SNAPSHOT_PREDATES_ACTIVITY,
      snapshot_captured_at: snapshotCapturedAt,
      latest_stake_event_at: toIso(latestStakeEventMs),
    };
  }
  return annotated;
}

// Postgres neurons rows (hotkey, netuid, stake_tao) -> a "hotkey|netuid" ->
// stake_tao Map, for buildAccountPositions' join above.
export function stakeByHotkeyNetuid(
  neuronRows: Array<Record<string, unknown>> | null | undefined,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of Array.isArray(neuronRows) ? neuronRows : []) {
    const hotkey = typeof row?.hotkey === "string" ? row.hotkey : null;
    const netuid = nonNegativeInt(row?.netuid);
    const stake = nullableTao(row?.stake_tao);
    if (!hotkey || netuid == null || stake == null) continue;
    map.set(`${hotkey}|${netuid}`, stake);
  }
  return map;
}
