import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  BookOpen,
  ExternalLink as ExternalLinkIcon,
  Github,
  Globe,
  LayoutDashboard,
  ArrowDownRight,
  ArrowUpRight,
  Minus,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BrandIcon } from "@/components/metagraphed/brand-icon";
import { safeExternalUrl } from "@/components/metagraphed/external-link";
import { CurationChip, HealthPill } from "@/components/metagraphed/chips";
import { FreshnessIndicator } from "@/components/metagraphed/freshness";
import { formatNumber } from "@/lib/metagraphed/format";
import { Sparkline } from "@/components/metagraphed/charts/sparkline";
import {
  StatWithSpark,
  MiniStack,
  MiniRadial,
  DotRow,
  NoDataSpark,
} from "@/components/metagraphed/charts/stat-with-spark";
import {
  subnetEndpointsQuery,
  subnetTrajectoryQuery,
  subnetUptimeQuery,
} from "@/lib/metagraphed/queries";
import type { Endpoint, SubnetProfile, SurfaceUptime } from "@/lib/metagraphed/types";

interface Props {
  netuid: number;
  profile?: SubnetProfile;
  generatedAt?: string;
  stale?: boolean;
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
export function SubnetMasthead({
  netuid,
  profile,
  generatedAt,
  stale,
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

  // Health-derived accent for the top rail.
  const health = profile?.health ?? "unknown";
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

      {/* Status row — slim, never dominates */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-ink-muted mb-3">
        <Link to="/subnets" className="font-mono uppercase tracking-widest hover:text-ink-strong">
          Registry
        </Link>
        <span aria-hidden>/</span>
        <span className="font-mono uppercase tracking-widest">
          Subnets / {String(netuid).padStart(3, "0")}
        </span>
        <span aria-hidden className="opacity-50">
          ·
        </span>
        <FreshnessIndicator at={generatedAt} />
        {stale ? (
          <span className="inline-flex items-center gap-1 rounded border border-health-warn/40 bg-health-warn/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-health-warn">
            stale
          </span>
        ) : null}
      </div>

      {banner ? <div className="mb-4">{banner}</div> : null}

      {/* Identity row */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-4">
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
          {description ? (
            <p className="mt-2 text-sm text-ink-muted max-w-3xl leading-relaxed line-clamp-2">
              {description}
            </p>
          ) : null}
          {links.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {links.map((l) => {
                const Icon = l.icon;
                const safeHref = safeExternalUrl(l.href);
                const className =
                  "group inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-ink-strong transition-colors " +
                  (safeHref
                    ? "hover:border-accent/50 hover:text-accent"
                    : "cursor-default opacity-70");
                const content = (
                  <>
                    <Icon
                      className={
                        "size-3 text-ink-muted " + (safeHref ? "group-hover:text-accent" : "")
                      }
                    />
                    <span>{l.label}</span>
                    {safeHref ? (
                      <ExternalLinkIcon className="size-2.5 text-ink-muted opacity-60" />
                    ) : null}
                  </>
                );

                return (
                  <Tooltip key={l.label} delayDuration={150}>
                    <TooltipTrigger asChild>
                      {safeHref ? (
                        <a
                          href={safeHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={className}
                        >
                          {content}
                        </a>
                      ) : (
                        <span className={className} title="Blocked unsafe external URL">
                          {content}
                        </span>
                      )}
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="font-mono text-[11px]">
                      {safeHref ? host(safeHref) : "Blocked unsafe external URL"}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          ) : null}
        </div>
        <div className="hidden md:flex shrink-0 flex-col items-end gap-1.5">
          <HealthPill state={profile?.health} />
          <CurationChip level={profile?.curation_level} />
        </div>
      </div>

      {/* Stat spine — sparkline-bearing tiles. Auto-wrap on narrow widths. */}
      <div className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] divide-x divide-border rounded-xl border border-border bg-card overflow-hidden">
        <StatWithSpark
          label="Netuid"
          value={String(netuid).padStart(3, "0")}
          hint="Native chain id"
          full="Native Bittensor metagraph identifier"
          updatedAt={generatedAt}
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
          value={
            latencySeries.length ? `${Math.round(latencySeries[latencySeries.length - 1])}` : "—"
          }
          unit={latencySeries.length ? "ms" : undefined}
          hint="median probe latency"
          full="Median request latency from probe trends"
          updatedAt={trendsAt}
          windowLabel={trendWindowKey}
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
      </div>
    </header>
  );
}
