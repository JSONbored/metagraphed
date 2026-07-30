import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRegistryEvents } from "@/hooks/use-registry-events";
import { useRefetchInterval } from "@/hooks/use-refetch-interval";
import { useMemo, useState } from "react";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import { AppShell } from "@/components/metagraphed/app-shell";
import { SelfHealthVerdict } from "@/components/metagraphed/self-health-verdict";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { AsyncPanel, Panel } from "@/components/metagraphed/primitives";
import { EmptyState, PageHeading, Skeleton } from "@/components/metagraphed/states";
import {
  CopyableCode,
  ExternalLink,
  SectionHeading,
  TimeAgo,
  AnimatedNumber,
} from "@jsonbored/ui-kit";
import { healthQuery, globalIncidentsQuery, incidentsFeedQuery } from "@/lib/metagraphed/queries";
import { API_BASE } from "@/lib/metagraphed/config";
import { classNames, humaniseSeconds } from "@/lib/metagraphed/format";
import type { GlobalIncidentSurface } from "@/lib/metagraphed/types";

// Subnets shown before "Show all" -- groups now, not individual surfaces.
const GROUPS_INITIAL = 8;
// A downtime event whose last failure is within this of the latest snapshot is
// treated as still-ongoing (probe cadence is ~2 min, so ~5 cycles).
const ONGOING_MS = 10 * 60_000;
const WINDOWS = ["7d", "30d"] as const;
const INCIDENTS_FEED_BASE = "/api/v1/feeds/incidents";
const INCIDENTS_FEED_FORMATS = [
  { label: "RSS", suffix: ".rss" },
  { label: "Atom", suffix: ".atom" },
  { label: "JSON", suffix: ".json" },
] as const;

function isGlobalIncidentOngoing(s: GlobalIncidentSurface, observedAt?: string | null): boolean {
  const observedMs = observedAt ? Date.parse(observedAt) : Date.now();
  const latest = s.incidents.reduce((max, i) => Math.max(max, i.ended_at || 0), 0);
  return latest > 0 && observedMs - latest < ONGOING_MS;
}

export function StatusPage() {
  // #1117: refresh on registry publish in addition to the poll interval.
  useRegistryEvents();
  return (
    <AppShell>
      <PageHeading
        eyebrow="Public status"
        title="System status"
        description="Is Metagraphed up? That question, answered first — then what we're seeing across the subnet surfaces we track. Probe-derived only; nobody can self-report their own health here."
        right={
          <Link
            to="/health"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1.5 mg-type-caption font-medium text-ink-muted hover:border-ink/30 hover:text-ink-strong min-h-9"
          >
            Ops console
            <ArrowUpRight className="size-3" aria-hidden="true" />
          </Link>
        }
      />
      <div className="space-y-section">
        {/* #8250: the verdict is scoped to OUR components and nothing else.
            The old one derived "Partial outage" from the third-party surface
            counts below, so 3 of 617 someone-else's endpoints being down
            painted a red banner that read as "metagraphed is down" -- on the
            one page whose entire job is answering that accurately. */}
        <AsyncPanel
          context="status verdict"
          fallback={<Skeleton className="h-40 w-full" />}
          retryQueryKeys={[healthQuery().queryKey]}
        >
          <SelfHealthVerdict />
        </AsyncPanel>

        <section>
          <SectionHeading
            title="Recent incidents"
            intro="Probe-detected downtime across the subnet surfaces we track, newest first."
          />
          <AsyncPanel context="recent incidents" fallback={<Skeleton className="h-32 w-full" />}>
            <RecentIncidents />
          </AsyncPanel>
        </section>

        <section>
          <SectionHeading
            title="Subscribe"
            intro="The same downtime stream as a feed — RSS, Atom, or JSON Feed."
          />
          <AsyncPanel
            context="incidents feed"
            fallback={<Skeleton className="h-32 w-full" />}
            retryQueryKeys={[incidentsFeedQuery().queryKey]}
          >
            <IncidentsFeedSubscribe />
          </AsyncPanel>
        </section>

        {/* #8250: the per-day probe drill-down (96,395px) and the per-provider
            source-health rollup (11,251px) left this page -- together they were
            94% of its 115,233px height, and neither answers "is it up". Both
            are operational drill-downs and now live only on the ops console
            they were always duplicating. The per-subnet view lives on each
            subnet's own API tab. */}
        <section>
          <SectionHeading
            title="Go deeper"
            intro="Per-day probe results, per-provider verification, the live mosaic and the full surface ledger are operational views — they live on the ops console."
          />
          <div className="flex flex-wrap gap-2">
            <Link
              to="/health"
              className="inline-flex min-h-11 items-center gap-1.5 rounded border border-border bg-card px-3 py-1.5 mg-type-caption font-medium text-ink-strong hover:border-accent/40"
            >
              Ops console
              <ArrowUpRight className="size-3" aria-hidden="true" />
            </Link>
            <Link
              to="/apis/endpoints"
              className="inline-flex min-h-11 items-center gap-1.5 rounded border border-border bg-card px-3 py-1.5 mg-type-caption font-medium text-ink-strong hover:border-accent/40"
            >
              Browse all surfaces
              <ArrowUpRight className="size-3" aria-hidden="true" />
            </Link>
          </div>
        </section>
      </div>
      <ApiSourceFooter
        paths={[
          "/api/v1/self-health",
          "/api/v1/health",
          "/api/v1/incidents",
          "/api/v1/feeds/incidents",
        ]}
      />
    </AppShell>
  );
}

function RecentIncidents() {
  const window = useSearch({ from: "/status", select: (s) => s.window });
  const navigate = useNavigate({ from: "/status" });
  const [showAll, setShowAll] = useState(false);
  const refetchInterval = useRefetchInterval(60_000);
  const { data } = useSuspenseQuery({
    ...globalIncidentsQuery(window),
    refetchInterval,
  });
  const ledger = data.data;
  // A surface is still failing ("ongoing") when its most recent downtime event
  // ends within a few probe cycles of the latest snapshot; everything else is a
  // resolved past event. This separates "what's down right now" from "what's
  // flapped over the window", so the window count never reads as a live outage.
  const { surfaces, ongoingCount } = useMemo(() => {
    const list = [...(ledger?.surfaces ?? [])];
    list.sort(
      (a, b) =>
        Number(isGlobalIncidentOngoing(b, ledger?.observed_at)) -
          Number(isGlobalIncidentOngoing(a, ledger?.observed_at)) ||
        b.incident_count - a.incident_count ||
        b.downtime_ms - a.downtime_ms,
    );
    return {
      surfaces: list,
      ongoingCount: list.filter((s) => isGlobalIncidentOngoing(s, ledger?.observed_at)).length,
    };
  }, [ledger]);
  // One entry per subnet, ordered by "worst first" -- ongoing before resolved,
  // then by event count. `surfaces` is already sorted that way, so grouping in
  // iteration order preserves it without a second sort.
  const groups = useMemo(() => {
    const byNetuid = new Map<number, GlobalIncidentSurface[]>();
    for (const s of surfaces) {
      const list = byNetuid.get(s.netuid);
      if (list) list.push(s);
      else byNetuid.set(s.netuid, [s]);
    }
    return [...byNetuid.entries()].map(([netuid, list]) => ({ netuid, surfaces: list }));
  }, [surfaces]);

  const summary = ledger?.summary;
  const affected = summary?.affected_surface_count ?? surfaces.length;

  return (
    <div className="space-y-3">
      <Panel as="div" dense bodyClassName="flex flex-wrap items-center gap-3">
        <div>
          <div className="mg-label">
            {ongoingCount > 0 ? "Active now" : "Downtime events · " + window}
          </div>
          <div
            className={classNames(
              "font-display text-lg font-semibold tabular-nums",
              ongoingCount > 0 ? "text-health-down" : "text-health-ok",
            )}
          >
            {ongoingCount > 0 ? <>{ongoingCount} ongoing</> : "All clear"}
          </div>
        </div>
        <div className="mg-type-data text-ink-muted">
          <AnimatedNumber value={summary?.incident_count} /> sustained event
          {summary?.incident_count === 1 ? "" : "s"} · {window} · across {affected}{" "}
          {affected === 1 ? "surface" : "surfaces"}
        </div>
        <div className="ml-auto inline-flex items-center overflow-hidden rounded-md border border-border bg-card mg-type-label">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => {
                navigate({ search: (prev) => ({ ...prev, window: w }) });
                setShowAll(false);
              }}
              className={classNames(
                "px-2.5 py-1 font-mono uppercase tracking-widest transition-colors",
                window === w ? "bg-surface text-ink-strong" : "text-ink-muted hover:text-ink",
              )}
              aria-pressed={window === w}
            >
              {w}
            </button>
          ))}
        </div>
      </Panel>

      {surfaces.length === 0 ? (
        <EmptyState title="No sustained downtime in this window" />
      ) : (
        <>
          {/* #8250: grouped by subnet and collapsed. A flat list of every
              affected surface was most of this page's height, and it buried
              the thing a reader wants -- WHICH subnets are having trouble --
              under one row per endpoint. One row per subnet, expandable to its
              own surfaces. */}
          <ul className="space-y-2">
            {(showAll ? groups : groups.slice(0, GROUPS_INITIAL)).map((g) => (
              <SubnetIncidentGroup
                key={g.netuid}
                netuid={g.netuid}
                surfaces={g.surfaces}
                observedAt={ledger?.observed_at}
              />
            ))}
          </ul>
          {groups.length > GROUPS_INITIAL ? (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="block w-full rounded border border-border bg-card px-3 py-2 mg-type-caption font-medium text-ink-muted hover:border-ink/30 hover:text-ink-strong min-h-11"
            >
              {showAll
                ? "Show fewer"
                : `Show all ${groups.length} affected subnets (${surfaces.length} surfaces)`}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Subscribe card for the incidents JSON/RSS/Atom feeds backing this page. */
function IncidentsFeedSubscribe() {
  const refetchInterval = useRefetchInterval(60_000);
  const { data } = useSuspenseQuery({
    ...incidentsFeedQuery(),
    refetchInterval,
  });
  const feed = data.data;
  const items = feed?.items ?? [];

  return (
    <div className="space-y-3">
      <Panel dense className="space-y-3">
        {feed?.description ? <p className="text-sm text-ink-muted">{feed.description}</p> : null}
        <div className="space-y-2">
          {INCIDENTS_FEED_FORMATS.map(({ label, suffix }) => {
            const path = `${INCIDENTS_FEED_BASE}${suffix}`;
            const url = `${API_BASE}${path}`;
            return (
              <div key={suffix} className="flex flex-wrap items-center gap-2">
                <span className="mg-label w-12 shrink-0">{label}</span>
                <ExternalLink href={url} className="mg-type-data hover:text-ink-strong">
                  {path}
                </ExternalLink>
                <CopyableCode value={url} label="copy" className="px-1.5 py-0.5" />
              </div>
            );
          })}
        </div>
      </Panel>
      {items.length === 0 ? <EmptyState title="No incidents in feed" /> : null}
    </div>
  );
}

/** One subnet's incidents, collapsed to a single row until opened (#8250). */
function SubnetIncidentGroup({
  netuid,
  surfaces,
  observedAt,
}: {
  netuid: number;
  surfaces: GlobalIncidentSurface[];
  observedAt?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const ongoing = surfaces.filter((s) => isGlobalIncidentOngoing(s, observedAt)).length;
  const events = surfaces.reduce((n, s) => n + s.incident_count, 0);
  const downtime = humaniseSeconds(surfaces.reduce((ms, s) => ms + s.downtime_ms, 0) / 1000);

  return (
    <li className="rounded border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-3 px-3 py-2.5 text-left min-h-11"
      >
        <span
          className={classNames(
            "inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 mg-type-caption",
            ongoing > 0
              ? "border-health-down/40 bg-health-down/5 text-health-down"
              : "border-border bg-paper text-ink-muted",
          )}
        >
          {ongoing > 0 ? `${ongoing} ongoing` : "Resolved"}
        </span>
        <Link
          to="/subnets/$netuid"
          params={{ netuid }}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 mg-type-data text-ink-strong hover:text-accent-text"
        >
          SN{netuid}
        </Link>
        <span className="mg-type-caption text-ink-muted">
          {surfaces.length} {surfaces.length === 1 ? "surface" : "surfaces"} · {events}{" "}
          {events === 1 ? "event" : "events"} · {downtime} down
        </span>
        <ChevronDown
          className={classNames(
            "ml-auto size-3.5 shrink-0 text-ink-muted transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      {open ? (
        <ul className="space-y-2 border-t border-border p-3">
          {surfaces.map((s) => (
            <SurfaceRow
              key={s.surface_id}
              surface={s}
              ongoing={isGlobalIncidentOngoing(s, observedAt)}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function SurfaceRow({ surface, ongoing }: { surface: GlobalIncidentSurface; ongoing?: boolean }) {
  const latest = surface.incidents.reduce((max, i) => Math.max(max, i.ended_at || 0), 0);
  const downtime = humaniseSeconds(surface.downtime_ms / 1000);
  return (
    <li className="flex flex-wrap items-center gap-3 rounded border border-border bg-card px-3 py-2.5">
      <span
        className={classNames(
          "inline-flex items-center rounded border px-1.5 py-0.5 mg-type-caption shrink-0",
          ongoing
            ? "border-health-down/40 bg-health-down/5 text-health-down"
            : "border-border bg-paper text-ink-muted",
        )}
        title={ongoing ? "Still failing as of the latest probe" : "Recovered"}
      >
        {ongoing ? "Ongoing" : "Resolved"}
      </span>
      <span className="mg-label shrink-0">SN{surface.netuid}</span>
      <span className="min-w-0 font-mono mg-type-caption text-ink-strong truncate">
        {surface.surface_id}
      </span>
      <span className="ml-auto flex min-w-0 max-w-full flex-wrap items-center gap-3 mg-label">
        <span className="text-ink-muted tabular-nums">
          {surface.incident_count} {surface.incident_count === 1 ? "event" : "events"}
        </span>
        <span className="tabular-nums" title="total downtime in window">
          {downtime} down
        </span>
        <span>
          last <TimeAgo at={latest ? new Date(latest).toISOString() : undefined} />
        </span>
      </span>
    </li>
  );
}
