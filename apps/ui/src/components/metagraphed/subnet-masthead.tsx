import type { ReactNode } from "react";
import { useQuery, type QueryKey } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  BookOpen,
  Github,
  Globe,
  LayoutDashboard,
  ArrowDownRight,
  ArrowUpRight,
  Minus,
} from "lucide-react";
import { formatNumber } from "@/lib/metagraphed/format";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  BrandIcon,
  safeExternalUrl,
  CurationChip,
  HealthPill,
  StatWithSpark,
  MiniStack,
  MiniRadial,
  DotRow,
  NoDataSpark,
  ShareButton,
  Sparkline,
} from "@jsonbored/ui-kit";
import { StaleBanner } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import {
  subnetEndpointsQuery,
  subnetDeregistrationsQuery,
  subnetEventSummaryQuery,
  subnetHealthPercentilesQuery,
  subnetRegistrationsQuery,
  subnetTrajectoryQuery,
  subnetUptimeQuery,
} from "@/lib/metagraphed/queries";
import { useSubnetProbeHealth } from "@/hooks/use-subnet-probe-health";
import type {
  Endpoint,
  SubnetProfile,
  SurfaceLatencyPercentiles,
  SurfaceUptime,
} from "@/lib/metagraphed/types";

interface Props {
  netuid: number;
  profile?: SubnetProfile;
  generatedAt?: string;
  stale?: boolean;
  /** When provided (and `stale`), renders a "Refresh health now"-style
   * button that invalidates these query keys -- same contract as
   * StaleBanner's own `refreshQueryKeys`. */
  refreshQueryKeys?: QueryKey[];
  refreshLabel?: string;
  /** Rendered above everything else -- e.g. an incident/error banner
   * unrelated to snapshot freshness (which now has its own dedicated
   * layout via refreshQueryKeys/refreshLabel above). */
  banner?: ReactNode;
  uptimePct?: number | null;
  evidenceCount?: number;
}

function host(u?: string) {
  if (!u) return "";
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}

interface LinkChip {
  label: string;
  href?: string;
  icon: typeof Globe;
}

// Endpoint kind palette (5 buckets) — visually distinct, all on-token.
const KIND_BUCKETS: Array<{
  id: string;
  label: string;
  color: string;
  match: (k: string) => boolean;
}> = [
  {
    id: "rpc",
    label: "RPC/WSS",
    color: "var(--accent)",
    match: (k) => k === "rpc" || k === "wss" || k === "archive",
  },
  {
    id: "api",
    label: "API/gRPC",
    color: "var(--ink-strong)",
    match: (k) => k === "api" || k === "grpc",
  },
  { id: "sse", label: "SSE", color: "var(--health-ok)", match: (k) => k === "sse" },
  { id: "data", label: "Data", color: "var(--health-warn)", match: (k) => k === "data" },
  { id: "other", label: "Other", color: "var(--border)", match: () => true },
];

function classifyKind(k: unknown): string {
  const key = String(k ?? "other").toLowerCase();
  for (const b of KIND_BUCKETS) if (b.id !== "other" && b.match(key)) return b.id;
  return "other";
}

// On-token palette for the event-summary category stack — cycled across the
// top event categories (registration, stake, serving, …) in count order.
const CATEGORY_COLORS = [
  "var(--accent)",
  "var(--ink-strong)",
  "var(--health-ok)",
  "var(--health-warn)",
  "var(--border)",
] as const;

// Collapse the per-surface daily uptime history into a single subnet-wide
// time-series: for each day, the mean uptime % and mean p50 latency across all
// tracked surfaces that reported that day. Returns chronologically-ordered
// arrays so the sparklines read left→right oldest→newest. Honest by construction:
// days with no probe data simply don't appear (no zero-fill, no synthesis).
function dailyHealthSeries(surfaces: SurfaceUptime[] | undefined): {
  uptimeSeries: number[];
  latencySeries: number[];
} {
  if (!surfaces || surfaces.length === 0) {
    return { uptimeSeries: [], latencySeries: [] };
  }
  const upByDay = new Map<string, { sum: number; n: number }>();
  const latByDay = new Map<string, { sum: number; n: number }>();
  for (const s of surfaces) {
    for (const d of s.days ?? []) {
      if (!d.day) continue;
      if (typeof d.uptime_ratio === "number") {
        const cur = upByDay.get(d.day) ?? { sum: 0, n: 0 };
        upByDay.set(d.day, { sum: cur.sum + d.uptime_ratio * 100, n: cur.n + 1 });
      }
      if (typeof d.avg_latency_ms === "number") {
        const cur = latByDay.get(d.day) ?? { sum: 0, n: 0 };
        latByDay.set(d.day, { sum: cur.sum + d.avg_latency_ms, n: cur.n + 1 });
      }
    }
  }
  const mean = (m: Map<string, { sum: number; n: number }>) =>
    Array.from(m.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, v]) => v.sum / v.n);
  return { uptimeSeries: mean(upByDay), latencySeries: mean(latByDay) };
}

/**
 * Compact dense identity strip + sparkline-bearing stat spine. The stat
 * row replaces flat numeric tiles with mini visualizations (sparklines,
 * stacks, radials, dot rows) so every metric ships visual context.
 */
// Subnet-level p50 from the per-surface percentiles artifact. The /uptime daily
// series is frequently empty even while probes flow (reliability/surfaces null),
// so the latency tile reads /health/percentiles like the KPI strips do — mean of
// the per-surface p50s, no synthesis (null when nothing reported).
function aggregateSurfaceP50(rows: SurfaceLatencyPercentiles[] | undefined): number | null {
  if (!rows || rows.length === 0) return null;
  const vals = rows
    .map((r) => r.latency_ms?.p50)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

export function SubnetMasthead({
  netuid,
  profile,
  generatedAt,
  stale,
  refreshQueryKeys,
  refreshLabel,
  banner,
  uptimePct,
  evidenceCount,
}: Props) {
  const name = profile?.name ?? `Subnet ${netuid}`;
  const description = profile?.description;
  const categories = (profile?.categories ?? []).slice(0, 4);

  // Pull supporting series for the spark tiles. All three queries are already
  // primed by other panels on the page — no additional network hits. The live
  // API does NOT emit a windows[].points[] time-series; the real series are the
  // weekly structural trajectory (completeness/surface/endpoint counts) and the
  // long-range daily uptime history. We source the sparks from those and fall
  // back to an honest no-data state when a series is absent — never a fabricated
  // shape.
  const { data: trajRes } = useQuery(subnetTrajectoryQuery(netuid));
  const { data: uptimeRes } = useQuery(subnetUptimeQuery(netuid));
  const { data: endpointsRes } = useQuery(subnetEndpointsQuery(netuid));
  const { data: pctRes } = useQuery(subnetHealthPercentilesQuery(netuid));
  const { data: regRes } = useQuery(subnetRegistrationsQuery(netuid));
  const { data: deregRes } = useQuery(subnetDeregistrationsQuery(netuid));
  const { data: eventsRes } = useQuery(subnetEventSummaryQuery(netuid));
  // Canonical probe health (#5332) — same source as the /subnets table join,
  // never profile/chain lifecycle status.
  const probeHealth = useSubnetProbeHealth(netuid);
  const reg = regRes?.data;
  const dereg = deregRes?.data;

  // Windowed on-chain event rollup for the aggregate "Activity" tile — one
  // consolidated call in place of several per-kind queries. Top categories by
  // event volume drive the mini-stack; days with no events degrade to a dash.
  const eventSummary = eventsRes?.data;
  const topCategories = [...(eventSummary?.categories ?? [])]
    .sort((a, b) => b.event_count - a.event_count)
    .slice(0, CATEGORY_COLORS.length);
  const categorySegments = topCategories
    .map((c, i) => ({
      label: c.category,
      value: c.event_count,
      color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
    }))
    .filter((s) => s.value > 0);
  const activityHint = categorySegments.length
    ? categorySegments
        .slice(0, 3)
        .map((s) => `${formatNumber(s.value)} ${s.label}`)
        .join(" · ")
    : "on-chain events";
  const activityAt = eventSummary?.observed_at ?? eventsRes?.meta?.generated_at ?? generatedAt;

  // Subnet-wide daily uptime % + median latency, meaned across tracked surfaces.
  const trendWindowKey = uptimeRes?.data?.window ?? "90d";
  const { uptimeSeries, latencySeries } = dailyHealthSeries(uptimeRes?.data?.surfaces);

  // Structural growth series for the participation-proxy spark — real weekly
  // surface counts from the trajectory snapshots (no participant time-series is
  // exposed, so we plot the closest honest structural signal instead).
  const trajPoints = trajRes?.data?.points ?? [];
  const surfaceCountSeries = trajPoints
    .map((p) => (typeof p.surface_count === "number" ? p.surface_count : null))
    .filter((v): v is number => v != null);

  const firstUptime = uptimeSeries[0];
  const lastUptime = uptimeSeries[uptimeSeries.length - 1];
  const uptimeDelta = firstUptime != null && lastUptime != null ? lastUptime - firstUptime : null;
  // Prefer the live 24h uptime passed in; fall back to the freshest daily point.
  const liveUptime =
    uptimePct ??
    (uptimeRes?.data?.reliability?.uptime_ratio != null
      ? uptimeRes.data.reliability.uptime_ratio * 100
      : (lastUptime ?? null));
  const trendsAt = uptimeRes?.meta?.generated_at ?? generatedAt;
  const trajAt = trajRes?.meta?.generated_at ?? generatedAt;
  const endpointsAt = endpointsRes?.meta?.generated_at ?? generatedAt;

  // Latency p50 tile: prefer the live per-surface percentiles (7d) — the daily
  // uptime series is often empty even when probes are flowing, which silently
  // dashed this tile. Fall back to the daily series' latest point.
  const surfaceP50 = aggregateSurfaceP50(pctRes?.data);
  const latP50 =
    surfaceP50 ?? (latencySeries.length ? latencySeries[latencySeries.length - 1] : null);
  const latAt = pctRes?.meta?.generated_at ?? trendsAt;
  const latWindow = surfaceP50 != null ? "7d" : trendWindowKey;

  const endpoints = (endpointsRes?.data ?? []) as Endpoint[];
  const kindCounts = new Map<string, number>();
  for (const e of endpoints) {
    const id = classifyKind(e.kind);
    kindCounts.set(id, (kindCounts.get(id) ?? 0) + 1);
  }
  const stackSegments = KIND_BUCKETS.map((b) => ({
    label: b.label,
    value: kindCounts.get(b.id) ?? 0,
    color: b.color,
  })).filter((s) => s.value > 0);

  const links: LinkChip[] = [
    { label: "Website", href: profile?.website ?? profile?.homepage, icon: Globe },
    { label: "Docs", href: profile?.docs, icon: BookOpen },
    { label: "Repo", href: profile?.repo, icon: Github },
    { label: "Dashboard", href: profile?.dashboard, icon: LayoutDashboard },
  ].filter((l) => !!l.href) as LinkChip[];

  // Health-derived accent for the top rail — probe health, not profile.status.
  const health = probeHealth;
  const accentColor =
    health === "ok"
      ? "var(--health-ok)"
      : health === "warn"
        ? "var(--health-warn)"
        : health === "down"
          ? "var(--health-down)"
          : "var(--accent)";

  const completenessPct =
    profile?.completeness != null ? Math.round(profile.completeness * 100) : null;

  // Coverage of expected resource link kinds.
  const sourceKinds: Array<{ label: string; on: boolean }> = [
    { label: "Site", on: !!(profile?.website ?? profile?.homepage) },
    { label: "Docs", on: !!profile?.docs },
    { label: "Repo", on: !!profile?.repo },
    { label: "Dashboard", on: !!profile?.dashboard },
  ];

  const uptimeTone: "ok" | "warn" | "down" | "default" =
    liveUptime == null ? "default" : liveUptime > 99 ? "ok" : liveUptime < 95 ? "down" : "warn";

  const deltaChip =
    uptimeDelta != null && Math.abs(uptimeDelta) > 0.01 ? (
      <span
        className={
          "inline-flex items-center gap-0.5 font-mono text-[9.5px] " +
          (uptimeDelta > 0 ? "text-health-ok" : "text-health-down")
        }
        title={`${uptimeDelta > 0 ? "+" : ""}${uptimeDelta.toFixed(2)}% over window`}
      >
        {uptimeDelta > 0 ? (
          <ArrowUpRight className="size-3" />
        ) : uptimeDelta < 0 ? (
          <ArrowDownRight className="size-3" />
        ) : (
          <Minus className="size-3" />
        )}
        {Math.abs(uptimeDelta).toFixed(1)}
      </span>
    ) : null;

  return (
    <header className="mb-6">
      {/* Top accent rail — color = current health state. Subtle but
          gives every subnet a recognizable identity colour. */}
      <div
        aria-hidden
        className="h-[3px] w-full rounded-full opacity-80 mb-3"
        style={{
          background: `linear-gradient(90deg, ${accentColor} 0%, ${accentColor} 40%, var(--border) 100%)`,
        }}
      />

      {/* Status row — breadcrumb only. Health/curation/freshness/stale and
          the Share/Refresh actions all live in the identity row below now
          (#5481) -- one consolidated meta strip instead of scattering
          overlapping status signals (a separate "stale" tag that just
          repeated what the freshness caption already said) across rows. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-ink-muted mb-3">
        <Link to="/subnets" className="font-mono uppercase tracking-widest hover:text-ink-strong">
          Registry
        </Link>
        <span aria-hidden>/</span>
        <span className="font-mono uppercase tracking-widest">
          Subnets / {String(netuid).padStart(3, "0")}
        </span>
      </div>

      {banner ? <div className="mb-4">{banner}</div> : null}

      {/* Identity row — icon + body. Health/curation now live inline in the
          body column's own metadata line (#5481), so this stays a plain
          2-col grid at every viewport instead of growing a 3rd column on
          desktop just to hold them. */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 md:gap-4">
        <div className="shrink-0 mt-0.5">
          <BrandIcon
            url={profile?.website ?? profile?.homepage}
            repoUrl={profile?.repo}
            iconUrl={profile?.icon_url}
            netuid={netuid}
            subnetSlug={profile?.slug}
            name={profile?.name}
            fallback={netuid}
            size={64}
          />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="font-display text-2xl md:text-3xl font-semibold tracking-[-0.01em] text-ink-strong truncate">
              {name}
            </h1>
            {profile?.symbol ? (
              <span className="font-mono text-sm text-ink-muted">{profile.symbol}</span>
            ) : null}
            {profile?.subnet_type ? (
              <span className="rounded border border-border bg-surface/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-muted">
                {profile.subnet_type}
              </span>
            ) : null}
            {categories.map((c) => (
              <span
                key={c}
                className="rounded border border-border/60 bg-paper px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-muted"
              >
                {c}
              </span>
            ))}
          </div>
          {/* #5481: one consolidated meta strip -- health, curation,
              freshness, and (when stale) Refresh -- instead of a separate
              "stale" status-row tag repeating what the freshness caption
              already says, plus health/curation split across a mobile
              status-row block and a desktop-only side column. Reads as part
              of the title's own metadata line at every viewport. */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <HealthPill state={probeHealth} />
            <CurationChip level={profile?.curation_level} />
            <StaleBanner
              generatedAt={generatedAt}
              refreshQueryKeys={stale ? refreshQueryKeys : undefined}
              refreshLabel={refreshLabel}
              compact
              bare
            />
          </div>
          {description ? (
            <p className="mt-2 text-sm text-ink-muted max-w-3xl leading-relaxed line-clamp-2">
              {description}
            </p>
          ) : null}
          {
            // One connected bar (matching PrimaryLinksRail's icon-button
            // convention) instead of separately spaced, individually-boxed
            // pills -- icon-only since these (globe/docs/repo/dashboard) are
            // universally recognized; the hostname is still one hover away
            // via the tooltip, and label/href reach assistive tech via
            // aria-label/title on each segment. Share always renders here
            // too (a resource/link action, not a status readout), so the
            // bar itself is unconditional even when there are no links yet.
            <div className="mt-3 inline-flex items-center rounded-md border border-border bg-card divide-x divide-border overflow-hidden">
              {links.map((l) => {
                const Icon = l.icon;
                const safeHref = safeExternalUrl(l.href);
                const className =
                  "inline-flex size-8 items-center justify-center text-ink-muted transition-colors " +
                  (safeHref
                    ? "hover:bg-surface hover:text-ink-strong"
                    : "cursor-default opacity-40");

                return (
                  <Tooltip key={l.label} delayDuration={150}>
                    <TooltipTrigger asChild>
                      {safeHref ? (
                        <a
                          href={safeHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={l.label}
                          aria-label={l.label}
                          className={className}
                        >
                          <Icon className="size-4" />
                        </a>
                      ) : (
                        <span
                          className={className}
                          title="Blocked unsafe external URL"
                          aria-label={`${l.label}: blocked unsafe external URL`}
                        >
                          <Icon className="size-4" />
                        </span>
                      )}
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="font-mono text-[11px]">
                      {safeHref ? host(safeHref) : "Blocked unsafe external URL"}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
              <ShareButton connected />
            </div>
          }
        </div>
      </div>

      {/* Stat spine — sparkline-bearing tiles. Flex-wrap (not grid) so a
          trailing partial row's tiles stretch to fill the row instead of
          leaving empty column slots — grid tracks are shared across every
          row, but flex lines size independently (same pattern as the
          flex-wrap strip in operational-panel.tsx). */}
      <Panel
        as="div"
        flush
        className="mt-4 flex flex-wrap divide-x divide-border overflow-hidden [&>*]:grow [&>*]:basis-[150px] [&>*]:min-w-[150px]"
      >
        <StatWithSpark
          label="Netuid"
          value={String(netuid).padStart(3, "0")}
          hint="Native chain id"
          full="Native Bittensor metagraph identifier"
          updatedAt={generatedAt}
        />
        <StatWithSpark
          label="Registrations"
          value={formatNumber(reg?.registrations)}
          hint={`${formatNumber(reg?.distinct_registrants ?? 0)} registrants`}
          full={`Neuron-registration events on this subnet over the trailing ${reg?.window ?? "30d"} window.`}
          updatedAt={reg?.observed_at ?? null}
          windowLabel={reg?.window ?? "30d"}
        />
        <StatWithSpark
          label="Deregistrations"
          value={formatNumber(dereg?.deregistrations)}
          hint={`${formatNumber(dereg?.distinct_deregistered_hotkeys ?? 0)} hotkeys`}
          full={`Neuron-deregistration (eviction) events on this subnet over the trailing ${dereg?.window ?? "30d"} window.`}
          updatedAt={dereg?.observed_at ?? null}
          windowLabel={dereg?.window ?? "30d"}
        />
        <StatWithSpark
          label="Activity"
          value={formatNumber(eventSummary?.total_events)}
          hint={activityHint}
          full="Windowed on-chain event rollup for this subnet (registrations, stake, serving, transfers, etc.)"
          updatedAt={activityAt}
          windowLabel={eventSummary?.window ?? "7d"}
          viz={<MiniStack segments={categorySegments} />}
        />
        <StatWithSpark
          label="Participants"
          value={formatNumber(profile?.participants)}
          hint="Active UIDs"
          full="UIDs registered in this subnet's metagraph. Spark plots verified-surface growth from weekly registry snapshots (no participant time-series is exposed)."
          updatedAt={trajAt}
          windowLabel="weekly"
          viz={
            <div className="h-[18px]">
              {surfaceCountSeries.length > 1 ? (
                <Sparkline
                  values={surfaceCountSeries}
                  color="var(--ink-muted)"
                  fill={false}
                  height={18}
                  ariaLabel="Verified surface count trend"
                />
              ) : (
                <NoDataSpark updatedAt={trajAt} windowLabel="weekly" />
              )}
            </div>
          }
        />
        <StatWithSpark
          label="Endpoints"
          value={formatNumber(profile?.endpoint_count ?? endpoints.length)}
          hint={
            stackSegments.length
              ? stackSegments.map((s) => `${s.value} ${s.label}`).join(" · ")
              : "tracked"
          }
          full="Tracked public endpoints, by kind"
          updatedAt={endpointsAt}
          viz={<MiniStack segments={stackSegments} />}
        />
        <StatWithSpark
          label="Surfaces"
          value={formatNumber(profile?.surface_count)}
          hint={`${profile?.supported_interface_kinds?.length ?? 0} kinds supported`}
          full="Verified curated public interfaces"
          updatedAt={generatedAt}
          viz={
            <MiniStack
              segments={[
                {
                  label: "verified",
                  value: profile?.surface_count ?? 0,
                  color: "var(--accent)",
                },
                {
                  label: "missing",
                  value: profile?.missing_kinds?.length ?? 0,
                  color: "var(--health-warn)",
                },
              ]}
            />
          }
        />
        <StatWithSpark
          label="Uptime"
          value={liveUptime != null ? `${liveUptime.toFixed(2)}%` : "—"}
          tone={uptimeTone}
          hint="current window"
          full="Mean uptime across all tracked endpoints"
          delta={deltaChip}
          updatedAt={trendsAt}
          windowLabel={trendWindowKey}
          viz={
            <div className="h-[18px]">
              {uptimeSeries.length > 1 ? (
                <Sparkline
                  values={uptimeSeries}
                  color={
                    uptimeTone === "ok"
                      ? "var(--health-ok)"
                      : uptimeTone === "warn"
                        ? "var(--health-warn)"
                        : uptimeTone === "down"
                          ? "var(--health-down)"
                          : "var(--accent)"
                  }
                  height={18}
                  ariaLabel="Uptime sparkline"
                  formatValue={(v) => `${v.toFixed(2)}%`}
                />
              ) : (
                <NoDataSpark updatedAt={trendsAt} windowLabel={trendWindowKey} />
              )}
            </div>
          }
        />
        <StatWithSpark
          label="Latency p50"
          value={latP50 != null ? `${Math.round(latP50)}` : "—"}
          unit={latP50 != null ? "ms" : undefined}
          hint="median probe latency"
          full="Median request latency across probed surfaces (p50)"
          updatedAt={latAt}
          windowLabel={latWindow}
          viz={
            <div className="h-[18px]">
              {latencySeries.length > 1 ? (
                <Sparkline
                  values={latencySeries}
                  color="var(--ink-muted)"
                  height={18}
                  ariaLabel="Latency sparkline"
                  formatValue={(v) => `${Math.round(v)}ms`}
                />
              ) : (
                <NoDataSpark updatedAt={trendsAt} windowLabel={trendWindowKey} />
              )}
            </div>
          }
        />

        <StatWithSpark
          label="Completeness"
          value={completenessPct != null ? `${completenessPct}%` : "—"}
          hint="registry profile"
          full="Registry profile completeness across expected fields"
          updatedAt={generatedAt}
          viz={
            <div className="flex items-center gap-2">
              <MiniRadial
                value={completenessPct != null ? completenessPct / 100 : 0}
                size={22}
                stroke={3}
              />
              <span className="font-mono text-[9.5px] text-ink-muted truncate">
                {profile?.curation_level ?? "—"}
              </span>
            </div>
          }
        />
        <StatWithSpark
          label="Evidence"
          value={evidenceCount != null ? String(evidenceCount) : "—"}
          hint="primary sources"
          full="Number of primary source links recorded"
          updatedAt={generatedAt}
          viz={<DotRow dots={sourceKinds} />}
        />
      </Panel>
    </header>
  );
}
