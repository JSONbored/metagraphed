import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { PageHeading, Skeleton, StaleBanner } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { SectionHeading } from "@/components/metagraphed/section-heading";
import { StatTile } from "@/components/metagraphed/charts/stat-tile";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { chainConcentrationQuery, chainPerformanceQuery } from "@/lib/metagraphed/queries";
import { formatNumber, isStaleFreshness } from "@/lib/metagraphed/format";
import type { ConcentrationMetrics, ScoreDistribution } from "@/lib/metagraphed/types";

// #3471: a network-wide decentralization scorecard. The backend queries
// (chainConcentrationQuery / chainPerformanceQuery, wired in PR #3609) were
// unused by the UI; this route renders them as a StatTile grid mirroring the
// economics-panel idiom. Higher Nakamoto and lower Gini/HHI/top-share read as
// MORE decentralized, so the tiles below label and tone accordingly.

export const Route = createFileRoute("/network")({
  head: () => ({
    meta: [
      { title: "Network — Metagraphed" },
      {
        name: "description",
        content:
          "Network-wide decentralization scorecard: stake and emission concentration (Gini, HHI, Nakamoto, top-share) and the trust/consensus score spread across the Bittensor network.",
      },
      { property: "og:title", content: "Network — Metagraphed" },
      {
        property: "og:description",
        content:
          "Network-wide decentralization scorecard: stake/emission concentration and reward-distribution score spread.",
      },
    ],
  }),
  component: NetworkPage,
});

// A 0–1 share (top-x-pct share, entropy_normalized) rendered as a percentage.
function pct(v?: number | null): string {
  return v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(2)}%`;
}

// A 0–1 ratio (Gini, normalized HHI) or a 0–1 score, to 3 decimals.
function ratio(v?: number | null): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(3);
}

// Gini / normalized-HHI / Nakamoto / top-10% share for one distribution. A Gini
// at or above 0.8 is flagged as a concentration warning.
function ConcentrationTiles({ m }: { m: ConcentrationMetrics | null | undefined }) {
  const gini = m?.gini;
  const nakamoto = m?.nakamoto_coefficient;
  return (
    <>
      <StatTile
        eyebrow="Gini"
        tone={gini != null && gini >= 0.8 ? "warn" : "default"}
        value={ratio(gini)}
        hint={m?.holders != null ? `${formatNumber(m.holders)} holders` : undefined}
      />
      <StatTile eyebrow="HHI (norm.)" value={ratio(m?.hhi_normalized)} />
      <StatTile
        eyebrow="Nakamoto"
        tone="accent"
        value={nakamoto != null ? formatNumber(nakamoto) : "—"}
        hint="min entities to control >50%"
      />
      <StatTile
        eyebrow="Top 10% share"
        value={pct(m?.top_10pct_share)}
        hint={m?.entropy_normalized != null ? `entropy ${ratio(m.entropy_normalized)}` : undefined}
      />
    </>
  );
}

// Median (p50) of a 0–1 score column, with the p10–p90 spread as the hint.
function ScoreSpreadTile({
  eyebrow,
  d,
}: {
  eyebrow: string;
  d: ScoreDistribution | null | undefined;
}) {
  const median = d?.p50;
  const lo = d?.p10;
  const hi = d?.p90;
  const hint =
    lo != null && hi != null
      ? `p10–p90 ${ratio(lo)}–${ratio(hi)}`
      : d?.mean != null
        ? `mean ${ratio(d.mean)}`
        : undefined;
  return <StatTile eyebrow={eyebrow} value={ratio(median)} hint={hint} />;
}

function ConcentrationScorecard() {
  const { data: res } = useSuspenseQuery(chainConcentrationQuery());
  const c = res.data;
  const stale = isStaleFreshness(res.meta?.generated_at);
  return (
    <div className="space-y-4">
      {stale ? (
        <StaleBanner
          generatedAt={res.meta?.generated_at}
          refreshQueryKeys={[chainConcentrationQuery().queryKey]}
          refreshLabel="Refresh concentration"
        />
      ) : null}
      <div className="text-[11px] font-mono text-ink-muted">
        {formatNumber(c.subnet_count)} subnets · {formatNumber(c.neuron_count)} neurons ·{" "}
        {formatNumber(c.entity_count)} entities · captured{" "}
        <TimeAgo at={c.captured_at ?? undefined} />
      </div>
      <div>
        <div className="mg-label mb-2">Stake concentration</div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <ConcentrationTiles m={c.stake} />
        </div>
      </div>
      <div>
        <div className="mg-label mb-2">Emission concentration</div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <ConcentrationTiles m={c.emission} />
        </div>
      </div>
    </div>
  );
}

function PerformanceScorecard() {
  const { data: res } = useSuspenseQuery(chainPerformanceQuery());
  const p = res.data;
  return (
    <div className="space-y-4">
      <div>
        <div className="mg-label mb-2">Reward concentration</div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile eyebrow="Incentive Gini" value={ratio(p.incentive?.gini)} />
          <StatTile
            eyebrow="Incentive Nakamoto"
            tone="accent"
            value={
              p.incentive?.nakamoto_coefficient != null
                ? formatNumber(p.incentive.nakamoto_coefficient)
                : "—"
            }
          />
          <StatTile eyebrow="Dividends Gini" value={ratio(p.dividends?.gini)} />
          <StatTile
            eyebrow="Dividends Nakamoto"
            tone="accent"
            value={
              p.dividends?.nakamoto_coefficient != null
                ? formatNumber(p.dividends.nakamoto_coefficient)
                : "—"
            }
          />
        </div>
      </div>
      <div>
        <div className="mg-label mb-2">Score spread (median, p10–p90)</div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <ScoreSpreadTile eyebrow="Trust" d={p.trust} />
          <ScoreSpreadTile eyebrow="Consensus" d={p.consensus} />
          <ScoreSpreadTile eyebrow="Validator trust" d={p.validator_trust} />
          <StatTile
            eyebrow="Validators"
            value={formatNumber(p.validator_count)}
            hint={p.active_count != null ? `${formatNumber(p.active_count)} active` : undefined}
          />
        </div>
      </div>
    </div>
  );
}

function NetworkPage() {
  return (
    <AppShell>
      <PageHeading
        eyebrow="Network"
        title="Network decentralization"
        description="Network-wide concentration of stake and emission (Gini, HHI, Nakamoto, top-share) and the spread of on-chain trust/consensus scores. Derived from on-chain metagraph data — user submissions cannot affect these values."
      />
      <div className="space-y-section">
        <section>
          <SectionHeading
            title="Stake & emission concentration"
            intro="How concentrated stake and emission are across the network. Higher Nakamoto and lower Gini/HHI/top-share read as more decentralized."
          />
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-48 w-full" />}>
              <ConcentrationScorecard />
            </Suspense>
          </QueryErrorBoundary>
        </section>

        <section>
          <SectionHeading
            title="Reward distribution & score spread"
            intro="Concentration of incentive and dividends, plus the p10–p90 spread of trust, consensus, and validator-trust scores."
          />
          <QueryErrorBoundary>
            <Suspense fallback={<Skeleton className="h-48 w-full" />}>
              <PerformanceScorecard />
            </Suspense>
          </QueryErrorBoundary>
        </section>
      </div>
      <ApiSourceFooter paths={["/api/v1/chain/concentration", "/api/v1/chain/performance"]} />
    </AppShell>
  );
}
