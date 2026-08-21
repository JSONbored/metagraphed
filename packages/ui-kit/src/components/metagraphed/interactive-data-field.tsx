import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { useId, useRef, useState } from "react";
import { classNames } from "@/lib/format";

/**
 * The categorical prism deliberately mirrors the data-visual palette rather
 * than product, health, or trust colors. A consumer must give a datum a real
 * category before using one of these tones.
 */
export const INTERACTIVE_DATA_FIELD_TONES = [
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "chart-6",
  "chart-7",
  "chart-8",
  "chart-9",
  "chart-10",
  "chart-11",
] as const;

export type InteractiveDataFieldTone =
  (typeof INTERACTIVE_DATA_FIELD_TONES)[number];

export interface InteractiveDataFieldSegment {
  /** Human label exposed in a route-owned inspector. */
  label: ReactNode;
  /** Literal sub-measurement used when the parent datum is a composition. */
  value: number;
  /** Optional textual equivalent for a route-owned inspector. */
  valueLabel?: ReactNode;
  /** A categorical prism tone. Never use a health or product-state color here. */
  tone: InteractiveDataFieldTone;
}

export interface InteractiveDataFieldDatum {
  /** Stable identity used to preserve an inspected datum through rerenders. */
  id: string;
  /** Short human label used by the default inspector. */
  label: ReactNode;
  /** Visible numeric value used by the default inspector. */
  valueLabel: ReactNode;
  /** Non-negative measurement that determines the bar height. */
  value: number;
  /** Full textual equivalent for a keyboard or screen-reader user. */
  ariaLabel: string;
  /** A categorical prism tone, never a health or brand-state color. */
  tone?: InteractiveDataFieldTone;
  /** Compact vertical x-axis text. Omit when this field has no useful cadence label. */
  axisLabel?: ReactNode;
  /** A datum can be a real composition rather than a single colored column. */
  segments?: readonly InteractiveDataFieldSegment[];
}

export interface InteractiveDataFieldProps {
  /** Concise statement of the chart's question and population. */
  ariaLabel: string;
  data: readonly InteractiveDataFieldDatum[];
  /** Controlled persistent selection lets a companion ranked list follow keyboard or tap intent. */
  activeId?: string | null;
  onActiveChange?: (id: string | null) => void;
  /** Transient pointer inspection, intentionally cleared when the pointer leaves the field. */
  onHoverChange?: (id: string | null) => void;
  /** The small left/right labels beneath the field. */
  axisStart?: ReactNode;
  axisEnd?: ReactNode;
  /** Route-specific provenance or additional inspected facts. */
  renderInspector?: (
    datum: InteractiveDataFieldDatum,
    index: number,
  ) => ReactNode;
  className?: string;
}

/**
 * A keyboard-native research chart. It preserves the visual comparison at
 * rest, then turns all non-inspected columns into neutral graphite while one
 * datum's real categorical composition and compact readout come into focus.
 * Hover is transient; focus and tap lock the same readout for deliberate use.
 */
export function InteractiveDataField({
  ariaLabel,
  data,
  activeId: controlledActiveId,
  onActiveChange,
  onHoverChange,
  axisStart,
  axisEnd,
  renderInspector,
  className,
}: InteractiveDataFieldProps) {
  const inspectorId = useId();
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [uncontrolledActiveId, setUncontrolledActiveId] = useState<
    string | null
  >(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const activeId =
    controlledActiveId === undefined
      ? uncontrolledActiveId
      : controlledActiveId;
  const inspectedId = hoveredId ?? activeId;
  const inspectedIndex = data.findIndex((datum) => datum.id === inspectedId);
  const inspectedDatum = inspectedIndex >= 0 ? data[inspectedIndex] : null;
  // A field is a comparative visual, so use the largest displayed observation
  // as its scale. The value label remains the literal measurement; scaling it
  // against an arbitrary absolute ceiling would make small but meaningful
  // distributions appear flat and destroy the visual read.
  const max = Math.max(
    0,
    ...data.map((datum) => (Number.isFinite(datum.value) ? datum.value : 0)),
  );

  function setActive(id: string | null) {
    if (controlledActiveId === undefined) setUncontrolledActiveId(id);
    onActiveChange?.(id);
  }

  function setHovered(id: string | null) {
    setHoveredId(id);
    onHoverChange?.(id);
  }

  function focusDatum(index: number) {
    const datum = data[index];
    if (!datum) return;

    setHovered(null);
    setActive(datum.id);
    buttonRefs.current[datum.id]?.focus();
  }

  function handleBarKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let nextIndex: number | null = null;

    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = Math.min(index + 1, data.length - 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex = Math.max(index - 1, 0);
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = data.length - 1;
        break;
      case "Escape":
        setHovered(null);
        setActive(null);
        return;
      default:
        return;
    }

    event.preventDefault();
    focusDatum(nextIndex);
  }

  if (data.length === 0) return null;

  const labelInterval = Math.max(1, Math.ceil(data.length / 8));

  function segmentsFor(datum: InteractiveDataFieldDatum): readonly InteractiveDataFieldSegment[] {
    const segments = datum.segments?.filter(
      (segment) => Number.isFinite(segment.value) && segment.value > 0,
    );
    if (segments && segments.length > 0) return segments;
    return [
      {
        label: datum.label,
        value: Math.max(0, datum.value),
        valueLabel: datum.valueLabel,
        tone: datum.tone ?? "chart-5",
      },
    ];
  }

  return (
    <figure
      className={classNames("mg-interactive-data-field", className)}
      aria-label={ariaLabel}
      data-has-active={inspectedDatum ? "true" : undefined}
    >
      <div className="mg-interactive-data-field-plot">
        <div className="mg-interactive-data-field-scroll">
          <div className="mg-interactive-data-field-chart">
            <div className="mg-interactive-data-field-axis" aria-hidden="true">
              {data.map((datum, index) => {
                const isVisible =
                  Boolean(datum.axisLabel) && index % labelInterval === 0;
                return (
                  <span
                    key={datum.id}
                    className="mg-interactive-data-field-axis-item"
                    data-active={datum.id === inspectedId || undefined}
                    data-label-hidden={!isVisible || undefined}
                  >
                    <span>{datum.axisLabel}</span>
                  </span>
                );
              })}
            </div>

            <div
              className="mg-interactive-data-field-bars"
              role="group"
              aria-label={`${ariaLabel} Hover, focus, or tap a data column to inspect it. Use arrow keys after focus to move between columns.`}
              style={{ "--mg-data-field-count": data.length } as CSSProperties}
            >
              {data.map((datum, index) => {
                const height =
                  max > 0
                    ? Math.max(1, (Math.max(0, datum.value) / max) * 100)
                    : 1;
                const inspected = datum.id === inspectedId;
                const segments = segmentsFor(datum);
                const segmentTotal = segments.reduce(
                  (total, segment) => total + segment.value,
                  0,
                );
                const gridRows = segments
                  .map((segment) => `${(segment.value / segmentTotal) * 100}%`)
                  .join(" ");
                const tooltipPlacement =
                  index < Math.ceil(data.length * 0.2)
                    ? "right"
                    : index > Math.floor(data.length * 0.8)
                      ? "left"
                      : "center";

                return (
                  <button
                    key={datum.id}
                    type="button"
                    className="mg-interactive-data-field-bar"
                    data-active={inspected || undefined}
                    data-muted={inspectedId && !inspected ? "true" : undefined}
                    aria-label={datum.ariaLabel}
                    aria-describedby={inspected ? inspectorId : undefined}
                    aria-pressed={inspected}
                    tabIndex={datum.id === (activeId ?? data[0]?.id) ? 0 : -1}
                    ref={(node) => {
                      buttonRefs.current[datum.id] = node;
                    }}
                    onFocus={() => {
                      setHovered(null);
                      setActive(datum.id);
                    }}
                    onPointerEnter={(event) => {
                      if (event.pointerType !== "touch") setHovered(datum.id);
                    }}
                    onPointerLeave={(event) => {
                      if (event.pointerType !== "touch") setHovered(null);
                    }}
                    onClick={() => {
                      setHovered(null);
                      setActive(datum.id);
                    }}
                    onKeyDown={(event) => handleBarKeyDown(event, index)}
                  >
                    <span
                      className="mg-interactive-data-field-bar-fill"
                      aria-hidden="true"
                      style={
                        {
                          "--mg-data-field-bar-height": `${height}%`,
                          "--mg-data-field-segment-rows": gridRows,
                        } as CSSProperties
                      }
                    >
                      {segments.map((segment, segmentIndex) => (
                        <i
                          key={`${datum.id}-${segmentIndex}`}
                          className="mg-interactive-data-field-segment"
                          data-tone={segment.tone}
                        />
                      ))}
                    </span>
                    {inspected ? (
                      <span
                        id={inspectorId}
                        className="mg-interactive-data-field-inspector"
                        data-placement={tooltipPlacement}
                        role="status"
                        aria-live="polite"
                      >
                        {renderInspector ? (
                          renderInspector(datum, index)
                        ) : (
                          <>
                            <span>{datum.label}</span>
                            <strong>{datum.valueLabel}</strong>
                          </>
                        )}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        {inspectedDatum ? (
          <button
            type="button"
            className="mg-interactive-data-field-inspector-dismiss"
            onClick={() => {
              setHovered(null);
              setActive(null);
            }}
            aria-label="Dismiss chart readout"
          >
            <span aria-hidden="true">×</span>
          </button>
        ) : null}
      </div>
      {axisStart || axisEnd ? (
        <figcaption className="mg-interactive-data-field-caption">
          <span>{axisStart}</span>
          <span>{axisEnd}</span>
        </figcaption>
      ) : null}
    </figure>
  );
}
