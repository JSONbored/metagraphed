import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useMemo } from "react";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { Scale, UserMinus } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import {
  PageHero,
  BrandIcon,
  TimeAgo,
  StatTile,
  ShareButton,
  DownloadCsvButton,
  ActionBar,
} from "@jsonbored/ui-kit";
import {
  chainDeregistrationsQuery,
  chainWeightsQuery,
  subnetsQuery,
} from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { buildUrl } from "@/lib/metagraphed/client";
import type { Subnet } from "@/lib/metagraphed/types";

const leaderboardsSearchSchema = z.object({
  window: fallback(z.enum(["7d", "30d"]), "7d").default("7d"),
});

type LeaderboardWindow = z.infer<typeof leaderboardsSearchSchema>["window"];

export const Route = createFileRoute("/leaderboards")({
  validateSearch: zodValidator(leaderboardsSearchSchema),
  head: () => ({
    meta: [
      { title: "Leaderboards — Metagraphed" },
      {
        name: "description",
        content:
          "Network-wide Bittensor leaderboards — validator weight-setting activity and neuron deregistrations ranked by subnet over 7d and 30d windows.",
      },
      { property: "og:title", content: "Leaderboards — Metagraphed" },
      {
        property: "og:description",
        content:
          "Network-wide Bittensor leaderboards — validator weight-setting activity and neuron deregistrations ranked by subnet over 7d and 30d windows.",
      },
    ],
  }),
  component: LeaderboardsPage,
});

const TH = "px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted";
const WINDOW_BTN_ACTIVE =
  "rounded-full border border-accent/40 bg-accent/10 px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-accent";
const WINDOW_BTN =
  "rounded-full border border-border bg-card px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-ink-muted hover:border-ink/30";

// Every board on this route ranks the same 7d/30d window, so the window control lives at the page
// level and governs both sections rather than each board owning a duplicate toggle.
function LeaderboardsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const win = search.window;

  return (
    <AppShell>
      <PageHero
        eyebrow="Explorer"
        live
        title="Leaderboards"
        description="Network-wide chain activity boards — ranked by subnet from live chain-direct analytics."
        actions={
          <ActionBar>
            <DownloadCsvButton
              url={buildUrl("/api/v1/chain/weights", { window: win })}
              label="Weight-setting CSV"
              bare
            />
            <DownloadCsvButton
              url={buildUrl("/api/v1/chain/deregistrations", { window: win })}
              label="Deregistrations CSV"
              bare
            />
            <ShareButton bare />
          </ActionBar>
        }
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Window
        </span>
        {(["7d", "30d"] as const).map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => navigate({ search: { window: w } })}
            className={w === win ? WINDOW_BTN_ACTIVE : WINDOW_BTN}
          >
            {w}
          </button>
        ))}
      </div>
      <div className="space-y-12">
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-[32rem] w-full" />}>
            <WeightSettingLeaderboard win={win} />
          </Suspense>
        </QueryErrorBoundary>
        <QueryErrorBoundary>
          <Suspense fallback={<Skeleton className="h-[32rem] w-full" />}>
            <DeregistrationsLeaderboard win={win} />
          </Suspense>
        </QueryErrorBoundary>
      </div>
      <ApiSourceFooter paths={["/api/v1/chain/weights", "/api/v1/chain/deregistrations"]} />
    </AppShell>
  );
}

// Shared subnet lookup so a board row can render the brand icon + name for its netuid. subnetsQuery
// is cached per key, so both boards mounting it is a single shared fetch, not a waterfall.
function useSubnetById(): Map<number, Subnet> {
  const { data: snRes } = useSuspenseQuery(subnetsQuery());
  return useMemo(() => {
    const m = new Map<number, Subnet>();
    for (const s of (snRes.data ?? []) as Subnet[]) m.set(s.netuid, s);
    return m;
  }, [snRes]);
}

function WeightSettingLeaderboard({ win }: { win: LeaderboardWindow }) {
  const { data: boardRes } = useSuspenseQuery(chainWeightsQuery(win));
  const subnetById = useSubnetById();
  const board = boardRes.data;
  const network = board.network;
  const dist = board.intensity_distribution;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Weight-setting activity
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          Validator consensus effort ranked by subnet — raw WeightsSet events over the selected
          window.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          icon={Scale}
          eyebrow="Weight-sets"
          value={formatNumber(network.weight_sets)}
          hint={`${win} network total`}
          tone="accent"
        />
        <StatTile
          icon={Scale}
          eyebrow="Distinct setters"
          value={formatNumber(network.distinct_setters)}
          hint="network-wide unique validators"
        />
        <StatTile
          icon={Scale}
          eyebrow="Per setter"
          value={network.sets_per_setter != null ? network.sets_per_setter.toFixed(2) : "—"}
          hint="network intensity"
        />
      </div>

      {dist ? (
        <p className="text-xs text-ink-muted">
          Update intensity across {formatNumber(dist.count)} subnets — median{" "}
          {dist.median.toFixed(2)}, p90 {dist.p90.toFixed(2)}, max {dist.max.toFixed(2)} sets per
          validator.
        </p>
      ) : null}

      {board.subnet_count === 0 || board.subnets.length === 0 ? (
        <EmptyState
          title="No weight-setting activity in this window"
          description="The chain poller has not indexed any WeightsSet events for this window yet, or no validators set weights."
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
          {/* < md: the 5-column table clips its trailing columns behind an
              undiscoverable horizontal scroll, so narrow viewports get a
              stacked card per subnet instead — mirrors the cards/desktop-only
              split the explorer leaderboards use for the same static boards. */}
          <div className="md:hidden space-y-2 p-3">
            {board.subnets.map((row, i) => {
              const subnet = subnetById.get(row.netuid);
              const name = subnet?.name ?? `Subnet ${row.netuid}`;
              return (
                <div key={row.netuid} className="rounded border border-border bg-card p-3">
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: row.netuid }}
                      className="inline-flex min-w-0 items-center gap-2 hover:text-accent"
                    >
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
                        {i + 1}
                      </span>
                      <BrandIcon
                        size={18}
                        name={name}
                        fallback={row.netuid}
                        netuid={row.netuid}
                        subnetSlug={typeof subnet?.slug === "string" ? subnet.slug : undefined}
                      />
                      <span className="truncate text-sm text-ink-strong">{name}</span>
                    </Link>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
                      {row.sets_per_setter != null
                        ? `${row.sets_per_setter.toFixed(2)} / setter`
                        : "—"}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between font-mono text-[11px] tabular-nums text-ink-muted">
                    <span>{formatNumber(row.weight_sets)} weight-sets</span>
                    <span>{formatNumber(row.distinct_setters)} setters</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className={TH}>Rank</th>
                  <th className={TH}>Subnet</th>
                  <th className={`${TH} text-right`}>Weight-sets</th>
                  <th className={`${TH} text-right`}>Distinct setters</th>
                  <th className={`${TH} text-right`}>Per setter</th>
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
                        {formatNumber(row.weight_sets)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                        {formatNumber(row.distinct_setters)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-muted">
                        {row.sets_per_setter != null ? row.sets_per_setter.toFixed(2) : "—"}
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

function DeregistrationsLeaderboard({ win }: { win: LeaderboardWindow }) {
  const { data: boardRes } = useSuspenseQuery(chainDeregistrationsQuery(win));
  const subnetById = useSubnetById();
  const board = boardRes.data;
  const network = board.network;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
          Deregistrations
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          Neuron evictions ranked by subnet — raw NeuronDeregistered events over the selected
          window.
        </p>
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
          {/* < md: card fallback per subnet (see the weight-setting board). */}
          <div className="md:hidden space-y-2 p-3">
            {board.subnets.map((row, i) => {
              const subnet = subnetById.get(row.netuid);
              const name = subnet?.name ?? `Subnet ${row.netuid}`;
              return (
                <div key={row.netuid} className="rounded border border-border bg-card p-3">
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      to="/subnets/$netuid"
                      params={{ netuid: row.netuid }}
                      className="inline-flex min-w-0 items-center gap-2 hover:text-accent"
                    >
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
                        {i + 1}
                      </span>
                      <BrandIcon
                        size={18}
                        name={name}
                        fallback={row.netuid}
                        netuid={row.netuid}
                        subnetSlug={typeof subnet?.slug === "string" ? subnet.slug : undefined}
                      />
                      <span className="truncate text-sm text-ink-strong">{name}</span>
                    </Link>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
                      {row.deregistrations_per_hotkey != null
                        ? `${row.deregistrations_per_hotkey.toFixed(2)} / hotkey`
                        : "—"}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between font-mono text-[11px] tabular-nums text-ink-muted">
                    <span>{formatNumber(row.deregistrations)} deregistrations</span>
                    <span>{formatNumber(row.distinct_deregistered_hotkeys)} hotkeys</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="hidden md:block overflow-x-auto">
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
