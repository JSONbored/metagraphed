// #8749: replay the v440 emission pipeline from captured inputs.
//
// Pure — no I/O, no chain, no database. Read from
// pallets/subtensor/src/coinbase/subnet_emissions.rs at tag v440 and checked
// stage by stage against live finney, so this is a transcription of the
// runtime's arithmetic rather than a model of it.
//
// THIS IS THE RECONSTRUCTION ADR 0023 DECISION 3 GATES ON. Direct storage
// reads are measurements; everything below is OUR ARITHMETIC over them. The
// ADR's rule is that a reconstructed field ships only while a harness holds it
// against live chain state, which is what tests/emission-pipeline.test.ts
// does with a captured fixture.
//
// THETA IS READ, NEVER RECOMPUTED. `apply_emission_gate` uses
// `EmissionGateBar::get()` — the stored value — and only
// `maybe_update_emission_gate_bar` writes it, on the 360-block boundary. A
// replay that recomputed the bar would be gating with a number the chain was
// not using for 359 blocks out of 360. recomputeEmissionGateBar exists below
// so a monitor can WATCH the two diverge, not so the replay can substitute one
// for the other.
//
// WHY THE TOLERANCE IS 2e-4 AND NOT 1e-7. Measured against live finney with
// every stage exact and theta read from storage: mean per-subnet share error
// 1.1e-5, max 1.4e-4. The residual is not in this file — it is the gap between
// stage 6 (what this reconstructs) and the stage 7/8 storage items it is
// compared against, which are cap-limited and reservoir-smoothed per block.
// The AGGREGATE identity is unaffected and holds to ~1e-7. See #8749.

/** Blocks between gate-bar recomputations. `EMISSION_BAR_UPDATE_INTERVAL`. */
export const EMISSION_BAR_UPDATE_INTERVAL = 360;

/** `EmissionGateExponent` unset means the runtime default h = 3, not 0. */
export const DEFAULT_EMISSION_GATE_EXPONENT = 3;

/** One subnet's captured stage-0..2 inputs. */
export interface SubnetPipelineInput {
  netuid: number;
  /** `SubnetMovingPrice` (I64F64). Stage 1's input. */
  moving_price: number;
  /** `MinerBurned` as a fraction in [0, 1] (U96F32). Stage 2. */
  miner_burned: number;
  /** Decoded `SubnetEmissionEnabled` — absent storage means TRUE. Stage 5. */
  emission_enabled: boolean;
  /** `FirstEmissionBlockNumber`; null means never emitted. Stage 0. */
  first_emission_block: number | null;
  /** `SubtokenEnabled`. Stage 0. */
  subtoken_enabled: boolean;
  /** `NetworkRegistrationAllowed`. Stage 0. */
  registration_allowed: boolean;
}

export interface PipelineParameters {
  /** `EmissionGateBar` AS STORED. Never recomputed here — see the header. */
  theta: number;
  /** `EmissionGateExponent`, or DEFAULT_EMISSION_GATE_EXPONENT when unset. */
  exponent: number;
}

/** Why a subnet took no part in stage 1. */
export type IneligibleReason =
  "root" | "never_emitted" | "subtoken_disabled" | "registration_closed";

export interface SubnetPipelineStages {
  netuid: number;
  /** Null when ineligible — a subnet outside stage 0 has no share at all. */
  ineligible_reason: IneligibleReason | null;
  /** Stage 1: `SubnetMovingPrice_i / Σ SubnetMovingPrice`. */
  price_share: number | null;
  miner_burned: number;
  /** Stage 2: `price_share · (1 − miner_burned)`, renormalized. */
  weighted_share: number | null;
  /** Stage 4: post-gate, post-renormalization. */
  gated_share: number | null;
  emission_enabled: boolean;
  /** Stage 5: zeroed and redistributed when disabled. */
  final_share: number | null;
  /** `gated_share − weighted_share`: what the gate gave or took. */
  gate_delta: number | null;
  /**
   * `weighted_share / theta`. Measured against the WEIGHTED share, not the
   * price share: theta is computed over the weighted distribution, so
   * comparing stage 1 to it answers a question the gate does not ask
   * (ADR 0023 decision 3).
   */
  distance_to_bar: number | null;
}

export interface PipelineReconstruction {
  subnets: SubnetPipelineStages[];
  /** Subnets that cleared stage 0. */
  eligible_count: number;
  /** Of those, the ones with emission explicitly disabled. */
  disabled_count: number;
}

/** A finite, strictly positive number — anything else is not a share. */
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Stage 0, exactly `get_subnets_to_emit_to`. Order of checks is ours. */
function ineligibleReason(
  subnet: SubnetPipelineInput,
): IneligibleReason | null {
  if (subnet.netuid === 0) return "root";
  if (subnet.first_emission_block === null) return "never_emitted";
  if (!subnet.subtoken_enabled) return "subtoken_disabled";
  if (!subnet.registration_allowed) return "registration_closed";
  return null;
}

/**
 * The Hill gate: `1/(1+(θ/s)^h)`.
 *
 * Written as the runtime writes it — over the ratio θ/s rather than as
 * `s^h/(s^h+θ^h)` — because the two are algebraically identical and only the
 * first stays well-conditioned for deep-tail shares, where `s^h` underflows.
 * Passes exactly 1/2 at the bar.
 */
export function emissionGate(
  share: number,
  theta: number,
  exponent: number,
): number {
  if (!positive(share)) return 0;
  // A zero or absent bar disables the gate outright, matching
  // apply_emission_gate's own `if theta <= zero { return; }`.
  if (!positive(theta)) return 1;
  return 1 / (1 + Math.pow(theta / share, exponent));
}

/**
 * What `maybe_update_emission_gate_bar` WOULD write for this distribution.
 *
 * Sort descending, accumulate, and take the share at which the running total
 * first reaches q. Provided for drift detection only — the replay reads the
 * stored bar, because that is what the chain gates with between recomputes.
 *
 * The result is quantized to an observed share, so it moves in steps: near the
 * bar the candidates sit 0.076%-0.66% apart on live data, and a bar recomputed
 * one block later can land on a neighbouring subnet entirely.
 */
export function recomputeEmissionGateBar(
  weightedShares: readonly number[],
  quantile: number,
): number | null {
  const sorted = [...weightedShares]
    .filter((share) => positive(share))
    .sort((a, b) => b - a);
  if (sorted.length === 0) return null;
  let cumulative = 0;
  // Seeded from the first entry rather than 0 so there is no "no bar found"
  // case to invent a null for: every entry survived the `positive` filter, so
  // whichever one the loop stops on is a real, positive share.
  let theta = sorted[0];
  for (const share of sorted) {
    cumulative += share;
    theta = share;
    if (cumulative >= quantile) break;
  }
  return theta;
}

/**
 * Replay stages 0-5 and return every intermediate.
 *
 * The intermediates are the point: #8744 publishes the decomposition, so each
 * stage has to be individually inspectable rather than collapsed into a final
 * number nobody can check.
 */
export function reconstructEmissionPipeline(input: {
  subnets: readonly SubnetPipelineInput[];
  parameters: PipelineParameters;
}): PipelineReconstruction {
  const { theta, exponent } = input.parameters;
  const rows: SubnetPipelineStages[] = [];
  // Eligible rows are carried in a NON-NULLABLE working shape and projected
  // into the public one at the end. Mutating the nullable row stage by stage
  // needs a `?? 0` at every read, and each of those is a branch that can never
  // be taken -- unreachable code masquerading as defensiveness.
  const eligible: {
    row: SubnetPipelineStages;
    price: number;
    burned: number;
    weighted: number;
    gated: number;
  }[] = [];

  for (const subnet of input.subnets) {
    const reason = ineligibleReason(subnet);
    const row: SubnetPipelineStages = {
      netuid: subnet.netuid,
      ineligible_reason: reason,
      price_share: null,
      // Capped at 1 the way the runtime caps it: a value above 1 would make
      // (1 - burned) negative and hand the subnet a negative weight.
      miner_burned: positive(subnet.miner_burned)
        ? Math.min(1, subnet.miner_burned)
        : 0,
      weighted_share: null,
      gated_share: null,
      emission_enabled: subnet.emission_enabled,
      final_share: null,
      gate_delta: null,
      distance_to_bar: null,
    };
    rows.push(row);
    if (reason === null) {
      eligible.push({
        row,
        price: positive(subnet.moving_price) ? subnet.moving_price : 0,
        burned: row.miner_burned,
        weighted: 0,
        gated: 0,
      });
    }
  }

  // Stage 1.
  const totalPrice = eligible.reduce((sum, e) => sum + e.price, 0);
  for (const e of eligible) {
    e.price = totalPrice > 0 ? e.price / totalPrice : 0;
    e.row.price_share = e.price;
  }

  // Stage 2. The runtime falls back to the UNWEIGHTED price shares when the
  // weighted total zeroes out, rather than stranding the block's emission.
  const totalWeight = eligible.reduce(
    (sum, e) => sum + e.price * (1 - e.burned),
    0,
  );
  for (const e of eligible) {
    e.weighted =
      totalWeight > 0 ? (e.price * (1 - e.burned)) / totalWeight : e.price;
    e.row.weighted_share = e.weighted;
  }

  // Stage 4.
  const totalGated = eligible.reduce(
    (sum, e) => sum + e.weighted * emissionGate(e.weighted, theta, exponent),
    0,
  );
  for (const e of eligible) {
    const gated = e.weighted * emissionGate(e.weighted, theta, exponent);
    // When every gated share underflows to zero the runtime restores the
    // ungated shares so the block's emission cannot be stranded.
    e.gated = totalGated > 0 ? gated / totalGated : e.weighted;
    e.row.gated_share = e.gated;
    e.row.gate_delta = e.gated - e.weighted;
    e.row.distance_to_bar = positive(theta) ? e.weighted / theta : null;
  }

  // Stage 5: disabled subnets are zeroed and their share redistributed.
  const totalEnabled = eligible.reduce(
    (sum, e) => sum + (e.row.emission_enabled ? e.gated : 0),
    0,
  );
  for (const e of eligible) {
    const enabled = e.row.emission_enabled ? e.gated : 0;
    e.row.final_share = totalEnabled > 0 ? enabled / totalEnabled : 0;
  }

  return {
    subnets: rows,
    eligible_count: eligible.length,
    disabled_count: eligible.filter((e) => !e.row.emission_enabled).length,
  };
}

// --- Identity checks (#8749) ----------------------------------------------
//
// Four invariants that hold today, are cheap to evaluate, and fail loudly on
// every failure mode that matters: a broken capture, a runtime upgrade that
// changed the pipeline, or the dormant TAO-flow path being switched on
// (#8750). They run BOTH in CI against a fixture and in production against
// live state, from this one implementation, so the monitor cannot drift from
// the test.

/** The tolerance the aggregate identity is checked at. */
export const AGGREGATE_IDENTITY_TOLERANCE_RAO = 1_000n;

/**
 * Per-subnet share tolerance. MEASURED, not chosen.
 *
 * Against live finney with every stage exact and theta read from storage:
 * mean 1.1e-5, max 1.4e-4. The residual is the gap between stage 6 and the
 * stage 7/8 storage items it is compared against, which are cap-limited and
 * reservoir-smoothed per block. 2e-4 clears the observed maximum with a little
 * room and still catches a structural regression, every one of which moved the
 * error by at least 30x when tested.
 */
export const SUBNET_SHARE_TOLERANCE = 2e-4;

export interface IdentityCheck {
  name: string;
  ok: boolean;
  /** Human-readable detail, populated whether or not the check passed. */
  detail: string;
}

export interface IdentityInput {
  subnets: readonly {
    netuid: number;
    emission_enabled: boolean;
    tao_in_emission_rao: bigint;
    excess_tao_rao: bigint;
  }[];
  reconstruction: PipelineReconstruction;
  blockEmissionRao: bigint;
  quantile: number;
}

/**
 * Evaluate all four. Returns every check, passing or failing — a monitor that
 * only reported failures could not distinguish "all clear" from "did not run".
 */
export function emissionIdentityChecks(input: IdentityInput): IdentityCheck[] {
  const checks: IdentityCheck[] = [];

  // 1. The strongest single signal in the system: two aggregates and a
  //    comparison. Fails on a missing capture, a halving boundary, or a
  //    pipeline change.
  const totalTao = input.subnets.reduce(
    (sum, s) => sum + s.tao_in_emission_rao + s.excess_tao_rao,
    0n,
  );
  const delta = totalTao - input.blockEmissionRao;
  const absDelta = delta < 0n ? -delta : delta;
  checks.push({
    name: "sum_tao_channels_equals_block_emission",
    ok: absDelta <= AGGREGATE_IDENTITY_TOLERANCE_RAO,
    detail: `Σ(tao_in + excess) = ${totalTao} rao vs block emission ${input.blockEmissionRao} rao (Δ ${delta} rao, tolerance ±${AGGREGATE_IDENTITY_TOLERANCE_RAO})`,
  });

  // 2. Stage 5 renormalizes over enabled subnets, so this is 1 by
  //    construction unless the reconstruction itself is broken.
  const shareSum = input.reconstruction.subnets.reduce(
    (sum, s) => sum + (s.final_share ?? 0),
    0,
  );
  checks.push({
    name: "final_shares_sum_to_one",
    ok: Math.abs(shareSum - 1) <= 1e-9,
    detail: `Σ final_share = ${shareSum.toFixed(12)} over ${input.reconstruction.eligible_count} eligible subnets`,
  });

  // 3. q was raised from its 0.61 default to 0.75 after the v440 deploy. A
  //    move away from 0.75 reshapes the gate for every subnet at once and is
  //    exactly the governance action nothing else would surface.
  checks.push({
    name: "emission_bar_quantile_is_three_quarters",
    ok: Math.abs(input.quantile - 0.75) <= 1e-12,
    detail: `EmissionBarQuantile = ${input.quantile}`,
  });

  // 4. Disabled means disabled. A non-zero channel on a disabled subnet means
  //    either our decode inverted (absent storage means ENABLED, so this is a
  //    real trap) or the runtime stopped honouring the flag.
  const leaking = input.subnets.filter(
    (s) =>
      !s.emission_enabled &&
      (s.tao_in_emission_rao > 0n || s.excess_tao_rao > 0n),
  );
  const disabled = input.subnets.filter((s) => !s.emission_enabled).length;
  checks.push({
    name: "disabled_subnets_receive_nothing",
    ok: leaking.length === 0,
    detail:
      leaking.length === 0
        ? `all ${disabled} emission-disabled subnets are zero on both TAO channels`
        : `${leaking.length} disabled subnet(s) received TAO: ${leaking
            .map((s) => `netuid ${s.netuid}`)
            .join(", ")}`,
  });

  return checks;
}
