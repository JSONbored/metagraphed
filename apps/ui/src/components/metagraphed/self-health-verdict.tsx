import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, HelpCircle, XCircle } from "lucide-react";
import { Panel } from "@/components/metagraphed/primitives";
import { healthQuery, selfHealthQuery } from "@/lib/metagraphed/queries";
import { useRefetchInterval } from "@/hooks/use-refetch-interval";
import { classNames } from "@/lib/metagraphed/format";
import type { SelfHealthComponentView } from "@/lib/metagraphed/types";

// #8250: the verdict, correctly scoped.
//
// The old one derived "Partial outage" from /api/v1/health -- which counts
// THIRD-PARTY subnet surfaces. Three of 617 someone-else's endpoints being
// down painted a red banner that read, to any visitor, as "metagraphed is
// down". That is the single worst thing a status page can do, because it's the
// one page whose entire job is to answer that question accurately.
//
// So: the headline comes from /api/v1/self-health (our own api/site/publish,
// probed from outside our edge) and NOTHING else. Third-party health still
// appears -- it's genuinely useful -- but as a subline about what we track,
// never as our own status, and never in red.

const COMPONENT_LABEL: Record<string, string> = {
  api: "api.metagraph.sh",
  site: "metagraph.sh",
  publish: "Data pipeline",
};

const VERDICT_COPY = {
  operational: {
    word: "Metagraphed systems: operational",
    tone: "ok" as const,
    Icon: CheckCircle2,
  },
  degraded: {
    word: "Metagraphed systems: degraded",
    tone: "warn" as const,
    Icon: AlertTriangle,
  },
  outage: {
    word: "Metagraphed systems: outage",
    tone: "down" as const,
    Icon: XCircle,
  },
};

const TONE_TEXT = {
  ok: "text-health-ok",
  warn: "text-health-warn",
  down: "text-health-down",
  unknown: "text-ink-muted",
};

export function SelfHealthVerdict() {
  const refetchInterval = useRefetchInterval(60_000);
  // Third-party rollup: suspending, because it's been on this page forever and
  // is known-good.
  const { data: hRes } = useSuspenseQuery({ ...healthQuery(), refetchInterval });
  // Our own health: NOT suspending and retry: 0. The route is new, and a page
  // that can't reach it must say "we can't tell" rather than fail to render --
  // a status page erroring is itself the worst possible status report.
  const self = useQuery({ ...selfHealthQuery(), refetchInterval });

  const h = hRes.data;
  const ok = h?.ok ?? 0;
  const warn = h?.warn ?? 0;
  const down = h?.down ?? 0;
  const unknown = h?.unknown ?? 0;
  const total = h?.total ?? ok + warn + down + unknown;

  const selfData = self.data?.data;
  const verdict = selfData ? VERDICT_COPY[selfData.verdict] : null;

  return (
    <Panel as="section">
      <div className="flex items-start gap-3">
        {verdict ? (
          <verdict.Icon
            className={classNames("mt-0.5 size-5 shrink-0", TONE_TEXT[verdict.tone])}
            aria-hidden
          />
        ) : (
          <HelpCircle className="mt-0.5 size-5 shrink-0 text-ink-muted" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <h2
            className={classNames(
              "font-display text-lg font-semibold",
              verdict ? TONE_TEXT[verdict.tone] : "text-ink-muted",
            )}
          >
            {verdict ? verdict.word : "Metagraphed systems: no reading"}
          </h2>
          {/* The third-party line. Deliberately plain text, never a tone
              colour: 3 subnet APIs being down is not our outage, and colouring
              it like one is exactly the bug this rebuild fixes. */}
          <p className="mt-1 mg-type-caption text-ink-muted">
            Tracking {total.toLocaleString()} subnet surfaces: {ok.toLocaleString()} up ·{" "}
            {warn.toLocaleString()} slow · {down.toLocaleString()} down
            {unknown > 0 ? ` · ${unknown.toLocaleString()} unknown` : ""}. Those are other
            teams&rsquo; endpoints, not ours.
          </p>
          {!selfData ? (
            <p className="mt-1 mg-type-caption text-ink-muted">
              Our own component checks aren&rsquo;t reporting yet — this page will show them once
              the self-health probe is live.
            </p>
          ) : null}
        </div>
      </div>

      {selfData && selfData.components.length > 0 ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {selfData.components.map((c) => (
            <ComponentStrip key={c.component} component={c} />
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

/** One component's current state + its 90-day daily uptime strip. */
function ComponentStrip({ component }: { component: SelfHealthComponentView }) {
  const tone = component.current_ok == null ? "unknown" : component.current_ok ? "ok" : "down";
  const pct = component.uptime_90d != null ? `${(component.uptime_90d * 100).toFixed(2)}%` : "—";

  return (
    <Panel as="div" flush className="p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate mg-type-caption text-ink-strong">
          {COMPONENT_LABEL[component.component] ?? component.component}
        </span>
        <span className={classNames("mg-type-data-sm tabular-nums", TONE_TEXT[tone])}>
          {component.current_ok == null ? "no data" : component.current_ok ? "up" : "down"}
        </span>
      </div>
      <div className="mt-2 mg-type-data-lg text-ink-strong tabular-nums">{pct}</div>
      <div className="mg-type-caption text-ink-muted">
        {component.days.length > 0
          ? `${component.days.length} day${component.days.length === 1 ? "" : "s"} measured`
          : "not yet measured"}
      </div>
      {/* #8352: a stale publish is a cadence miss, not an HTTP-level outage --
          the bare "down" above already says that much; this line says WHY, so
          a reader doesn't read it as the same failure class as api/site. */}
      {component.note ? (
        <div className="mt-1 mg-type-caption text-health-warn">{component.note}</div>
      ) : null}
      <UptimeStrip days={component.days} />
    </Panel>
  );
}

/**
 * 90-day daily uptime bars.
 *
 * Renders only the days that HAVE probe rows — a gap is drawn as a gap, not as
 * a zero-height (0%) bar. Zero-filling would draw an outage the data never
 * recorded, which on a status page is the one lie that matters.
 */
function UptimeStrip({ days }: { days: SelfHealthComponentView["days"] }) {
  if (days.length === 0) return null;
  return (
    <div
      className="mt-2 flex h-6 items-end gap-px"
      role="img"
      aria-label={`Daily uptime over the last ${days.length} measured days`}
    >
      {days.map((d) => {
        const tone =
          d.uptime_ratio >= 0.999
            ? "bg-health-ok"
            : d.uptime_ratio >= 0.95
              ? "bg-health-warn"
              : "bg-health-down";
        return (
          <span
            key={d.day}
            title={`${d.day}: ${(d.uptime_ratio * 100).toFixed(2)}% (${d.ok_count}/${d.checks})`}
            className={classNames("min-w-px flex-1 rounded-t", tone)}
            // Floor at 15% so a genuinely-zero day is still a visible mark
            // rather than an invisible one indistinguishable from a gap.
            style={{ height: `${Math.max(15, d.uptime_ratio * 100)}%` }}
          />
        );
      })}
    </div>
  );
}
