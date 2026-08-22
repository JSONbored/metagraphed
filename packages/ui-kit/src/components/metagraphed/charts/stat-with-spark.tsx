import type { ReactNode } from "react";
import { Definition } from "../interaction/definition";
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
    <div
      className={classNames(
        "group flex flex-col gap-1 px-3 py-2.5 min-w-0 transition-colors",
        className,
      )}
    >
      <div className="flex items-center gap-1 min-w-0">
        <span className="text-13 text-ink-muted truncate">{label}</span>
        {full ? <Definition term={label} sentence={full} /> : null}
      </div>
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span
          className={classNames(
            "font-display text-16 font-semibold tabular-nums leading-none truncate",
            tone === "ok" && "text-health-ok",
            tone === "warn" && "text-health-warn",
            tone === "down" && "text-health-down",
            tone === "default" && "text-ink-strong",
          )}
        >
          {value}
        </span>
        {unit ? (
          <span className="shrink-0 text-11 text-ink-muted">{unit}</span>
        ) : null}
        {delta}
      </div>
      {viz ? <div className="mt-0.5 min-h-[18px]">{viz}</div> : null}
      {hint ? (
        <div className="text-10 text-ink-muted/80 truncate">{hint}</div>
      ) : null}
      {freshLine || freshAbs ? (
        <div className="text-10 text-ink-muted/70 truncate">
          {freshLine ?? `Last checked ${freshAbs}`}
        </div>
      ) : null}
    </div>
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
        className="w-full rounded bg-border/40"
        style={{ height }}
        aria-hidden
      />
    );
  }
  return (
    <div
      className="flex w-full overflow-hidden rounded bg-border/40"
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
    <div
      className="flex items-center gap-1"
      role="img"
      aria-label={`Source coverage: ${dots.map((d) => `${d.label} ${d.on ? "present" : "missing"}`).join(", ")}`}
    >
      {dots.map((d) => (
        <span
          key={d.label}
          className={classNames(
            "size-1.5 rounded-full mg-dot",
            d.on ? "bg-accent" : "bg-border",
          )}
        />
      ))}
    </div>
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
    <div
      role="img"
      aria-label={`${reason}${freshAbs ? `, last checked ${freshAbs}` : ", no probe samples recorded yet"}`}
      className="flex w-full items-center gap-1.5 rounded border border-dashed border-border/70 bg-paper px-1.5"
      style={{ height }}
    >
      <span
        aria-hidden
        className="inline-block size-1 rounded-full mg-dot bg-ink-muted/60"
      />
      <span className="truncate text-13 text-ink-muted/80">
        {freshLine ?? reason}
      </span>
    </div>
  );
}
