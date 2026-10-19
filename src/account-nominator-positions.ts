import { round9OrNull, nonNegativeCellOrNull } from "./lib/rao.ts";
// Nominator-side (coldkey) position reconstruction (#5233): "what does this
// coldkey actually hold, across every hotkey/subnet it delegates to" — the
// original feature's question, not an asset-quantity guarantee. This legacy
// reconstruction preserves periodically observed coldkey/hotkey/subnet ties.
// The sibling portfolio is hotkey-scoped; neither scope proves wallet holdings.
//
// Legacy rows join nominator_positions.share_fraction to neurons.stake_tao
// for the referenced (hotkey, netuid). That neuron field records runtime
// voting weight (inherited alpha plus weighted inherited Root), not an
// independently measured native-alpha or TAO principal. Multiplying it by a
// fraction or price does not repair the missing quantity basis (#12014).
//
// Root holdings are outside this ledger's coverage. Missing relationships,
// failed reads and observations predating activity must not imply an empty
// wallet. Preserve capture/coverage evidence independently of numeric fields.
//
// stake_tao and total_stake_alpha remain legacy wire keys. Their names and
// finite values do not qualify asset units, cross-subnet totals, allocation
// or investment yield. Keep historical bytes/behavior compatible; public
// consumers withhold unsupported amounts until a separately qualified source
// establishes the quantity basis. See schemas-src/routes/account-positions.ts.

export const NOMINATOR_POSITION_INSERT_COLUMNS = [
  "coldkey",
  "hotkey",
  "netuid",
  "share_fraction",
  // The raw u128 the chain holds, added so `share_fraction` stops being the
  // ONLY thing we keep (metagraphed-infra#414). A fraction is normalised across
  // every row in a (hotkey, netuid) pool, so no single row can produce it --
  // which is why the poller buffers the whole 762,577-row keyspace before it
  // may write anything. Keeping the raw value moves that normalisation to one
  // statement after the prune and lets the producer stream.
  //
  // Optional on the wire: the producer that sends it does not exist yet, and
  // the normalisation skips a row without it. That is what makes this shippable
  // ahead of the poller.
  "shares",
  "captured_at",
];

// A finite, non-negative legacy numeric cell; this does not certify TAO units.
// Blank Postgres cells coerce via Number("") -> 0; skip those rather than
// joining a phantom zero-stake hotkey (mirrors buildGlobalValidators/
// numberOrZero's sibling null-safety elsewhere in this codebase).

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

// Preserve the legacy wire precision; rounding does not establish asset units.

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
 * Some ledger rows could not be reconstructed or their quantities are
 * unqualified. Legacy reconstruction excludes rows missing a sibling neuron
 * observation instead of inventing zero. The marker preserves that incomplete
 * coverage, including when only some rows were excluded (#9305).
 * Its historical name does not certify a price or an asset quantity. Absence
 * of this marker does not qualify the remaining legacy numbers as holdings.
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
   * Read/coverage degradation evidence. Absence does not establish complete
   * wallet coverage or an authoritative asset basis for legacy numeric fields.
   */
  degraded?: AccountPositionsDegraded;
}

// hotkeyNetuidStake: a Map keyed by "hotkey|netuid" -> stake_tao, built by
// the caller from periodic neuron observations. A
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
  // Ledger rows lacking a sibling neuron observation for reconstruction. Counted
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

    const stakeTao = round9OrNull(fraction * hotkeyStake);
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

  // Preserve legacy numeric order for compatibility, not a holdings-value rank.
  // Tie-break by hotkey then netuid for a stable order.
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
    total_stake_alpha: round9OrNull(totalStakeAlpha) ?? 0,
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
    const stake = nonNegativeCellOrNull(row?.stake_tao);
    if (!hotkey || netuid == null || stake == null) continue;
    map.set(`${hotkey}|${netuid}`, stake);
  }
  return map;
}
