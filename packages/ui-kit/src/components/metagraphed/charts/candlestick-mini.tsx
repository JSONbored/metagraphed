import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { CANDLESTICK_MINI_EMPTY_ARIA_LABEL } from "./chart-aria";

export interface CandlestickDatum {
  /** Timestamp label, e.g. an ISO string or a formatted "12:00 UTC". */
  label: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

const MAX_CANDLES = 500;
// Fraction of each candle's slot width the body rect occupies -- the
// remainder is inter-candle gap, mirroring a typical OHLC chart's spacing.
const BODY_WIDTH_RATIO = 0.6;

interface Props {
  data: CandlestickDatum[];
  width?: number;
  height?: number;
  /** Body/wick color for a close >= open candle. */
  upColor?: string;
  /** Body/wick color for a close < open candle. */
  downColor?: string;
  className?: string;
  ariaLabel?: string;
  /** Format a price for the tooltip (e.g. (v) => `${v.toFixed(4)} TAO`). */
  formatValue?: (v: number) => string;
  /** Disable interactive tooltip when false. */
  interactive?: boolean;
}

/**
 * Tiny inline-SVG OHLC candlestick chart. Mirrors Sparkline's rendering and
 * interaction conventions (viewBox-based responsive sizing, CSS-variable
 * theming, pointer/keyboard-navigable hover tooltip, aria-live announcement)
 * so both read as the same visual language, just plotting four values per
 * point instead of one. Empty input renders the same dashed baseline
 * Sparkline uses for a flat/empty series, rather than an empty chart area.
 */
export function CandlestickMini({
  data,
  width = 480,
  height = 160,
  upColor = "var(--health-ok)",
  downColor = "var(--health-down)",
  className,
  ariaLabel,
  formatValue,
  interactive = true,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const candles = data
    .slice(-MAX_CANDLES)
    .filter(
      (c) =>
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close),
    );

  if (candles.length === 0) {
    return (
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className={`block max-w-full ${className ?? ""}`}
        style={{ maxWidth: width }}
        // #6375: same gap as Sparkline's empty branch -- no role, and no name
        // at all when ariaLabel is omitted.
        role="img"
        aria-label={ariaLabel ?? CANDLESTICK_MINI_EMPTY_ARIA_LABEL}
      >
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="var(--border)"
          strokeDasharray="2 3"
        />
      </svg>
    );
  }

  let min = candles[0]!.low;
  let max = candles[0]!.high;
  for (const c of candles) {
    if (c.low < min) min = c.low;
    if (c.high > max) max = c.high;
  }
  const span = max - min || 1;
  const padY = height * 0.06;
  const plotHeight = height - padY * 2;
  const y = (v: number) => padY + plotHeight - ((v - min) / span) * plotHeight;

  const slotWidth = width / candles.length;
  const bodyWidth = Math.max(1, slotWidth * BODY_WIDTH_RATIO);
  const bars = candles.map((c, i) => {
    const cx = slotWidth * (i + 0.5);
    const up = c.close >= c.open;
    const color = up ? upColor : downColor;
    const bodyTop = y(Math.max(c.open, c.close));
    const bodyBottom = y(Math.min(c.open, c.close));
    // A flat candle (open === close) would collapse to a zero-height rect --
    // give it a hairline so it's still visible, matching how a real
    // candlestick chart renders a doji.
    const bodyHeight = Math.max(1, bodyBottom - bodyTop);
    return {
      cx,
      up,
      color,
      wickTop: y(c.high),
      wickBottom: y(c.low),
      bodyTop,
      bodyHeight,
    };
  });

  const canTooltip = interactive && candles.length > 0;

  function onMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!canTooltip) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const idx = Math.min(
      candles.length - 1,
      Math.floor((x / rect.width) * candles.length),
    );
    setHover(idx);
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (!canTooltip) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      setHover((prev) => Math.min(candles.length - 1, (prev ?? -1) + 1));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setHover((prev) => Math.max(0, (prev ?? candles.length) - 1));
    }
  }

  function onFocus() {
    if (!canTooltip) return;
    setHover((prev) => prev ?? 0);
  }

  const hoverCandle = hover != null ? candles[hover] : null;
  const hoverBar = hover != null ? bars[hover] : null;
  const fmt = formatValue ?? ((v: number) => v.toString());
  const tooltipText = hoverCandle
    ? `${hoverCandle.label} · O ${fmt(hoverCandle.open)} H ${fmt(hoverCandle.high)} L ${fmt(hoverCandle.low)} C ${fmt(hoverCandle.close)}`
    : "";

  return (
    <div
      ref={wrapRef}
      className={`relative block w-full ${className ?? ""}`}
      style={{ width: "100%", maxWidth: width, height }}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={() => setHover(null)}
      tabIndex={canTooltip ? 0 : undefined}
      aria-label={
        canTooltip
          ? `${ariaLabel ?? "Candlestick chart"}, use arrow keys to step through candles`
          : undefined
      }
    >
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel}
        className="block w-full"
      >
        {bars.map((b, i) => (
          <g key={i}>
            <line
              x1={b.cx}
              x2={b.cx}
              y1={b.wickTop}
              y2={b.wickBottom}
              stroke={b.color}
              strokeWidth={1}
            />
            <rect
              x={b.cx - bodyWidth / 2}
              y={b.bodyTop}
              width={bodyWidth}
              height={b.bodyHeight}
              fill={b.color}
              opacity={b.up ? 0.85 : 0.7}
            />
          </g>
        ))}
        {hoverBar ? (
          <line
            x1={hoverBar.cx}
            x2={hoverBar.cx}
            y1={0}
            y2={height}
            stroke="var(--ink-muted)"
            strokeOpacity={0.35}
            strokeWidth={1}
          />
        ) : null}
      </svg>
      {hoverBar && tooltipText ? (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded border border-border bg-paper px-1.5 py-0.5 font-mono text-[10px] leading-tight text-ink-strong shadow-sm whitespace-nowrap"
          style={{
            left: Math.max(60, Math.min(width - 60, hoverBar.cx)),
            top: Math.max(0, hoverBar.wickTop - 4),
          }}
          role="tooltip"
        >
          {tooltipText}
        </div>
      ) : null}
      <span aria-live="polite" className="sr-only">
        {tooltipText}
      </span>
    </div>
  );
}
