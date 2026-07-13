import { useState } from "react";
import { ChevronDown, Info } from "lucide-react";
import {
  classNames,
  formatFreshness,
  formatFreshnessAbsolute,
} from "@/lib/format";

/**
 * Compact, collapsible callout that explains what the visualizations on a
 * subnet profile are measuring and how staleness is handled. Lives near
 * the top of /subnets/:netuid so users can orient themselves before
 * trusting any sparkline.
 */
export function MethodologyCallout({
  generatedAt,
  windowLabel,
}: {
  generatedAt?: string;
  windowLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const freshLine = formatFreshness(generatedAt, windowLabel);
  const freshAbs = formatFreshnessAbsolute(generatedAt);

  return (
    <aside
      aria-label="Data freshness and methodology"
      className="mb-6 rounded-lg border border-border bg-card/60"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-start gap-2 px-3 py-2 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Info className="mt-0.5 size-3.5 shrink-0 text-accent" />
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            Data freshness &amp; methodology
          </span>
          {freshLine ? (
            <span
              className="mt-0.5 block font-mono text-[10px] text-ink-muted/80"
              title={freshAbs ?? undefined}
            >
              {freshLine}
            </span>
          ) : null}
        </span>
        <ChevronDown
          className={classNames(
            "mt-0.5 size-3.5 shrink-0 text-ink-muted transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <div className="grid gap-3 border-t border-border px-3 py-3 text-[11.5px] leading-relaxed text-ink-muted md:grid-cols-2">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-ink-strong">
              Sparklines
            </div>
            <p className="mt-1">
              Uptime &amp; latency sparklines plot the active health window (7d
              default, switchable to 30d). Each point is the mean across every
              tracked endpoint in that bucket — gaps mean no probe landed in the
              window, not zero.
            </p>
          </div>
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-ink-strong">
              Donuts &amp; mosaics
            </div>
            <p className="mt-1">
              Pool ratio comes from on-chain AMM reserves; endpoint topology
              counts tracked public surfaces by kind. The mosaic in Operational
              status colors one cell per endpoint by its last probe result.
            </p>
          </div>
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-ink-strong">
              Staleness
            </div>
            <p className="mt-1">
              Tiles show a <span className="text-health-warn-text">stale</span>{" "}
              chip when the snapshot is older than the refresh budget. Visuals
              still render with the last known values; retry buttons re-fetch
              just the affected panel. Each tile carries its own{" "}
              <span className="text-ink-strong">updated · window</span> stamp so
              you can tell stale from missing at a glance.
            </p>
          </div>
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-ink-strong">
              Verified vs. candidate
            </div>
            <p className="mt-1">
              Only curated surfaces feed donuts and the topology breakdown.
              Unverified leads live in the Candidates tab and never count toward
              health, completeness, or pool ratios.
            </p>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
