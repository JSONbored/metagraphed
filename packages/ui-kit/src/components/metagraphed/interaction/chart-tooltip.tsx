import { useLayoutEffect, useRef, useState } from "react";
import { useActiveEntity, type ActiveEntityData } from "./active-entity";
import { placeTooltip, tooltipPlacement } from "./chart-tooltip-logic";

/**
 * The one chart tooltip (#11606). Mount it inside the chart's positioned
 * container (`position: relative`, ideally the same `[data-marks]` group as
 * the marks). It subscribes to the page's active entity and shows the data
 * the active mark registered -- but only while that mark lives inside this
 * container, so a page with three charts shows one tooltip, next to the mark
 * under the pointer, while every chart still highlights the entity.
 *
 * Desktop: floats 8px to the right of the mark at `top` px of the container,
 * flipped to the left when it would overflow the container's right edge.
 * Below 640px it is a static, full-width panel rendered where it is mounted
 * (put it first in the container so it sits above the visual).
 */
export interface ChartTooltipProps {
  /**
   * Vertical position inside the container, px (measured default 110), or
   * `"mark"` to hang 4px under the active mark's own row (rails, lists).
   */
  top?: number | "mark";
  /** Pin the horizontal position instead of floating beside the mark. */
  offsetLeft?: number;
  /** Fallback content when the active mark registered none. */
  fallback?: (key: string) => ActiveEntityData | null;
  className?: string;
}

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useLayoutEffect(() => {
    const update = () =>
      setMobile(tooltipPlacement(window.innerWidth) === "static");
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return mobile;
}

export function ChartTooltip({
  top = 110,
  offsetLeft,
  fallback,
  className,
}: ChartTooltipProps) {
  const { active } = useActiveEntity();
  const ref = useRef<HTMLDivElement>(null);
  const mobile = useIsMobile();
  const [left, setLeft] = useState<number | null>(null);
  const [markTop, setMarkTop] = useState(0);
  const [, mounted] = useState(false);
  useLayoutEffect(() => mounted(true), []);

  const host = useRef<HTMLDivElement>(null);
  const container = host.current?.parentElement ?? null;
  const anchored =
    active !== null &&
    active.element !== null &&
    container !== null &&
    container.contains(active.element);

  useLayoutEffect(() => {
    if (!anchored || mobile || !ref.current || !active?.element || !container) {
      setLeft(null);
      return;
    }
    const markRect = active.element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    setMarkTop(markRect.bottom - containerRect.top + 4);
    setLeft(
      offsetLeft ??
        placeTooltip(markRect, containerRect, ref.current.offsetWidth),
    );
  }, [anchored, mobile, active, container, offsetLeft]);

  const data = active ? (active.data ?? fallback?.(active.key) ?? null) : null;
  const show = anchored && data !== null;

  return (
    <div ref={host} style={{ display: "contents" }} data-mg-tooltip-host="">
      {show && data ? (
        <div
          ref={ref}
          className={["mg-chart-tooltip", className].filter(Boolean).join(" ")}
          data-placement={mobile ? "static" : "float"}
          data-rows={data.rows && data.rows.length > 0 ? "" : undefined}
          data-mg-tooltip=""
          role="status"
          aria-live="polite"
          style={
            mobile
              ? undefined
              : {
                  top: top === "mark" ? markTop : top,
                  left: left ?? 0,
                  visibility: left === null ? "hidden" : undefined,
                }
          }
        >
          <div className="mg-chart-tooltip-head">
            <strong>{data.title}</strong>
            {data.total ? <span>{data.total}</span> : null}
          </div>
          {data.rows && data.rows.length > 0 ? (
            <div className="mg-chart-tooltip-divider" />
          ) : null}
          {data.rows?.map((row) => (
            <div
              key={row.key}
              className="mg-chart-tooltip-row"
              data-current={row.key === active?.key ? "true" : undefined}
              data-muted={
                active &&
                data.rows?.some((r) => r.key === active.key) &&
                row.key !== active.key
                  ? "true"
                  : undefined
              }
            >
              <span>
                <i
                  className="mg-chart-tooltip-swatch"
                  data-empty={row.swatch ? undefined : "true"}
                  style={
                    row.swatch
                      ? ({ "--swatch": row.swatch } as React.CSSProperties)
                      : undefined
                  }
                />
                <span>{row.label}</span>
              </span>
              <b>{row.value}</b>
            </div>
          ))}
          {data.note ? (
            <div className="mg-chart-tooltip-note">{data.note}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
