// #3471: pure view-model for the network-scope decentralization scorecard.
// Maps the normalized chain concentration (/api/v1/chain/concentration) and
// performance (/api/v1/chain/performance) snapshots — the chain-wide twin of
// the per-subnet concentration panel — into StatTile view-models with safe
// fallbacks for missing / null fields. Kept framework-free so it can be unit
// tested without React (Codecov gates coverage).

import type {
  ChainConcentration,
  ChainPerformance,
  ConcentrationMetrics,
  ScoreDistribution,
} from "@/lib/metagraphed/types";

/** KPI border/icon tone — concentration reads "worse" as it climbs. */
export type DecentralizationTone = "ok" | "warn" | "down" | "default";

export interface DecentralizationTile {
  /** Stable key for React lists, icon lookup, and tests. */
  key: string;
  /** Uppercase eyebrow shown on the StatTile. */
  label: string;
  /** Formatted display value ("—" when the source field is missing). */
  value: string;
  /** Optional secondary context line. */
  hint?: string;
  /** KPI tone; concentration climbing → warn/down, resilience → ok. */
  tone: DecentralizationTone;
}

export interface NetworkDecentralizationModel {
  /** True once at least one headline metric resolved to a real number. */
  hasData: boolean;
  /** Snapshot instant, preferring the concentration capture. */
  capturedAt: string | null;
  /** Stake / emission concentration tiles (Gini / HHI / Nakamoto / entropy / top-1%). */
  concentrationTiles: DecentralizationTile[];
  /** Trust / consensus / validator-trust score-spread tiles. */
  scoreTiles: DecentralizationTile[];
}

function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function numStr(v: number | null | undefined, digits = 3): string {
  const n = num(v);
  return n == null ? "—" : n.toFixed(digits);
}

function pctStr(v: number | null | undefined, digits = 1): string {
  const n = num(v);
  return n == null ? "—" : `${(n * 100).toFixed(digits)}%`;
}

function intStr(v: number | null | undefined): string {
  const n = num(v);
  return n == null ? "—" : String(Math.round(n));
}

// A higher Gini / HHI means more concentration (worse decentralization); a
// higher Nakamoto coefficient means more resilient; a higher normalized entropy
// (0-1) means a more even distribution. Map each to a tone so the KPI
// border/icon reads the right way.
function giniTone(v: number | null | undefined): DecentralizationTone {
  const n = num(v);
  if (n == null) return "default";
  if (n >= 0.85) return "down";
  if (n >= 0.6) return "warn";
  return "ok";
}

export function nakamotoTone(v: number | null | undefined): DecentralizationTone {
  const n = num(v);
  if (n == null) return "default";
  if (n <= 1) return "down";
  if (n <= 3) return "warn";
  return "ok";
}

function entropyTone(v: number | null | undefined): DecentralizationTone {
  const n = num(v);
  if (n == null) return "default";
  if (n >= 0.66) return "ok";
  if (n >= 0.33) return "warn";
  return "down";
}

function shareTone(v: number | null | undefined): DecentralizationTone {
  const n = num(v);
  if (n == null) return "default";
  if (n >= 0.5) return "down";
  if (n >= 0.25) return "warn";
  return "ok";
}

function concentrationTiles(
  stake: ConcentrationMetrics | null,
  emission: ConcentrationMetrics | null,
): DecentralizationTile[] {
  const emissionGini = num(emission?.gini);
  const stakeHhiNorm = num(stake?.hhi_normalized);
  const stakeEntropy = num(stake?.entropy);
  const stakeTop10 = num(stake?.top_10pct_share);
  const emissionNakamoto = num(emission?.nakamoto_coefficient);
  return [
    {
      key: "stake-gini",
      label: "Stake Gini",
      value: numStr(stake?.gini),
      hint: emissionGini == null ? undefined : `emission ${emissionGini.toFixed(3)}`,
      tone: giniTone(stake?.gini),
    },
    {
      key: "stake-hhi",
      label: "Stake HHI",
      value: numStr(stake?.hhi),
      hint: stakeHhiNorm == null ? undefined : `norm ${stakeHhiNorm.toFixed(3)}`,
      tone: giniTone(stake?.hhi),
    },
    {
      key: "stake-nakamoto",
      label: "Nakamoto",
      value: intStr(stake?.nakamoto_coefficient),
      hint: "entities to 51%",
      tone: nakamotoTone(stake?.nakamoto_coefficient),
    },
    {
      key: "stake-entropy",
      label: "Stake entropy",
      value: numStr(stake?.entropy_normalized),
      hint: stakeEntropy == null ? undefined : `${stakeEntropy.toFixed(2)} nats`,
      tone: entropyTone(stake?.entropy_normalized),
    },
    {
      key: "stake-top1",
      label: "Top 1% stake",
      value: pctStr(stake?.top_1pct_share),
      hint: stakeTop10 == null ? undefined : `top 10% ${(stakeTop10 * 100).toFixed(1)}%`,
      tone: shareTone(stake?.top_1pct_share),
    },
    {
      key: "emission-gini",
      label: "Emission Gini",
      value: numStr(emission?.gini),
      // Domain-prefix the emission Nakamoto coefficient so it doesn't read as a
      // second, conflicting value for the separate stake "Nakamoto" tile.
      hint:
        emissionNakamoto == null ? undefined : `emission Nakamoto ${Math.round(emissionNakamoto)}`,
      tone: giniTone(emission?.gini),
    },
  ];
}

function scoreTiles(
  trust: ScoreDistribution | null,
  consensus: ScoreDistribution | null,
  validatorTrust: ScoreDistribution | null,
): DecentralizationTile[] {
  const trustMean = num(trust?.mean);
  const consensusMean = num(consensus?.mean);
  const valTrustP90 = num(validatorTrust?.p90);
  return [
    {
      key: "trust-median",
      label: "Trust median",
      value: numStr(trust?.p50),
      hint: trustMean == null ? undefined : `mean ${trustMean.toFixed(3)}`,
      tone: "default",
    },
    {
      key: "consensus-median",
      label: "Consensus median",
      value: numStr(consensus?.p50),
      hint: consensusMean == null ? undefined : `mean ${consensusMean.toFixed(3)}`,
      tone: "default",
    },
    {
      key: "validator-trust-median",
      label: "Val-trust median",
      value: numStr(validatorTrust?.p50),
      hint: valTrustP90 == null ? undefined : `p90 ${valTrustP90.toFixed(3)}`,
      tone: "default",
    },
  ];
}

/**
 * Build the network decentralization scorecard view-model. Both inputs are
 * nullable-by-design (the queries reshape cold-store nulls into `null` metric
 * blocks); every field falls back to "—" so the tiles always render.
 */
export function networkDecentralizationModel(
  concentration: ChainConcentration | null | undefined,
  performance: ChainPerformance | null | undefined,
): NetworkDecentralizationModel {
  const stake = concentration?.stake ?? null;
  const emission = concentration?.emission ?? null;
  const trust = performance?.trust ?? null;
  const consensus = performance?.consensus ?? null;
  const validatorTrust = performance?.validator_trust ?? null;

  const hasData =
    num(stake?.gini) != null ||
    num(emission?.gini) != null ||
    num(trust?.p50) != null ||
    num(consensus?.p50) != null ||
    num(validatorTrust?.p50) != null;

  return {
    hasData,
    capturedAt: concentration?.captured_at ?? performance?.captured_at ?? null,
    concentrationTiles: concentrationTiles(stake, emission),
    scoreTiles: scoreTiles(trust, consensus, validatorTrust),
  };
}
