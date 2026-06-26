import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { Activity, Boxes, Coins, Layers, Zap } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { PageHero } from "@/components/metagraphed/page-hero";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { Skeleton } from "@/components/metagraphed/states";
import { ShareButton } from "@/components/metagraphed/share-button";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { StatTile } from "@/components/metagraphed/charts/stat-tile";
import { Sparkline } from "@/components/metagraphed/charts/sparkline";
import { BarMini } from "@/components/metagraphed/charts/bar-mini";
import {
  chainActivityQuery,
  chainCallsQuery,
  chainFeesQuery,
  chainSignersQuery,
} from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";

const explorerSearchSchema = z.object({
  window: fallback(z.enum(["7d", "30d"]), "7d").default("7d"),
});

export const Route = createFileRoute("/explorer")({
  validateSearch: zodValidator(explorerSearchSchema),
  head: () => ({
    meta: [
      { title: "Chain explorer — Metagraphed" },
      {
        name: "description",
        content:
          "Bittensor network at a glance: daily extrinsic/block/event activity, fees, call mix, and the most active accounts — chain-direct analytics.",
      },
      { property: "og:title", content: "Chain explorer — Metagraphed" },
      {
        property: "og:description",
        content:
          "Bittensor network at a glance: daily activity, fees, call mix, and the most active accounts.",
      },
    ],
  }),
  component: ExplorerPage,
});

function sum(values: number[]): number {
  return values.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
}

function fmtTao(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M τ`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k τ`;
  if (v >= 1) return `${v.toFixed(2)} τ`;
  return `${v.toFixed(4)} τ`;
}

function ExplorerPage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="Explorer"
        live
        title="Chain explorer"
        description="The Bittensor network at a glance — daily activity, fees, call mix, and the most active accounts, computed live from the chain-direct tiers."
        actions={<ShareButton />}
      />
      <QueryErrorBoundary>
        <Suspense fallback={<Skeleton className="h-[40rem] w-full" />}>
          <ExplorerDashboard />
        </Suspense>
      </QueryErrorBoundary>
      <ApiSourceFooter
        paths={[
          "/api/v1/chain/activity",
          "/api/v1/chain/fees",
          "/api/v1/chain/calls",
          "/api/v1/chain/signers",
        ]}
      />
    </AppShell>
  );
}

const TH = "px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted";

function ExplorerDashboard() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const win = search.window;

  const activity = useSuspenseQuery(chainActivityQuery(win)).data.data;
  const fees = useSuspenseQuery(chainFeesQuery(win)).data.data;
  const calls = useSuspenseQuery(chainCallsQuery(win)).data.data;
  const signers = useSuspenseQuery(chainSignersQuery(win)).data.data;

  // The API returns newest-day-first; sparkline wants chronological order.
  const chrono = [...activity.days].reverse();
  const totalExtrinsics = sum(activity.days.map((d) => d.extrinsic_count));
  const totalBlocks = sum(activity.days.map((d) => d.block_count));
  const totalEvents = sum(activity.days.map((d) => d.event_count));
  const totalSuccessful = sum(activity.days.map((d) => d.successful_extrinsics));
  const successRate = totalExtrinsics > 0 ? totalSuccessful / totalExtrinsics : null;
  const totalFees = sum(fees.daily.map((d) => d.total_fee_tao));

  return (
    <div className="space-y-10">
      {/* window toggle */}
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

      {/* KPI tiles */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile
          icon={Zap}
          eyebrow="Extrinsics"
          value={formatNumber(totalExtrinsics)}
          hint={`${win} total`}
          tone="accent"
        />
        <StatTile
          icon={Boxes}
          eyebrow="Blocks"
          value={formatNumber(totalBlocks)}
          hint={`${win} total`}
        />
        <StatTile
          icon={Activity}
          eyebrow="Events"
          value={formatNumber(totalEvents)}
          hint={`${win} total`}
        />
        <StatTile icon={Coins} eyebrow="Fees" value={fmtTao(totalFees)} hint={`${win} total`} />
        <StatTile
          icon={Layers}
          eyebrow="Success rate"
          value={successRate == null ? "—" : `${(successRate * 100).toFixed(2)}%`}
          hint="successful / total"
        />
      </div>

      {/* daily activity sparkline */}
      <section className="rounded-lg border border-border bg-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
            Daily extrinsics
          </h2>
          <span className="font-mono text-[11px] text-ink-muted">{activity.day_count} days</span>
        </div>
        {chrono.length > 0 ? (
          <Sparkline
            values={chrono.map((d) => d.extrinsic_count)}
            width={640}
            height={64}
            ariaLabel="Daily extrinsic count"
            formatValue={(v) => formatNumber(v)}
          />
        ) : (
          <p className="font-mono text-[12px] text-ink-muted">
            No activity indexed yet — the chain poller fills this every few minutes.
          </p>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* call mix */}
        <section className="rounded-lg border border-border bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
              Call mix
            </h2>
            <span className="font-mono text-[11px] text-ink-muted">
              {formatNumber(calls.total_extrinsics)} calls
            </span>
          </div>
          {calls.calls.length > 0 ? (
            <BarMini
              data={calls.calls.slice(0, 10).map((c) => ({
                label: c.call_module,
                value: c.count,
              }))}
            />
          ) : (
            <p className="font-mono text-[12px] text-ink-muted">No calls yet.</p>
          )}
        </section>

        {/* top signers */}
        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
            Most active accounts
          </h2>
          {signers.signers.length > 0 ? (
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className={TH}>Account</th>
                  <th className={`${TH} text-right`}>Txs</th>
                  <th className={`${TH} text-right`}>Fees</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {signers.signers.slice(0, 12).map((s) => (
                  <tr key={s.signer} className="hover:bg-surface/40">
                    <td className="px-4 py-2 font-mono text-[11px]">
                      <Link
                        to="/accounts/$ss58"
                        params={{ ss58: s.signer }}
                        className="text-ink-strong hover:text-accent hover:underline"
                        title={s.signer}
                      >
                        {shortHash(s.signer)}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink">
                      {formatNumber(s.tx_count)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                      {fmtTao(s.total_fee_tao)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="font-mono text-[12px] text-ink-muted">No signers in this window yet.</p>
          )}
        </section>
      </div>
    </div>
  );
}
