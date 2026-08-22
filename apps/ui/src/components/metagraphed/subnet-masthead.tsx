import { FactCell } from "@jsonbored/ui-kit";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, type QueryKey } from "@tanstack/react-query";
import { BookOpen, ChevronDown, Code2, Github, Globe, LayoutDashboard } from "lucide-react";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import { useRegisterApiSource, useApiSourceCtx } from "@/lib/metagraphed/api-source-context";
import {
  BrandIcon,
  ExternalLink,
  safeExternalUrl,
  CurationChip,
  HealthPill,
  TimeAgo,
} from "@jsonbored/ui-kit";
import { StaleBanner } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import {
  economicsQuery,
  subnetEndpointsQuery,
  subnetDeregistrationsQuery,
  subnetEventSummaryQuery,
  subnetHealthPercentilesQuery,
  subnetRegistrationsQuery,
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

/**
 * The lede's fallback when a subnet has no real description (#8363).
 * `description` now only ever holds the subnet's own product description or
 * the notes-derived short blurb -- see queries.ts's normalizeSubnetProfile --
 * never curation-review provenance, so this never has provenance text to
 * accidentally surface either. Built from the same subnet_type/categories
 * fields already shown as chips just above the lede, restated as a sentence,
 * rather than showing nothing.
 */
export function kindDomainSummary(
  subnetType: string | null | undefined,
  categories: string[],
): string | null {
  const parts = [
    subnetType ? `${subnetType} subnet` : null,
    categories.length > 0 ? categories.join(", ") : null,
  ].filter((v): v is string => Boolean(v));
  return parts.length ? parts.join(" — ") : null;
}

/**
 * The curation chip, wrapped as a disclosure trigger for the full review
 * note (#8363). The chip alone used to be the only affordance for this
 * subnet's diligence; the note itself used to sit in the header's lede,
 * ahead of the subnet's own description. Tap/click opens a small popover
 * with the untruncated note and the review date -- the registry's diligence
 * stays one tap away, labeled as diligence, rather than crowding out the
 * product's own voice.
 */
function ReviewProvenanceChip({
  level,
  notes,
  reviewedAt,
}: {
  level?: string;
  notes: string;
  reviewedAt?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="mg-focus-ring rounded transition-opacity hover:opacity-80"
        title="Review provenance"
      >
        <CurationChip level={level} />
      </button>
      {open ? (
        <Panel
          role="dialog"
          aria-label="Review provenance"
          title="Review provenance"
          action={
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="mg-focus-ring shrink-0 text-ink-muted hover:text-ink-strong"
            >
              ×
            </button>
          }
          className="absolute left-0 top-full z-[var(--mg-z-popover,50)] mt-2 w-80 max-w-[min(90vw,20rem)]"
        >
          <p className="text-13 leading-relaxed text-ink-muted">{notes}</p>
          {reviewedAt ? (
            <p className="mt-2 text-13 text-ink-muted">
              Reviewed <TimeAgo at={reviewedAt} />
            </p>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
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
  // #8247: identity header carries at most 3 type chips (subnet_type + up to
  // 2 categories) -- was slice(0, 4) categories alone, uncapped against
  // subnet_type, which could put 5 chips on one row.
  const categories = (profile?.categories ?? []).slice(0, profile?.subnet_type ? 2 : 3);
  const lede = description || kindDomainSummary(profile?.subnet_type, categories);

  // #8247: the masthead is the one place mounted on every tab, so it owns the
  // canonical API-source registration for this profile -- replacing the
  // "data sources"/"artifacts" footer strip (ApiSourceFooter) that used to
  // render this same list at the bottom of the page. A visible `{ } API`
  // chip in the links row opens the exact same drawer the header's hidden
  // ⌘J trigger does.
  useRegisterApiSource(
    [
      `/api/v1/subnets/${netuid}/profile`,
      `/api/v1/subnets/${netuid}/overview`,
      `/api/v1/subnets/${netuid}/surfaces`,
      `/api/v1/subnets/${netuid}/endpoints`,
      `/api/v1/subnets/${netuid}/candidates`,
      `/api/v1/subnets/${netuid}/gaps`,
      `/api/v1/subnets/${netuid}/identity-history`,
      `/api/v1/subnets/${netuid}/hyperparameters/history`,
      `/api/v1/subnets/${netuid}/volume`,
      `/api/v1/subnets/${netuid}/stake-quote?amount=100&direction=stake`,
      `/api/v1/subnets/${netuid}/lease`,
      `/api/v1/subnets/${netuid}/lease/history`,
      `/api/v1/subnets/${netuid}/holders`,
      `/api/v1/agent-catalog/${netuid}`,
    ],
    [`/metagraph/subnets/${netuid}.json`],
  );
  const { open: openApiDrawer } = useApiSourceCtx();

  // Pull supporting series for the spark tiles. All three queries are already
  // primed by other panels on the page — no additional network hits. The live
  // API does NOT emit a windows[].points[] time-series; the real series are the
  // weekly structural trajectory (completeness/surface/endpoint counts) and the
  // long-range daily uptime history. We source the sparks from those and fall
  // back to an honest no-data state when a series is absent — never a fabricated
  // shape.
  const { data: uptimeRes } = useQuery(subnetUptimeQuery(netuid));
  const { data: endpointsRes } = useQuery(subnetEndpointsQuery(netuid));
  // #8247: source for the new 6-tile KPI band (price/emission/stake/miners-
  // validators). Same economicsQuery() the Economics tab's EconomicsPanel
  // reads -- one shared cache entry, not a second fetch of the same data.
  const { data: econRes } = useQuery(economicsQuery());
  const econ = econRes?.data.find((x) => x.netuid === netuid);
  // #8247: disclosure for the demoted 11-tile registry-stat spine below.
  const [showMoreStats, setShowMoreStats] = useState(false);
  // Same extraction as economics-panel.tsx's Alpha price tile -- one shared
  // shape, not a second definition that could quietly diverge from it.
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

  // Subnet-wide daily uptime % + median latency, meaned across tracked surfaces.
  const { uptimeSeries, latencySeries } = dailyHealthSeries(uptimeRes?.data?.surfaces);

  // Structural growth series for the participation-proxy spark — real weekly
  // surface counts from the trajectory snapshots (no participant time-series is
  // exposed, so we plot the closest honest structural signal instead).

  const lastUptime = uptimeSeries[uptimeSeries.length - 1];
  // Prefer the live 24h uptime passed in; fall back to the freshest daily point.
  const liveUptime =
    uptimePct ??
    (uptimeRes?.data?.reliability?.uptime_ratio != null
      ? uptimeRes.data.reliability.uptime_ratio * 100
      : (lastUptime ?? null));

  // Latency p50 tile: prefer the live per-surface percentiles (7d) — the daily
  // uptime series is often empty even when probes are flowing, which silently
  // dashed this tile. Fall back to the daily series' latest point.
  const surfaceP50 = aggregateSurfaceP50(pctRes?.data);
  const latP50 =
    surfaceP50 ?? (latencySeries.length ? latencySeries[latencySeries.length - 1] : null);

  const endpoints = (endpointsRes?.data ?? []) as Endpoint[];
  const kindCounts = new Map<string, number>();
  for (const e of endpoints) {
    const id = classifyKind(e.kind);
    kindCounts.set(id, (kindCounts.get(id) ?? 0) + 1);
  }

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

  return (
    <header className="mb-6">
      {/* Top accent rail — color = current health state. Subtle but
          gives every subnet a recognizable identity colour. */}
      <div
        aria-hidden
        className="h-[3px] w-full rounded opacity-80 mb-3"
        style={{
          background: `linear-gradient(90deg, ${accentColor} 0%, ${accentColor} 40%, var(--border) 100%)`,
        }}
      />

      {/* No breadcrumb row here: the app-shell's own row is the single
          canonical trail (#7853). AppShell's `crumbLabel` prop carries the
          zero-padded netuid this masthead used to render redundantly. */}

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
            <h1 className="font-display text-28 md:text-28 font-semibold text-ink-strong truncate">
              {name}
            </h1>
            {profile?.symbol ? (
              <span className="font-mono text-13 text-ink-muted">{profile.symbol}</span>
            ) : null}
            {profile?.subnet_type ? (
              <span className="rounded border border-border bg-surface px-1.5 py-0.5 text-13 text-ink-muted">
                {profile.subnet_type}
              </span>
            ) : null}
            {categories.map((c) => (
              <span
                key={c}
                className="rounded border border-border/60 bg-paper px-1.5 py-0.5 text-13 text-ink-muted"
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
            {profile?.notes ? (
              <ReviewProvenanceChip
                level={profile?.curation_level}
                notes={profile.notes}
                reviewedAt={profile?.reviewed_at}
              />
            ) : (
              <CurationChip level={profile?.curation_level} />
            )}
            <StaleBanner
              generatedAt={generatedAt}
              refreshQueryKeys={stale ? refreshQueryKeys : undefined}
              refreshLabel={refreshLabel}
              compact
              bare
            />
          </div>
          {lede ? (
            <p className="mt-2 text-13 text-ink-muted max-w-3xl leading-relaxed line-clamp-2">
              {lede}
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
            <Panel
              flush
              className="mt-3"
              bodyClassName="inline-flex items-center divide-x divide-border overflow-hidden"
            >
              {links.map((l) => {
                const Icon = l.icon;
                const safeHref = safeExternalUrl(l.href);
                const className =
                  "inline-flex size-8 items-center justify-center text-ink-muted transition-colors" +
                  (safeHref
                    ? "hover:bg-surface hover:text-ink-strong"
                    : "cursor-default opacity-40");

                return safeHref ? (
                  <ExternalLink
                    key={l.label}
                    bare
                    href={safeHref}
                    ariaLabel={l.label}
                    className={className}
                  >
                    <Icon className="size-4" />
                  </ExternalLink>
                ) : (
                  <span
                    key={l.label}
                    className={className}
                    aria-label={`${l.label}: blocked unsafe external URL`}
                  >
                    <Icon className="size-4" />
                  </span>
                );
              })}
              <button
                type="button"
                onClick={openApiDrawer}
                aria-label="View API sources for this subnet"
                className="inline-flex size-8 items-center justify-center text-ink-muted transition-colors hover:bg-surface hover:text-ink-strong"
              >
                <Code2 className="size-4" />
              </button>
            </Panel>
          }
        </div>
      </div>

      {/* #8247: the 6-fact KPI band replacing the 11-tile registry spine below.
          Exactly the six the issue specifies -- price, emission, stake,
          miners/validators, uptime, integration readiness -- each fact
          appearing once on the whole page. Registry/activity meta-stats
          (netuid, registrations, participants, endpoints, surfaces,
          completeness, evidence) move to the "More stats" disclosure right
          after it: real information, just not headline-of-the-page
          information, and nothing here is deleted. */}
      <Panel
        flush
        className="mt-4"
        bodyClassName="grid grid-cols-2 divide-x divide-y divide-border overflow-hidden sm:grid-cols-3 sm:divide-y-0 xl:grid-cols-6"
      >
        <FactCell
          label="Price"
          value={econ?.alpha_price_tao != null ? `${econ.alpha_price_tao.toFixed(4)} τ` : "—"}
          hint="Current alpha price against TAO, from the live chain economics tier."
        />
        <FactCell
          label="Emission share"
          value={econ?.emission_share != null ? `${(econ.emission_share * 100).toFixed(3)}%` : "—"}
          hint="Stage 1 of the v440 emission pipeline: this subnet's share of alpha price (alpha_price / total), NOT the share of TAO it receives. Spec 440 separates the two by miner-burn reweighting, the Hill emission gate, the enabled filter, and the alpha injection cap."
        />
        <FactCell
          label="Total stake"
          value={formatTao(econ?.total_stake_alpha)}
          hint="Total alpha staked into this subnet."
        />
        <FactCell
          label="Miners / Validators"
          value={
            econ?.miner_count != null && econ?.validator_count != null
              ? `${formatNumber(econ.miner_count)} / ${formatNumber(econ.validator_count)}`
              : "—"
          }
          hint="Active miner and validator counts against this subnet's registered UID cap."
        />
        <FactCell
          label="Uptime"
          value={liveUptime != null ? `${liveUptime.toFixed(2)}%` : "—"}
          hint="Mean uptime across all tracked endpoints, trailing 24h."
        />
        <FactCell
          label="Integration readiness"
          value={
            profile?.integration_readiness != null ? `${profile.integration_readiness}/100` : "—"
          }
          hint="Objective integration-readiness score: callable API, documented, auth clarity, active lifecycle, profile completeness."
        />
      </Panel>

      {/* #8247: the former 11-tile stat spine (netuid/registrations/
          deregistrations/activity/participants/endpoints/surfaces/uptime/
          latency/completeness/evidence), demoted from the headline KPI band
          above to an on-demand disclosure. Nothing here is deleted --
          registry/activity meta-stats are real information, just not the six
          facts a visitor scans this page for first. Collapsed by default on
          every viewport; this IS the mobile "All stats" bottom-sheet
          equivalent the issue asks for, as a disclosure rather than a
          separate sheet component since the content is identical either way.
          Inline (not extracted) so it keeps closure access to the many local
          values above it -- an earlier extraction attempt needed 15+ props
          and still missed several before this. */}
      <div className="mt-3">
        <button
          type="button"
          onClick={() => setShowMoreStats((v) => !v)}
          aria-expanded={showMoreStats}
          aria-controls={`masthead-more-stats-${netuid}`}
          className="mg-focus-ring inline-flex items-center gap-1.5 rounded px-1 py-1 text-13 font-medium text-ink-muted transition-colors hover:text-ink-strong"
        >
          <ChevronDown
            className={`size-3.5 transition-transform ${showMoreStats ? "rotate-180" : ""}`}
          />
          {showMoreStats ? "Hide" : "Show"} more stats
        </button>
        {showMoreStats ? (
          <Panel
            flush
            id={`masthead-more-stats-${netuid}`}
            className="mt-2"
            bodyClassName="flex flex-wrap divide-x divide-border overflow-hidden [&>*]:grow [&>*]:basis-[150px] [&>*]:min-w-[150px]"
          >
            <FactCell
              label="Netuid"
              value={String(netuid).padStart(3, "0")}
              hint="Native Bittensor metagraph identifier"
            />
            <FactCell
              label="Registrations"
              value={formatNumber(reg?.registrations)}
              hint={`Neuron-registration events on this subnet over the trailing ${reg?.window ?? "30d"} window.`}
            />
            <FactCell
              label="Deregistrations"
              value={formatNumber(dereg?.deregistrations)}
              hint={`Neuron-deregistration (eviction) events on this subnet over the trailing ${dereg?.window ?? "30d"} window.`}
            />
            <FactCell
              label="Activity"
              value={formatNumber(eventSummary?.total_events)}
              hint="Windowed on-chain event rollup for this subnet (registrations, stake, serving, transfers, etc.)"
            />
            <FactCell
              label="Participants"
              value={formatNumber(profile?.participants)}
              hint="UIDs registered in this subnet's metagraph. Spark plots verified-surface growth from weekly registry snapshots (no participant time-series is exposed)."
            />
            <FactCell
              label="Endpoints"
              value={formatNumber(profile?.endpoint_count ?? endpoints.length)}
              hint="Tracked public endpoints, by kind"
            />
            <FactCell
              label="Surfaces"
              value={formatNumber(profile?.surface_count)}
              hint="Verified curated public interfaces"
            />
            <FactCell
              label="Uptime"
              value={liveUptime != null ? `${liveUptime.toFixed(2)}%` : "—"}
              hint="Mean uptime across all tracked endpoints"
            />
            <FactCell
              label="Latency p50"
              value={
                <>
                  {latP50 != null ? `${Math.round(latP50)}` : "—"}{" "}
                  <span className="text-11 text-ink-muted">
                    {latP50 != null ? "ms" : undefined}
                  </span>
                </>
              }
              hint="Median request latency across probed surfaces (p50)"
            />

            <FactCell
              label="Completeness"
              value={completenessPct != null ? `${completenessPct}%` : "—"}
              hint="Registry profile completeness across expected fields"
            />
            <FactCell
              label="Evidence"
              value={evidenceCount != null ? String(evidenceCount) : "—"}
              hint="Number of primary source links recorded"
            />
          </Panel>
        ) : null}
      </div>
    </header>
  );
}
