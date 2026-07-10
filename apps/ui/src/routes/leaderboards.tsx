import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useMemo } from "react";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { UserMinus, UserPlus } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { PageHero } from "@/components/metagraphed/page-hero";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { StatTile } from "@/components/metagraphed/charts/stat-tile";
import { BrandIcon } from "@/components/metagraphed/brand-icon";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import {
  chainDeregistrationsQuery,
  chainRegistrationsQuery,
  subnetsQuery,
} from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import type { Subnet } from "@/lib/metagraphed/types";

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
          "Network-wide Bittensor leaderboards — neuron registrations and deregistrations ranked by subnet over 7d and 30d windows.",
      },
      { property: "og:title", content: "Leaderboards — Metagraphed" },
      {
        property: "og:description",
        content:
          "Network-wide Bittensor leaderboards — neuron registrations and deregistrations ranked by subnet over 7d and 30d windows.",
      },
    ],
  }),
  component: LeaderboardsPage,
});

const TH = "px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted";

function LeaderboardsPage() {
  return (
    <AppShell>
      <PageHero
        eyebrow="Explorer"
        live
        title="Leaderboards"
        description="Network-wide chain activity boards — ranked by subnet from live chain-direct analytics."
      />
      <div className="space-y-12">
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-[32rem] w-full" />}>
            <RegistrationsLeaderboard />
          </Suspense>
        </QueryErrorBoundary>
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-[32rem] w-full" />}>
            <DeregistrationsLeaderboard />
          </Suspense>
        </QueryErrorBoundary>
      </div>
      <ApiSourceFooter paths={["/api/v1/chain/registrations", "/api/v1/chain/deregistrations"]} />
    </AppShell>
  );
}

function RegistrationsLeaderboard() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const win = search.window;

  const { data: boardRes } = useSuspenseQuery(chainRegistrationsQuery(win));
  const { data: snRes } = useSuspenseQuery(subnetsQuery());
  const board = boardRes.data;

  const subnetById = useMemo(() => {
    const m = new Map<number, Subnet>();
    for (const s of (snRes.data ?? []) as Subnet[]) m.set(s.netuid, s);
    return m;
  }, [snRes]);

  const network = board.network;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
            Registrations
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            Neuron joins ranked by subnet — raw NeuronRegistered events over the selected window.
          </p>
        </div>
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
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          icon={UserPlus}
          eyebrow="Registrations"
          value={formatNumber(network.registrations)}
          hint={`${win} network total`}
          tone="accent"
        />
        <StatTile
          icon={UserPlus}
          eyebrow="Distinct registrants"
          value={formatNumber(network.distinct_registrants)}
          hint="network-wide unique"
        />
        <StatTile
          icon={UserPlus}
          eyebrow="Per registrant"
          value={
            network.registrations_per_registrant != null
              ? network.registrations_per_registrant.toFixed(2)
              : "—"
          }
          hint="network intensity"
        />
      </div>

      {board.subnet_count === 0 || board.subnets.length === 0 ? (
        <EmptyState
          title="No registrations in this window"
          description="The chain poller has not indexed any NeuronRegistered events for this window yet, or registration activity was zero."
          lastChecked={board.observed_at ?? undefined}
        />
      ) : (
        <section className="rounded-lg border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
              Per-subnet rankings
            </span>
            <span className="font-mono text-[11px] text-ink-muted">
              {formatNumber(board.subnet_count)} subnets
              {board.observed_at ? (
                <>
                  {" "}
                  · observed <TimeAgo at={board.observed_at} />
                </>
              ) : null}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className={TH}>Rank</th>
                  <th className={TH}>Subnet</th>
                  <th className={`${TH} text-right`}>Registrations</th>
                  <th className={`${TH} text-right`}>Distinct registrants</th>
                  <th className={`${TH} text-right`}>Per registrant</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {board.subnets.map((row, i) => {
                  const subnet = subnetById.get(row.netuid);
                  const name = subnet?.name ?? `Subnet ${row.netuid}`;
                  return (
                    <tr key={row.netuid} className="hover:bg-surface/40">
                      <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                        {i + 1}
                      </td>
                      <td className="px-4 py-2.5">
                        <Link
                          to="/subnets/$netuid"
                          params={{ netuid: row.netuid }}
                          className="inline-flex min-w-0 items-center gap-2 hover:text-accent"
                        >
                          <BrandIcon
                            size={18}
                            name={name}
                            fallback={row.netuid}
                            netuid={row.netuid}
                            subnetSlug={typeof subnet?.slug === "string" ? subnet.slug : undefined}
                          />
                          <span className="truncate text-sm text-ink-strong">{name}</span>
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-strong">
                        {formatNumber(row.registrations)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                        {formatNumber(row.distinct_registrants)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                        {row.registrations_per_registrant != null
                          ? row.registrations_per_registrant.toFixed(2)
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function DeregistrationsLeaderboard() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const win = search.window;

  const { data: boardRes } = useSuspenseQuery(chainDeregistrationsQuery(win));
  const { data: snRes } = useSuspenseQuery(subnetsQuery());
  const board = boardRes.data;

  const subnetById = useMemo(() => {
    const m = new Map<number, Subnet>();
    for (const s of (snRes.data ?? []) as Subnet[]) m.set(s.netuid, s);
    return m;
  }, [snRes]);

  const network = board.network;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
            Deregistrations
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            Neuron evictions ranked by subnet — raw NeuronDeregistered events over the selected
            window.
          </p>
        </div>
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
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          icon={UserMinus}
          eyebrow="Deregistrations"
          value={formatNumber(network.deregistrations)}
          hint={`${win} network total`}
          tone="accent"
        />
        <StatTile
          icon={UserMinus}
          eyebrow="Distinct hotkeys"
          value={formatNumber(network.distinct_deregistered_hotkeys)}
          hint="network-wide unique"
        />
        <StatTile
          icon={UserMinus}
          eyebrow="Per hotkey"
          value={
            network.deregistrations_per_hotkey != null
              ? network.deregistrations_per_hotkey.toFixed(2)
              : "—"
          }
          hint="network intensity"
        />
      </div>

      {board.subnet_count === 0 || board.subnets.length === 0 ? (
        <EmptyState
          title="No deregistrations in this window"
          description="The chain poller has not indexed any NeuronDeregistered events for this window yet, or eviction activity was zero."
          lastChecked={board.observed_at ?? undefined}
        />
      ) : (
        <section className="rounded-lg border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
              Per-subnet rankings
            </span>
            <span className="font-mono text-[11px] text-ink-muted">
              {formatNumber(board.subnet_count)} subnets
              {board.observed_at ? (
                <>
                  {" "}
                  · observed <TimeAgo at={board.observed_at} />
                </>
              ) : null}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className={TH}>Rank</th>
                  <th className={TH}>Subnet</th>
                  <th className={`${TH} text-right`}>Deregistrations</th>
                  <th className={`${TH} text-right`}>Distinct hotkeys</th>
                  <th className={`${TH} text-right`}>Per hotkey</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {board.subnets.map((row, i) => {
                  const subnet = subnetById.get(row.netuid);
                  const name = subnet?.name ?? `Subnet ${row.netuid}`;
                  return (
                    <tr key={row.netuid} className="hover:bg-surface/40">
                      <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                        {i + 1}
                      </td>
                      <td className="px-4 py-2.5">
                        <Link
                          to="/subnets/$netuid"
                          params={{ netuid: row.netuid }}
                          className="inline-flex min-w-0 items-center gap-2 hover:text-accent"
                        >
                          <BrandIcon
                            size={18}
                            name={name}
                            fallback={row.netuid}
                            netuid={row.netuid}
                            subnetSlug={typeof subnet?.slug === "string" ? subnet.slug : undefined}
                          />
                          <span className="truncate text-sm text-ink-strong">{name}</span>
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-strong">
                        {formatNumber(row.deregistrations)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                        {formatNumber(row.distinct_deregistered_hotkeys)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                        {row.deregistrations_per_hotkey != null
                          ? row.deregistrations_per_hotkey.toFixed(2)
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
