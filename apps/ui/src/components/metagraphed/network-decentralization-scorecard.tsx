import { useQuery } from "@tanstack/react-query";
import { StatTile } from "@/components/metagraphed/charts/stat-tile";
import { chainConcentrationQuery, chainPerformanceQuery } from "@/lib/metagraphed/queries";
import {
  concentrationTone,
  decentralizationScore,
  fmtCount,
  fmtPct,
  fmtRatio,
  gradeFor,
  scoreSpread,
} from "@/lib/metagraphed/decentralization";

function Notice({ children }: { children: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 text-xs text-ink-muted">
      {children}
    </div>
  );
}

/**
 * #3471: a network-wide decentralization scorecard. Folds the stake/emission
 * concentration lenses (Gini / HHI / Nakamoto / top-share) from
 * /api/v1/chain/concentration and the trust/consensus score spread from
 * /api/v1/chain/performance into a single composite grade plus a StatTile grid.
 * Mirrors the economics-panel shape: its own loading / empty / error notices
 * rather than a Suspense fence, so a slow or absent performance snapshot never
 * blanks the concentration tiles.
 */
export function NetworkDecentralizationScorecard() {
  const concentration = useQuery(chainConcentrationQuery());
  const performance = useQuery(chainPerformanceQuery());

  if (concentration.isPending || performance.isPending) {
    return <Notice>Loading network decentralization metrics…</Notice>;
  }
  if (concentration.isError && performance.isError) {
    return <Notice>Network decentralization metrics are temporarily unavailable.</Notice>;
  }

  const c = concentration.data?.data;
  const p = performance.data?.data;
  const stake = c?.stake ?? null;
  const emission = c?.emission ?? null;

  if (!stake && !emission && !p?.trust && !p?.consensus) {
    return <Notice>No network decentralization data has been captured yet.</Notice>;
  }

  const score = decentralizationScore(stake, emission);
  const grade = score != null ? gradeFor(score) : null;
  const trustSpread = scoreSpread(p?.trust);

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        eyebrow="Decentralization"
        tone={grade?.tone ?? "default"}
        value={score != null ? String(score) : "—"}
        hint={grade ? `grade ${grade.letter} · 0–100` : "composite"}
      />
      <StatTile
        eyebrow="Stake Gini"
        tone={concentrationTone(stake?.gini)}
        value={fmtRatio(stake?.gini)}
        hint="0 even · 1 concentrated"
      />
      <StatTile
        eyebrow="Stake HHI"
        tone={concentrationTone(stake?.hhi_normalized)}
        value={fmtRatio(stake?.hhi_normalized)}
        hint="normalized"
      />
      <StatTile
        eyebrow="Nakamoto (stake)"
        value={fmtCount(stake?.nakamoto_coefficient)}
        hint="entities to 51%"
      />
      <StatTile
        eyebrow="Top-1% stake"
        tone={concentrationTone(stake?.top_1pct_share)}
        value={fmtPct(stake?.top_1pct_share)}
        hint="held by the top 1%"
      />
      <StatTile
        eyebrow="Emission Gini"
        tone={concentrationTone(emission?.gini)}
        value={fmtRatio(emission?.gini)}
        hint="reward balance"
      />
      <StatTile
        eyebrow="Nakamoto (emission)"
        value={fmtCount(emission?.nakamoto_coefficient)}
        hint="entities to 51%"
      />
      <StatTile
        eyebrow="Stake entropy"
        value={fmtRatio(stake?.entropy_normalized)}
        hint="normalized · 1 = uniform"
      />
      <StatTile
        eyebrow="Trust spread"
        value={trustSpread != null ? fmtRatio(trustSpread, 2) : "—"}
        hint={p?.trust?.mean != null ? `mean ${fmtRatio(p.trust.mean, 2)}` : "p90 − p10"}
      />
      <StatTile
        eyebrow="Consensus (mean)"
        value={fmtRatio(p?.consensus?.mean, 2)}
        hint="0–1 network consensus"
      />
      <StatTile
        eyebrow="Validators"
        value={fmtCount(p?.validator_count)}
        hint={c?.entity_count != null ? `${fmtCount(c.entity_count)} entities` : "in scope"}
      />
      <StatTile
        eyebrow="Neurons"
        value={fmtCount(c?.neuron_count)}
        hint={c?.subnet_count != null ? `${fmtCount(c.subnet_count)} subnets` : "network-wide"}
      />
    </div>
  );
}
