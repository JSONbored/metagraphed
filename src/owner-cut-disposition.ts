import { round9 } from "./lib/rao.ts";
// #10485: what happened to the owner cut after it accrued.
//
// #10484 answers how much was credited. This answers where it went, and it is
// the half people actually want -- which is exactly why it is the half most
// likely to be answered confidently and wrongly.
//
// THE FALSE NEGATIVE THIS MODULE EXISTS TO AVOID. The cut is paid as STAKE, not
// as a liquid balance. A classifier that watches `Balances.Transfer` alone sees
// nothing move, concludes nothing left, and reports `held-as-stake` for every
// subnet on the network. That answer is well-formed, complete-looking, and
// wrong. So the absence of flow evidence resolves to `unresolved`, NEVER to
// held -- held is a claim, and it needs a balance to support it.
//
// FIVE BUCKETS, NOT SIX. #10440 lists `sold` beside `unstaked`. On dTAO they
// are the same on-chain event: `StakeRemoved` takes alpha out of the subnet's
// AMM pool and returns TAO, so removing stake IS the disposal. There is no
// separate sale to observe, and a `sold` bucket would be a distinction we
// cannot evidence -- the kind of invented precision this epic's own rules
// forbid. The limitation is published rather than hidden behind an empty
// bucket that looks like "we checked and found none".
//
// THE BUCKETS DO NOT HAVE TO SUM. When they do not, the response says so and
// reports the residual. Balancing to a residual -- assigning the remainder to
// `unresolved` so the totals tie -- would turn "we cannot account for this" into
// a number that looks derived.

/** What we can actually distinguish from the chain. */
export const DISPOSITION_BUCKETS = [
  "held-as-stake",
  "unstaked",
  "transferred-out",
  "burned",
  "unresolved",
] as const;
export type DispositionBucket = (typeof DISPOSITION_BUCKETS)[number];

export interface DispositionInput {
  netuid: number;
  window_days?: number;
  /** Alpha credited over the window, from src/owner-cut-accrual.ts. */
  accrued_alpha: number | null | undefined;
  /**
   * Alpha currently staked on the owner's own hotkey. READ FROM THE
   * HOTKEY-SCOPED VIEW (/accounts/{ss58}/portfolio), not /positions -- the
   * latter is the nominator-side view and returns zero for an owner staking on
   * its own hotkey, which is most of them (#10481).
   *
   * Null means we did not read it, and a null balance can never support a
   * `held-as-stake` claim.
   */
  held_alpha?: number | null;
  /** StakeRemoved over the window. On dTAO this is also the disposal. */
  unstaked_alpha?: number | null;
  /** StakeTransferred to another account over the window. */
  transferred_alpha?: number | null;
  /** Moved to an address with proven unspendability (#10483's `burn`). */
  burned_alpha?: number | null;
  /**
   * Did we actually read the flow streams? FALSE or absent means the buckets
   * below are silence rather than zeros, and everything resolves to unresolved.
   */
  flows_observed?: boolean;
}

export interface DispositionResult {
  netuid: number;
  window_days: number;
  accrued_alpha: number | null;
  buckets: Record<DispositionBucket, number | null>;
  /** accrued - (everything we could account for). Null when accrual is null. */
  residual_alpha: number | null;
  /** Do the buckets account for the accrual, within tolerance? */
  reconciles: boolean;
  /**
   * Why not, or what is missing. Present far more often than not, by design --
   * `unresolved` may be the majority state at launch and that is an honest
   * answer rather than a failure.
   */
  notes: string[];
}

/**
 * The flow window the disposition reads, as a stake-flow window LABEL.
 *
 * Must resolve to the same span as the accrual's `ATTRIBUTION_WINDOW_DAYS`
 * (30). Named here, beside the classifier that depends on the alignment,
 * rather than spelled at the call site -- requirement 4 of #10930 is that the
 * windows line up, and a literal at one of two call sites is how they stop.
 */
export const OWNER_CUT_FLOW_WINDOW = "30d";

/** Alpha is 9dp on chain; anything under this is rounding, not a gap. */
export const DISPOSITION_TOLERANCE_ALPHA = 1e-6;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function emptyBuckets(): Record<DispositionBucket, number | null> {
  return {
    "held-as-stake": null,
    unstaked: null,
    "transferred-out": null,
    burned: null,
    unresolved: null,
  };
}

/**
 * Classify one subnet's accrued cut over a window.
 *
 * Never throws, and never invents a bucket. Every figure it reports is one it
 * was handed; everything else is `unresolved` with a stated reason.
 */
export function classifyOwnerCutDisposition(
  input: DispositionInput,
): DispositionResult {
  const window_days = finite(input.window_days) ?? 1;
  const accrued = finite(input.accrued_alpha);
  const notes: string[] = [];
  const buckets = emptyBuckets();

  if (accrued === null) {
    notes.push("accrual not measured, so nothing can be attributed to it");
    return {
      netuid: input.netuid,
      window_days,
      accrued_alpha: null,
      buckets,
      residual_alpha: null,
      reconciles: false,
      notes,
    };
  }

  // THE WHOLE POINT. Without flow evidence, nothing is held -- it is unknown.
  // Reporting held-as-stake here is the confident wrong answer.
  if (input.flows_observed !== true) {
    notes.push(
      "stake-move and transfer streams not read for this window, so no " +
        "disposition can be attributed; this is unresolved, not held",
    );
    return {
      netuid: input.netuid,
      window_days,
      accrued_alpha: round9(accrued),
      buckets: { ...buckets, unresolved: round9(accrued) },
      residual_alpha: 0,
      reconciles: false,
      notes,
    };
  }

  // #10930: the two things a reader must not conclude from a populated
  // disposition, stated in the payload rather than left to the field names.
  // These ride on EVERY observed classification, because the row that gets
  // quoted is the one with numbers in it.
  notes.push(
    "`unstaked` means alpha left stake over this window. It does NOT mean " +
      "sold: on dTAO removing stake returns TAO through the subnet's own " +
      "pool, and this surface reports the movement, not an intent behind it",
  );
  notes.push(
    "scoped to the subnet's declared owner_coldkey only. An owner operating " +
      "several addresses would show less movement here than they made, and " +
      "resolving which other addresses are theirs is not done on this surface",
  );

  const unstaked = finite(input.unstaked_alpha) ?? 0;
  const transferred = finite(input.transferred_alpha) ?? 0;
  const burned = finite(input.burned_alpha) ?? 0;
  const held = finite(input.held_alpha);

  buckets.unstaked = round9(unstaked);
  buckets["transferred-out"] = round9(transferred);
  buckets.burned = round9(burned);

  if (held === null) {
    notes.push(
      "no standing stake balance read, so the held share is unresolved rather " +
        "than assumed",
    );
  } else {
    // A validator hotkey's stake is NOT only accrued owner cut -- it can also
    // be self-bonded validator capital, and `holders: 1` proves owner control
    // rather than origin (#10481). So the held figure is capped at what
    // actually accrued; the excess belongs to a different question.
    buckets["held-as-stake"] = round9(Math.min(held, accrued));
    if (held > accrued + DISPOSITION_TOLERANCE_ALPHA) {
      notes.push(
        "standing stake exceeds the window's accrual; the excess is not " +
          "attributed here, because a validator hotkey also holds self-bonded " +
          "capital and a balance cannot say which is which",
      );
    }
  }

  const accountedFor =
    (buckets["held-as-stake"] ?? 0) + unstaked + transferred + burned;
  const residual = accrued - accountedFor;
  // A NEGATIVE residual means the parts exceed the whole -- double counting, or
  // flows that include capital this accrual never contained. Reported, never
  // clamped: a clamp would hide the contradiction.
  if (residual > DISPOSITION_TOLERANCE_ALPHA) {
    buckets.unresolved = round9(residual);
    notes.push(
      "the accounted buckets do not cover the accrual; the remainder is " +
        "unresolved rather than assigned",
    );
  } else if (residual < -DISPOSITION_TOLERANCE_ALPHA) {
    buckets.unresolved = 0;
    notes.push(
      "the accounted buckets EXCEED the accrual, so at least one flow " +
        "includes capital this accrual did not contain; reported rather than " +
        "clamped",
    );
  } else {
    buckets.unresolved = 0;
  }

  return {
    netuid: input.netuid,
    window_days,
    accrued_alpha: round9(accrued),
    buckets,
    residual_alpha: round9(residual),
    reconciles: Math.abs(residual) <= DISPOSITION_TOLERANCE_ALPHA,
    notes,
  };
}

/**
 * The alpha legs of one subnet's stake flow for the owner address (#10930).
 *
 * PURE. Takes the grouped `(netuid, event_kind)` rows the stake-flow cold-tier
 * read already returns and picks the ONE subnet's alpha sums out of them —
 * there is no second flow reader here, because a second reader is a second
 * window, a second filter and a second chance to disagree.
 *
 * ALPHA, NOT TAO. `account_events` carries both units per row and the buckets
 * are alpha-denominated, so this reads `alpha_amount`. Pricing the TAO column
 * into an alpha bucket would put a reconstruction where the reconciliation
 * needs a reading, and the residual would then be an artefact of the price
 * rather than a statement about the owner.
 *
 * `observed: false` when the read returned nothing AT ALL — which is different
 * from a subnet whose owner moved nothing, and the caller must keep them
 * apart: the first resolves to `unresolved`, the second to a measured 0.
 */
export function ownerCutFlowLegs(
  rows: Array<Record<string, unknown>> | null | undefined,
  netuid: number,
): { observed: boolean; staked_alpha: number; unstaked_alpha: number } {
  if (!Array.isArray(rows)) {
    return { observed: false, staked_alpha: 0, unstaked_alpha: 0 };
  }
  let staked = 0;
  let unstaked = 0;
  for (const row of rows) {
    if (Number(row?.netuid) !== netuid) continue;
    const alpha = Number(row?.total_alpha);
    if (!Number.isFinite(alpha) || alpha < 0) continue;
    if (row?.event_kind === "StakeAdded") staked += alpha;
    else if (row?.event_kind === "StakeRemoved") unstaked += alpha;
  }
  // The READ happened even when this subnet has no rows in it — an owner who
  // moved nothing is a measurement, and reporting it as unread would leave a
  // real answer sitting in `unresolved` forever.
  return {
    observed: true,
    staked_alpha: round9(staked),
    unstaked_alpha: round9(unstaked),
  };
}
