# ADR 0023 — v440 emission pipeline: what we publish, what `emission_share` means, and the reconstruction rule

- **Status:** Proposed
- **Date:** 2026-07-30
- **Relates to:** #8741 (this ADR), #8739 (the epic it scopes), #8740 (the source
  reading and live reconstruction every number here rests on), #8746
  (`emission_share` disambiguation), #8744 (the API surface), #8749
  (reconstruction harness), #8750 (dormant TAO-flow monitor), ADR 0022 (the
  cost shapes any AI-assisted work here must respect).

## Context

Runtime spec 440 (live on finney since 2026-07-27) added a Hill emission gate to
the subnet emission pipeline. #8740 read the pipeline from
`pallets/subtensor/src/coinbase/` at tag `v440` and reproduced it against live
chain state to a mean share error of 4.3e-8.

Two facts from that work drive everything below.

**The gate redistributes; it does not withhold.** Stage 4 renormalizes gated
shares to sum to 1 — the source is explicit:
`e_i = gate(s_i) * s_i / sum(gate(s_j) * s_j)`. Aggregate TAO to subnets is
untouched. The epic was originally filed on the opposite premise, and that
premise was wrong.

**A field we already publish now means something five stages upstream of what
its name suggests.** `emission_share` = `alpha_price / Σ alpha_price`
(`scripts/lib/economics-artifacts.ts:186`) is _stage 1_ — the gate's raw input,
before `MinerBurned` weighting, before the gate, before the enabled filter. It
is the default sort on `/api/v1/economics`, summed into `total_emission_share`,
exported as `mean_emission_share` on `/economics/trends`, and rendered in three
UI surfaces.

We are about to publish the full decomposition beside it. The posture has to be
recorded before either the new fields or the corrections to the old ones land —
the same sequencing #8598 used for the first-party TAO/USD index.

## Decision

### 1. `emission_share` keeps its name and its meaning, and gains an explicit label

Renaming a field that ships in REST, GraphQL, MCP, CSV exports, and the
generated client is a breaking change for every consumer — to fix what is a
_description_ problem, not a data problem. The value is correct; it is stage 1
of a pipeline, computed exactly as documented.

Instead: annotate it everywhere as the stage-1 price share, and publish the
downstream values beside it. Additive, not breaking. Implementation is #8746.

This is recorded here so it is not relitigated each time someone notices the
name reads like a final share.

### 2. Field names, units, and null semantics, fixed now

Once these ship on three surfaces they are permanent. Fixed here:

| Field                | Meaning                                                                                                                                | Unit                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `emission_share`     | Stage 1. Price-EMA share, `SubnetMovingPrice_i / Σ SubnetMovingPrice`. **Unchanged.**                                                  | fraction, sums to 1 |
| `weighted_share`     | Stage 2. `emission_share · (1 − MinerBurned_i)`, renormalized.                                                                         | fraction, sums to 1 |
| `gated_share`        | Stage 4. Post-Hill-gate, renormalized.                                                                                                 | fraction, sums to 1 |
| `final_share`        | Stage 5. After `SubnetEmissionEnabled` zeroing and redistribution. **This is the share of block emission a subnet actually receives.** | fraction, sums to 1 |
| `tao_emission`       | Stage 6. `block_emission · final_share`.                                                                                               | TAO per block       |
| `tao_in_emission`    | Stage 8. The price-active part written to `SubnetTaoInEmission` — pool liquidity injection.                                            | TAO per block       |
| `excess_tao`         | Stage 7 remainder — TAO spent buying alpha on the subnet's own pool.                                                                   | TAO per block       |
| `liquidity_fraction` | `tao_in_emission / tao_emission`. The split that nobody publishes.                                                                     | fraction, 0–1       |
| `miner_burned`       | `MinerBurned_i`, decoded from **U96F32** (÷ 2^32).                                                                                     | fraction, 0–1       |

`tao_in_emission + excess_tao == tao_emission` per subnet, and the sum over
subnets equals block emission exactly. A surface that does not satisfy that
identity is broken and should fail its own test rather than ship.

**`alpha_in` and `alpha_out` are never conflated in a field name.**
`SubnetAlphaInEmission` is alpha to the _pool_ (Σ ≈ 9.42/block);
`SubnetAlphaOutEmission` is alpha to _participants_ (Σ ≈ 127.0/block). They
differ by more than 10×, and pool-ratio math needs `alpha_in`. Any field
carrying either must say which in its name.

### 3. Reconstructed values ship only while a test holds them against the chain

The decomposition is _our arithmetic_, not a value the chain publishes. Direct
storage reads (`tao_in_emission`, `excess_tao`, the gate parameters,
`MinerBurned`) are measurements. Everything derived from them — `weighted_share`,
`gated_share`, `final_share`, `tao_emission`, `liquidity_fraction` — is a
reconstruction.

The rule, binding on #8744:

- Every reconstructed field is **labelled as reconstructed** in the contract, not
  only in prose a client may never read.
- A reconstructed field ships **only while #8749's harness holds it against live
  chain state**. If the harness goes red, the surface reports the drift rather
  than continuing to serve a number it can no longer defend.
- Distance-to-bar is in scope (#8740 resolved the open question), measured
  against the **post-`MinerBurned` weighted share**, not the raw price share.
  Measuring it against stage 1 would answer a question the gate does not ask.

### 4. We do not claim emission is throttled

The corrected finding is counterintuitive enough that it will be re-derived
incorrectly by others — it already was, by us, in this epic's original framing.
Recorded plainly:

- The gate **renormalizes to sum 1**. 100.00% of block emission reaches subnets.
- The visible drop in `SubnetTaoInEmission` is **not** the gate. It is the
  stage-7 alpha injection cap routing TAO into chain buys (measured at block
  8,736,990: 33.3% pool injection, 66.7% chain buys, 0.500000 TAO/block
  combined), plus a first halving that has already happened.
- Block emission is **0.5 TAO/block**, derived from `TotalIssuance`. The
  `BlockEmission` storage item reads 1.0 and is **stale** — anyone deriving
  percentages from it is off by 2×. We derive from issuance every block (#8747).

No surface we publish may describe the gate as withholding, capping, or
throttling TAO to subnets in aggregate.

### 5. Provenance is a contract, not a nice-to-have

Every published gate value carries **the block height and the storage key that
produced it**. An outside reader must be able to re-derive any number we publish
against a public endpoint without asking us what we did.

This is what makes the reconstruction rule in decision 3 checkable by someone who
does not trust us, which is the only kind of checkable that matters for a
number this consequential.

### 6. Zero is a measurement; absent is a different thing

54 subnets currently read exactly `0` for `SubnetTaoInEmission`. **47 of those
are `SubnetEmissionEnabled = false`** — an explicit off switch, a materially
different state from "gated to near-zero".

- `0` is rendered as `0`, never as missing data, and never dropped from a list.
- `SubnetEmissionEnabled` defaults to **true**: absent ≠ disabled. Code that
  treats a missing key as disabled is wrong.
- Netuid 0 is root and is excluded from the pipeline entirely
  (`get_subnets_to_emit_to`), so it is excluded from these surfaces rather than
  shown as zero.

### 7. What we will not say

We publish what the chain injected, and the arithmetic that connects it to the
inputs. We do **not** forecast parameter changes, do **not** recommend action,
and do **not** characterise any subnet's prospects. A reader deciding what to do
with this data is doing their own work, not following ours.

## Consequences

- **#8746 becomes additive and safe.** No consumer breaks; `emission_share` keeps
  working and gains a label plus siblings.
- **#8744 inherits a hard gate.** It cannot ship a reconstructed field without
  #8749 holding it, which makes #8749 a prerequisite rather than a follow-up.
- **The identity in decision 2 is testable**, so "the decomposition is wrong"
  becomes a failing test rather than a reader's discovery.
- **A dormant switch can invalidate all of this at once.** `get_shares_flow`
  (TAO-flow EMA) exists in v440 but is `#[allow(dead_code)]` and unwired, while
  `SubnetTaoFlow` is written on all 128 subnets and `SubnetEmaTaoFlow` is frozen
  at block 8,466,530 — the signature of a path that ran and was switched off. If
  it is switched on, the gate's input changes from price to demand flow and every
  figure here moves simultaneously. #8750 monitors exactly this, and it is load-
  bearing for this ADR, not a peripheral nicety.
- **The reconstruction is pinned to v440.** A future runtime that changes the
  pipeline invalidates the decomposition, not just the numbers. #8749's harness
  is what turns that into a visible failure rather than silently wrong output.

## Open questions

- **Capture cadence for pipeline inputs (#8743).** `SubnetTaoInEmission` is
  per-block, reservoir-smoothed and cap-limited, so a single sample is not a
  stable measure. Whether we publish per-block values, a rolling mean, or both is
  not settled here.
- **Whether `liquidity_fraction` needs a trailing window** to be useful, for the
  same smoothing reason.
- **Retention** for captured pipeline inputs is deferred to #8743, where the row
  shapes are known.

## Links/resources

- #8740 — source reading and live reconstruction (4.3e-8 mean share error)
- `pallets/subtensor/src/coinbase/{subnet_emissions,run_coinbase,block_emission}.rs` at `v440`
- Live parameters at time of writing: `θ = 0.008989`, `q = 0.75`, `h = 3`
  (`EmissionGateExponent` unset → runtime default 3, **not** 0; `h = 0` yields
  `gate = 0.5` for everything)
- `scripts/lib/economics-artifacts.ts:186` — the current `emission_share`
- `src/domain-summary.ts:116` — `total_emission_share`
