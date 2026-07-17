import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  classNames,
  formatFreshness,
  formatFreshnessAbsolute,
} from "@/lib/format";

/**
 * Dense stat tile with optional visualization slot (sparkline / mini-bar /
 * donut / radial / dot row). Replaces the flat label/value/hint tile used in
 * mastheads and KPI strips so every number ships with a visual context.
 */
export function StatWithSpark({
  label,
  value,
  hint,
  full,
  unit,
  tone = "default",
  viz,
  delta,
  className,
  updatedAt,
  windowLabel,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  /** Long tooltip text. Falls back to `hint`. */
  full?: string;
  unit?: string;
  tone?: "ok" | "warn" | "down" | "default";
  /** Visualization placed under the value. Render-prop or node. */
  viz?: ReactNode;
  /** Compact delta chip placed beside the value. */
  delta?: ReactNode;
  className?: string;
  /** ISO timestamp for the underlying snapshot. */
  updatedAt?: string | null;
  /** Active window label (e.g. "7d"). */
  windowLabel?: string | null;
}) {
  const freshLine = formatFreshness(updatedAt, windowLabel);
  const freshAbs = formatFreshnessAbsolute(updatedAt);
  return (
    // Self-wrapped so StatWithSpark works outside AppShell's global provider.
    <TooltipProvider>
      <Tooltip delayDuration={200}>
        <TooltipTrigger asChild>
          <div
            tabIndex={0}
            className={classNames(
              "group flex flex-col gap-1 px-3 py-2.5 min-w-0 focus:outline-none focus-visible:bg-surface/40 transition-colors",
              className,
            )}
          >
            <div className="font-mono text-[9.5px] uppercase tracking-widest text-ink-muted truncate">
              {label}
            </div>
            <div className="flex items-baseline gap-1.5 min-w-0">
              <span
                className={classNames(
                  "font-display text-lg font-semibold tabular-nums leading-none truncate",
                  tone === "ok" && "text-health-ok",
                  tone === "warn" && "text-health-warn",
                  tone === "down" && "text-health-down",
                  tone === "default" && "text-ink-strong",
                )}
              >
                {value}
              </span>
              {unit ? (
                <span className="shrink-0 font-mono text-[9px] uppercase tracking-widest text-ink-muted">
                  {unit}
                </span>
              ) : null}
              {delta}
            </div>
            {viz ? <div className="mt-0.5 min-h-[18px]">{viz}</div> : null}
            {hint ? (
              <div className="font-mono text-[9.5px] text-ink-muted/80 truncate">
                {hint}
              </div>
            ) : null}
            {freshLine ? (
              <div className="font-mono text-[9px] tracking-wide text-ink-muted/70 truncate">
                {freshLine}
              </div>
            ) : null}
          </div>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          className="max-w-xs text-[11px] leading-relaxed"
        >
          <div>{full ?? hint ?? label}</div>
          {freshAbs || windowLabel ? (
            <div className="mt-1 font-mono text-[10px] text-primary-foreground/70">
              {freshAbs ? `Last checked ${freshAbs}` : null}
              {freshAbs && windowLabel ? " · " : ""}
              {windowLabel ? `${windowLabel} window` : null}
            </div>
          ) : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Tiny stacked horizontal bar — used for endpoint kind distribution. */
export function MiniStack({
  segments,
  height = 8,
}: {
  segments: Array<{ label: string; value: number; color: string }>;
  height?: number;
}) {
  const total = segments.reduce((a, s) => a + Math.max(0, s.value), 0);
  if (total <= 0) {
    return (
      <div
        className="w-full rounded-full bg-border/40"
        style={{ height }}
        aria-hidden
      />
    );
  }
  return (
    <div
      className="flex w-full overflow-hidden rounded-full bg-border/40"
      style={{ height }}
      role="img"
      aria-label={segments.map((s) => `${s.label} ${s.value}`).join(", ")}
    >
      {segments.map((s) =>
        s.value > 0 ? (
          <span
            key={s.label}
            style={{
              width: `${(s.value / total) * 100}%`,
              background: s.color,
            }}
            title={`${s.label} · ${s.value}`}
          />
        ) : null,
      )}
    </div>
  );
}

/** Small radial completeness ring (0..1). */
export function MiniRadial({
  value,
  size = 28,
  stroke = 4,
  color = "var(--ink-strong)",
}: {
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, value));
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="block"
      aria-hidden
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--border)"
        strokeWidth={stroke}
        opacity={0.5}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeDasharray={`${c * pct} ${c}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

/** Row of small dots — one per source kind present. */
export function DotRow({
  dots,
}: {
  dots: Array<{ label: string; on: boolean }>;
}) {
  return (
    // One provider for the row rather than one per dot -- self-wrapped so DotRow
    // works outside AppShell's global provider.
    <TooltipProvider>
      <div
        className="flex items-center gap-1"
        role="img"
        aria-label="Source coverage"
      >
        {dots.map((d) => (
          <Tooltip key={d.label} delayDuration={150}>
            <TooltipTrigger asChild>
              <span
                className={classNames(
                  "size-1.5 rounded-full",
                  d.on ? "bg-accent" : "bg-border",
                )}
              />
            </TooltipTrigger>
            <TooltipContent side="top" className="font-mono text-[10px]">
              {d.label} {d.on ? "✓" : "—"}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}

/**
 * Inline "not enough data yet" fallback for spark slots. Keeps the tile
 * shape stable instead of hiding the chart entirely, and surfaces the
 * last-updated timestamp so users can tell stale from missing.
 */
export function NoDataSpark({
  updatedAt,
  windowLabel,
  reason = "not enough data yet",
  height = 18,
}: {
  updatedAt?: string | null;
  windowLabel?: string | null;
  reason?: string;
  height?: number;
}) {
  const freshAbs = formatFreshnessAbsolute(updatedAt);
  const freshLine = formatFreshness(updatedAt, windowLabel);
  return (
    // Self-wrapped so NoDataSpark works outside AppShell's global provider.
    <TooltipProvider>
      <Tooltip delayDuration={150}>
        <TooltipTrigger asChild>
          <div
            tabIndex={0}
            role="img"
            aria-label={`${reason}${freshAbs ? `, last checked ${freshAbs}` : ""}`}
            className="flex w-full items-center gap-1.5 rounded-sm border border-dashed border-border/70 bg-paper/40 px-1.5 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            style={{ height }}
          >
            <span
              aria-hidden
              className="inline-block size-1 rounded-full bg-ink-muted/60"
            />
            <span className="truncate font-mono text-[9px] uppercase tracking-widest text-ink-muted/80">
              {freshLine ?? reason}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="max-w-xs text-[11px] leading-relaxed"
        >
          {reason}.{" "}
          {freshAbs
            ? `Last checked ${freshAbs}${windowLabel ? ` · ${windowLabel} window` : ""}.`
            : "No probe samples recorded yet."}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
