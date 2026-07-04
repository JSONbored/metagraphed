import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useState } from "react";
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
import type { ChainCalls } from "@/lib/metagraphed/types";

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

/**
 * One labeled mini-sparkline cell for a daily series. Aligns `days` labels to
 * `values` so the hover tooltip shows the day, and surfaces the latest value
 * as a compact caption.
 */
function MiniSeries({
  label,
  days,
  values,
  color,
  formatValue,
}: {
  label: string;
  days: string[];
  values: number[];
  color: string;
  formatValue: (v: number) => string;
}) {
  const latest = values.length > 0 ? values[values.length - 1]! : null;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          {label}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-ink-strong">
          {latest == null ? "—" : formatValue(latest)}
        </span>
      </div>
      <Sparkline
        values={values}
        points={values.map((v, i) => ({ t: days[i] ?? "", v }))}
        width={320}
        height={48}
        color={color}
        ariaLabel={`Daily ${label.toLowerCase()}`}
        formatValue={formatValue}
      />
    </div>
  );
}

/**
 * Call mix — the top modules as a BarMini, plus a click-through drill-down into
 * the selected module's call_function rows (where the grouping exposes them).
 */
function CallMixSection({ calls }: { calls: ChainCalls }) {
  const modules = calls.calls.slice(0, 10);
  const [selected, setSelected] = useState<string | null>(null);
  // Function-level rows exist only when the aggregate is grouped by function;
  // at module grouping call_function is null, so this stays empty until then.
  const functions = calls.calls.filter(
    (c) => c.call_function != null && (selected == null || c.call_module === selected),
  );

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Call mix
        </h2>
        <span className="font-mono text-[11px] text-ink-muted">
          {formatNumber(calls.total_extrinsics)} calls
        </span>
      </div>
      {modules.length > 0 ? (
        <div className="space-y-4">
          <ul className="space-y-1.5">
            {modules.map((c) => {
              const cap = Math.max(1, ...modules.map((m) => m.count));
              const pct = Math.max(2, Math.round((c.count / cap) * 100));
              const active = selected === c.call_module;
              return (
                <li key={c.call_module}>
                  <button
                    type="button"
                    onClick={() => setSelected(active ? null : c.call_module)}
                    className="grid w-full grid-cols-[7rem_1fr_auto] items-center gap-2 text-left"
                    aria-pressed={active}
                  >
                    <span
                      className={
                        active
                          ? "truncate font-mono text-[10px] uppercase tracking-widest text-accent"
                          : "truncate font-mono text-[10px] uppercase tracking-widest text-ink-muted"
                      }
                    >
                      {c.call_module}
                    </span>
                    <span className="relative h-1.5 overflow-hidden rounded-full bg-surface">
                      <span
                        className="absolute inset-y-0 left-0 rounded-full"
                        style={{
                          width: `${pct}%`,
                          background: active ? "var(--accent)" : "var(--chart-1)",
                        }}
                      />
                    </span>
                    <span className="font-mono text-[10px] tabular-nums text-ink-strong">
                      {formatNumber(c.count)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {functions.length > 0 ? (
            <div className="border-t border-border pt-3">
              <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
                {selected ? `${selected} functions` : "Function breakdown"}
              </div>
              <BarMini
                data={functions.slice(0, 10).map((c) => ({
                  label: c.call_function ?? c.call_module,
                  value: c.count,
                }))}
              />
            </div>
          ) : (
            <p className="border-t border-border pt-3 font-mono text-[11px] text-ink-muted">
              {selected
                ? "No per-function breakdown for this module at the current grouping."
                : "Tap a module to drill into its functions (function rows appear when the chain-calls aggregate is grouped by function)."}
            </p>
          )}
        </div>
      ) : (
        <p className="font-mono text-[12px] text-ink-muted">No calls yet.</p>
      )}
    </section>
  );
}

function ExplorerDashboard() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const win = search.window;

  const activity = useSuspenseQuery(chainActivityQuery(win)).data.data;
  const fees = useSuspenseQuery(chainFeesQuery(win)).data.data;
  const calls = useSuspenseQuery(chainCallsQuery(win)).data.data;
  const signers = useSuspenseQuery(chainSignersQuery(win)).data.data;

  // The API returns newest-day-first; sparklines want chronological order.
  const chrono = [...activity.days].reverse();
  const feeChrono = [...fees.daily].reverse();
  const totalExtrinsics = sum(activity.days.map((d) => d.extrinsic_count));
  const totalBlocks = sum(activity.days.map((d) => d.block_count));
  const totalEvents = sum(activity.days.map((d) => d.event_count));
  const totalSuccessful = sum(activity.days.map((d) => d.successful_extrinsics));
  const successRate = totalExtrinsics > 0 ? totalSuccessful / totalExtrinsics : null;
  const totalFees = sum(fees.daily.map((d) => d.total_fee_tao));
  const totalTips = sum(fees.daily.map((d) => d.total_tip_tao));

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
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
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
          icon={Coins}
          eyebrow="Tips"
          value={fmtTao(totalTips)}
          hint={`${win} total`}
          tone={totalTips > 0 ? "ok" : "default"}
        />
        <StatTile
          icon={Layers}
          eyebrow="Success rate"
          value={successRate == null ? "—" : `${(successRate * 100).toFixed(2)}%`}
          hint="successful / total"
        />
      </div>

      {/* daily activity series */}
      <section className="rounded-lg border border-border bg-card p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
            Daily activity
          </h2>
          <span className="font-mono text-[11px] text-ink-muted">{activity.day_count} days</span>
        </div>
        {chrono.length > 0 ? (
          <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2 xl:grid-cols-3">
            <MiniSeries
              label="Extrinsics"
              days={chrono.map((d) => d.day)}
              values={chrono.map((d) => d.extrinsic_count)}
              color="var(--accent)"
              formatValue={(v) => formatNumber(v)}
            />
            <MiniSeries
              label="Blocks"
              days={chrono.map((d) => d.day)}
              values={chrono.map((d) => d.block_count)}
              color="var(--chart-1)"
              formatValue={(v) => formatNumber(v)}
            />
            <MiniSeries
              label="Events"
              days={chrono.map((d) => d.day)}
              values={chrono.map((d) => d.event_count)}
              color="var(--chart-3)"
              formatValue={(v) => formatNumber(v)}
            />
            <MiniSeries
              label="Success rate"
              days={chrono.map((d) => d.day)}
              values={chrono.map((d) => d.success_rate ?? 0)}
              color="var(--chart-6)"
              formatValue={(v) => `${(v * 100).toFixed(1)}%`}
            />
            <MiniSeries
              label="Unique signers"
              days={chrono.map((d) => d.day)}
              values={chrono.map((d) => d.unique_signers)}
              color="var(--chart-1)"
              formatValue={(v) => formatNumber(v)}
            />
          </div>
        ) : (
          <p className="font-mono text-[12px] text-ink-muted">
            No activity indexed yet — the chain poller fills this every few minutes.
          </p>
        )}
      </section>

      {/* fees: daily series + tip series + top payers */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-border bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
              Daily fees &amp; tips
            </h2>
            <span className="font-mono text-[11px] text-ink-muted">{fees.day_count} days</span>
          </div>
          {feeChrono.length > 0 ? (
            <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
              <MiniSeries
                label="Total fees"
                days={feeChrono.map((d) => d.day)}
                values={feeChrono.map((d) => d.total_fee_tao)}
                color="var(--accent)"
                formatValue={fmtTao}
              />
              <MiniSeries
                label="Avg fee"
                days={feeChrono.map((d) => d.day)}
                values={feeChrono.map((d) => d.avg_fee_tao ?? 0)}
                color="var(--chart-3)"
                formatValue={fmtTao}
              />
              <MiniSeries
                label="Total tips"
                days={feeChrono.map((d) => d.day)}
                values={feeChrono.map((d) => d.total_tip_tao)}
                color="var(--chart-6)"
                formatValue={fmtTao}
              />
              <MiniSeries
                label="Avg tip"
                days={feeChrono.map((d) => d.day)}
                values={feeChrono.map((d) => d.avg_tip_tao ?? 0)}
                color="var(--chart-1)"
                formatValue={fmtTao}
              />
            </div>
          ) : (
            <p className="font-mono text-[12px] text-ink-muted">No fees in this window yet.</p>
          )}
        </section>

        <section className="rounded-lg border border-border bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
              Top fee payers
            </h2>
            <span className="font-mono text-[11px] text-ink-muted">
              {fees.top_fee_payers.length} accounts
            </span>
          </div>
          {fees.top_fee_payers.length > 0 ? (
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className={TH}>Account</th>
                  <th className={`${TH} text-right`}>Fees</th>
                  <th className={`${TH} text-right`}>Tips</th>
                  <th className={`${TH} text-right`}>Txs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {fees.top_fee_payers.map((p) => (
                  <tr key={p.signer} className="hover:bg-surface/40">
                    <td className="px-4 py-2 font-mono text-[11px]">
                      <Link
                        to="/accounts/$ss58"
                        params={{ ss58: p.signer }}
                        className="text-ink-strong hover:text-accent hover:underline"
                        title={p.signer}
                      >
                        {shortHash(p.signer) ?? p.signer}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink">
                      {fmtTao(p.total_fee_tao)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                      {fmtTao(p.total_tip_tao)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                      {formatNumber(p.extrinsic_count)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="font-mono text-[12px] text-ink-muted">
              No fee payers in this window yet.
            </p>
          )}
        </section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* call mix */}
        <CallMixSection calls={calls} />

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
                  <th className={`${TH} text-right`}>Tips</th>
                  <th className={`${TH} text-right`}>Last block</th>
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
                        {shortHash(s.signer) ?? s.signer}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink">
                      {formatNumber(s.tx_count)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                      {fmtTao(s.total_fee_tao)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                      {fmtTao(s.total_tip_tao)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                      {s.last_tx_block != null ? (
                        <Link
                          to="/blocks/$ref"
                          params={{ ref: String(s.last_tx_block) }}
                          className="hover:text-accent hover:underline"
                        >
                          #{formatNumber(s.last_tx_block)}
                        </Link>
                      ) : (
                        "—"
                      )}
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
