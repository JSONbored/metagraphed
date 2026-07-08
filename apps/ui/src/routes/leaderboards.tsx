import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { AppShell } from "@/components/metagraphed/app-shell";
import { PageHero } from "@/components/metagraphed/page-hero";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { Skeleton } from "@/components/metagraphed/states";
import { ShareButton } from "@/components/metagraphed/share-button";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { chainRegistrationsQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import type { ChainRegistrations } from "@/lib/metagraphed/types";

const leaderboardsSearchSchema = z.object({
  window: fallback(z.enum(["7d", "30d"]), "7d").default("7d"),
});

export const Route = createFileRoute("/leaderboards")({
  validateSearch: zodValidator(leaderboardsSearchSchema),
  head: () => ({
    meta: [
      { title: "Leaderboards — Metagraphed" },
      {
        name: "description",
        content:
          "Network-wide Bittensor leaderboards — the busiest subnets by registration activity, computed live from the chain-direct tiers.",
      },
      { property: "og:title", content: "Leaderboards — Metagraphed" },
    ],
  }),
  component: LeaderboardsPage,
});

function LeaderboardMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-sm tabular-nums text-ink-strong">{value}</div>
    </div>
  );
}

/**
 * Network-wide registrations leaderboard (#3465) — the busiest subnets by UID
 * registration activity over the window: distinct registrants, total
 * registrations, and the per-subnet breakdown. Chain-direct: GET
 * /api/v1/chain/registrations.
 */
function RegistrationsLeaderboard({ reg }: { reg: ChainRegistrations }) {
  const net = reg.network;
  const dist = reg.intensity_distribution;
  const rows = [...reg.subnets].sort((a, b) => b.registrations - a.registrations).slice(0, 12);
  const cap = Math.max(1, ...rows.map((s) => s.registrations));

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Registrations
        </h2>
        <span className="font-mono text-[11px] text-ink-muted">
          {formatNumber(reg.subnet_count)} subnets
        </span>
      </div>

      {net ? (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <LeaderboardMetric
            label="Distinct registrants"
            value={formatNumber(net.distinct_registrants)}
          />
          <LeaderboardMetric label="Registrations" value={formatNumber(net.registrations)} />
          <LeaderboardMetric
            label="Regs / registrant"
            value={net.registrations_per_registrant.toFixed(2)}
          />
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div>
          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            Busiest subnets
          </div>
          <ul className="space-y-1.5">
            {rows.map((s) => {
              const pct = Math.max(2, Math.round((s.registrations / cap) * 100));
              return (
                <li key={s.netuid}>
                  <Link
                    to="/subnets/$netuid"
                    params={{ netuid: s.netuid }}
                    className="grid w-full grid-cols-[3.5rem_1fr_6rem] items-center gap-2 text-left hover:opacity-80"
                  >
                    <span className="truncate font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                      SN{s.netuid}
                    </span>
                    <span className="relative h-1.5 overflow-hidden rounded-full bg-surface">
                      <span
                        className="absolute inset-y-0 left-0 rounded-full"
                        style={{ width: `${pct}%`, background: "var(--accent)" }}
                      />
                    </span>
                    <span className="text-right font-mono text-[10px] tabular-nums text-ink-strong">
                      {formatNumber(s.registrations)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="font-mono text-[12px] text-ink-muted">No registrations in this window yet.</p>
      )}

      {dist ? (
        <p className="mt-4 border-t border-border pt-3 font-mono text-[10px] text-ink-muted">
          Median {(dist.median ?? 0).toFixed(2)} registrations per registrant, up to{" "}
          {(dist.max ?? 0).toFixed(2)} in the most concentrated subnet, across{" "}
          {formatNumber(dist.count)} subnets.
        </p>
      ) : null}
    </section>
  );
}

function LeaderboardsDashboard() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const win = search.window;
  const reg = useSuspenseQuery(chainRegistrationsQuery(win)).data.data;

  return (
    <div className="space-y-10">
      <div className="flex items-center gap-2">
        {(["7d", "30d"] as const).map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => navigate({ search: { window: w } })}
            className={
              w === win
                ? "rounded-full border border-accent/40 bg-accent/10 px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-accent"
                : "rounded-full border border-border bg-card px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-ink-muted hover:border-ink/30"
            }
          >
            {w}
          </button>
        ))}
      </div>
      <RegistrationsLeaderboard reg={reg} />
    </div>
  );
}

function LeaderboardsPage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="Leaderboards"
        live
        title="Leaderboards"
        description="Network-wide Bittensor leaderboards — the busiest subnets by registration activity, computed live from the chain-direct tiers."
        actions={<ShareButton />}
      />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-[40rem] w-full" />}>
          <LeaderboardsDashboard />
        </Suspense>
      </QueryErrorBoundary>
      <ApiSourceFooter paths={["/api/v1/chain/registrations"]} />
    </AppShell>
  );
}
