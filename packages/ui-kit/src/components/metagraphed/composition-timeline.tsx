import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { useId, useRef, useState } from "react";
import { classNames } from "@/lib/format";

/**
 * The categorical prism. A consumer must give a series a real, named category
 * before spending one of these tones — they are never product, health, trust,
 * or state colors, and product mint is deliberately absent from the ramp.
 */
export const COMPOSITION_TIMELINE_TONES = [
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

export type CompositionTimelineTone =
  (typeof COMPOSITION_TIMELINE_TONES)[number];

/**
 * Picks the tone for the nth series in a cohort.
 *
 * Walking the ramp in order (chart-1, chart-2, chart-3…) is the obvious
 * implementation and it is wrong for a stacked chart: the ramp is a smooth
 * hue sweep, so consecutive entries are near-neighbours in colour and the
 * segments they produce sit directly on top of one another. A six-subnet
 * cohort came out as four adjacent violets that could not be told apart.
 *
 * Striding by 4 visits every tone before repeating (4 is coprime with 11) and
 * puts roughly a third of the wheel between neighbours, so adjacent segments
 * separate. It stays a pure function of the cohort index, which is what keeps
 * a series' colour stable between responses.
 */
export function compositionToneAt(index: number): CompositionTimelineTone {
  const stride = 4;
  const tones = COMPOSITION_TIMELINE_TONES;
  return tones[(Math.max(0, index) * stride) % tones.length] ?? tones[0];
}

interface CompositionTimelineSeriesBase {
  /** Stable identity. A series keeps its tone for the life of the timeline. */
  id: string;
  /** The name shown in the key, the inspector, and the nonvisual table. */
  label: string;
}

/**
 * A series is either an observed category, which owns a categorical tone, or
 * the derived residual, which owns none.
 *
 * The union is the point. A residual is not a cohort member — it is whatever
 * is left of the normalised unit — so letting it hold a categorical tone was
 * how it ended up drawn in the ramp's red and reading as an alert state. Now
 * the compiler refuses the combination instead of a comment asking nicely.
 */
export type CompositionTimelineSeries =
  | (CompositionTimelineSeriesBase & {
      tone: CompositionTimelineTone;
      residual?: false;
    })
  | (CompositionTimelineSeriesBase & {
      tone?: never;
      /** Ordered last, drawn in the neutral residual tone, labelled derived. */
      residual: true;
    });

export interface CompositionTimelineColumn {
  /** Stable identity, typically the closed UTC day. */
  id: string;
  /** Full domain label for the inspector and the nonvisual table. */
  label: string;
  /** Compact rotated axis text. Omit to leave the tick unlabelled. */
  axisLabel?: string;
  /** One short supporting fact, e.g. "128 priced subnets". */
  caption?: string;
  /** series id -> its share of this column's normalised unit. */
  shares: Readonly<Record<string, number>>;
}

/**
 * Exactly one thing is inspected at a time, and the two inspectable things are
 * genuinely different questions: "what happened on this day" versus "how did
 * this series behave across every day".
 */
export type CompositionTimelineInspection =
  | { kind: "none" }
  | { kind: "column"; id: string }
  | { kind: "series"; id: string };

const NO_INSPECTION: CompositionTimelineInspection = { kind: "none" };

/**
 * The #11547 cross-filter contract, as one pure decision.
 *
 * At rest every real series stays vividly legible — this chart is not dull
 * until hovered. Inspecting a day turns the *other days* graphite while that
 * day keeps its full palette. Inspecting a series keeps that series vivid
 * across every day and turns unrelated segments graphite. The two states are
 * mutually exclusive, so a segment is only ever asked one question.
 */
export function resolveSegmentEmphasis(
  inspection: CompositionTimelineInspection,
  columnId: string,
  seriesId: string,
): "vivid" | "graphite" {
  switch (inspection.kind) {
    case "column":
      return inspection.id === columnId ? "vivid" : "graphite";
    case "series":
      return inspection.id === seriesId ? "vivid" : "graphite";
    default:
      return "vivid";
  }
}

/**
 * Lane chrome follows the column question only. Inspecting a series must not
 * single out a day, because the claim being made is about the whole span.
 */
export function resolveColumnEmphasis(
  inspection: CompositionTimelineInspection,
  columnId: string,
): "rest" | "active" | "receded" {
  if (inspection.kind !== "column") return "rest";
  return inspection.id === columnId ? "active" : "receded";
}

/**
 * Segments are laid out against the column's own observed total rather than an
 * assumed 1.0. A source that rounds to six decimals will not sum to exactly
 * one, and normalising here keeps the stack flush instead of leaving a sliver
 * of rail showing on some columns and not others.
 */
export function segmentRows(
  series: readonly CompositionTimelineSeries[],
  shares: Readonly<Record<string, number>>,
): { rows: string; total: number } {
  const values = series.map((entry) => {
    const value = shares[entry.id];
    return Number.isFinite(value) && value > 0 ? value : 0;
  });
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return { rows: "", total: 0 };
  return {
    rows: values.map((value) => `${(value / total) * 100}%`).join(" "),
    total,
  };
}

/** A compact percentage of the normalised unit, stable across the component. */
export function formatCompositionShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  const percentage = share * 100;
  if (percentage >= 10) return `${percentage.toFixed(1)}%`;
  if (percentage >= 1) return `${percentage.toFixed(2)}%`;
  return `${percentage.toFixed(3)}%`;
}

export interface CompositionTimelineProps {
  /** States the chart's question and population in one sentence. */
  ariaLabel: string;
  /** Ordered cohort. Residual series are rendered last regardless of position. */
  series: readonly CompositionTimelineSeries[];
  /** Chronological columns, oldest first. */
  columns: readonly CompositionTimelineColumn[];
  /** Controlled inspection, so a companion module can follow the same intent. */
  inspection?: CompositionTimelineInspection;
  onInspectionChange?: (inspection: CompositionTimelineInspection) => void;
  /** Small labels beneath the plot, typically the span's first and last day. */
  axisStart?: ReactNode;
  axisEnd?: ReactNode;
  /** Caption for the visually-hidden table that carries the same numbers. */
  tableCaption?: string;
  formatValue?: (share: number) => string;
  className?: string;
}

/**
 * A temporal-composition instrument: narrow dotted daily lanes, sharp stacked
 * categorical segments, and compact anchored inspection of either one day or
 * one series.
 *
 * It ships the nonvisual alternative the genre usually omits — a real table
 * carrying the same numbers — so the chart is never the only way to read the
 * data. Product mint is reserved for the focus ring; it is never used to
 * express a data value or a hover state.
 */
export function CompositionTimeline({
  ariaLabel,
  series,
  columns,
  inspection: controlledInspection,
  onInspectionChange,
  axisStart,
  axisEnd,
  tableCaption,
  formatValue = formatCompositionShare,
  className,
}: CompositionTimelineProps) {
  const inspectorId = useId();
  const tableId = useId();
  const laneRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [uncontrolled, setUncontrolled] =
    useState<CompositionTimelineInspection>(NO_INSPECTION);
  const [hovered, setHovered] = useState<CompositionTimelineInspection | null>(
    null,
  );

  const committed = controlledInspection ?? uncontrolled;
  // Hover is a transient overlay on the committed intent, so releasing the
  // pointer returns to whatever the keyboard or a tap deliberately locked.
  const inspection = hovered ?? committed;

  // A residual is derived, not observed, so it always sits at the end of both
  // the stack and the key no matter how the consumer ordered its cohort.
  const ordered = [
    ...series.filter((entry) => !entry.residual),
    ...series.filter((entry) => entry.residual),
  ];

  if (ordered.length === 0 || columns.length === 0) return null;

  function commit(next: CompositionTimelineInspection) {
    setHovered(null);
    if (controlledInspection === undefined) setUncontrolled(next);
    onInspectionChange?.(next);
  }

  function focusColumn(index: number) {
    const column = columns[index];
    if (!column) return;
    commit({ kind: "column", id: column.id });
    laneRefs.current[column.id]?.focus();
  }

  function handleLaneKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let nextIndex: number | null = null;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = Math.min(index + 1, columns.length - 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex = Math.max(index - 1, 0);
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = columns.length - 1;
        break;
      case "Escape":
        commit(NO_INSPECTION);
        return;
      default:
        return;
    }
    event.preventDefault();
    focusColumn(nextIndex);
  }

  const activeColumnId =
    inspection.kind === "column" ? inspection.id : columns[0]?.id;
  const inspectedColumn =
    inspection.kind === "column"
      ? columns.find((column) => column.id === inspection.id)
      : undefined;
  const inspectedSeries =
    inspection.kind === "series"
      ? ordered.find((entry) => entry.id === inspection.id)
      : undefined;

  // The one-line spoken state. It names the current inspection rather than
  // reciting the whole cohort, which is what makes it usable at speed.
  const liveSummary = inspectedColumn
    ? `${inspectedColumn.label}. ${ordered
        .map(
          (entry) =>
            `${entry.label} ${formatValue(inspectedColumn.shares[entry.id] ?? 0)}`,
        )
        .join(", ")}.`
    : inspectedSeries
      ? `${inspectedSeries.label} across ${columns.length} days.`
      : "";

  const labelInterval = Math.max(1, Math.ceil(columns.length / 8));

  return (
    <figure
      className={classNames("mg-composition-timeline", className)}
      aria-label={ariaLabel}
      data-inspecting={inspection.kind === "none" ? undefined : inspection.kind}
    >
      <div className="mg-composition-timeline-plot">
        <div className="mg-composition-timeline-scroll">
          <div
            className="mg-composition-timeline-chart"
            style={
              { "--mg-composition-count": columns.length } as CSSProperties
            }
          >
            <div className="mg-composition-timeline-axis" aria-hidden="true">
              {columns.map((column, index) => (
                <span
                  key={column.id}
                  className="mg-composition-timeline-axis-item"
                  data-emphasis={resolveColumnEmphasis(inspection, column.id)}
                  data-label-hidden={
                    !column.axisLabel || index % labelInterval !== 0
                      ? "true"
                      : undefined
                  }
                >
                  <span>{column.axisLabel}</span>
                </span>
              ))}
            </div>

            <div
              className="mg-composition-timeline-lanes"
              role="group"
              aria-label={`${ariaLabel} Hover, focus, or tap a day to inspect it; arrow keys move between days. Use the series key to follow one series across every day.`}
            >
              {columns.map((column, index) => {
                const { rows, total } = segmentRows(ordered, column.shares);
                const emphasis = resolveColumnEmphasis(inspection, column.id);
                const isInspected = inspectedColumn?.id === column.id;
                // Keep the readout inside the plot at both ends rather than
                // letting it clip against the scroll container's edge.
                const placement =
                  index < Math.ceil(columns.length * 0.2)
                    ? "right"
                    : index > Math.floor(columns.length * 0.8)
                      ? "left"
                      : "center";

                return (
                  <button
                    key={column.id}
                    type="button"
                    className="mg-composition-timeline-lane"
                    data-emphasis={emphasis}
                    aria-label={`${column.label}${column.caption ? `. ${column.caption}` : ""}`}
                    aria-pressed={isInspected}
                    aria-describedby={isInspected ? inspectorId : undefined}
                    tabIndex={column.id === activeColumnId ? 0 : -1}
                    ref={(node) => {
                      laneRefs.current[column.id] = node;
                    }}
                    onFocus={() => commit({ kind: "column", id: column.id })}
                    onPointerEnter={(event) => {
                      if (event.pointerType !== "touch") {
                        setHovered({ kind: "column", id: column.id });
                      }
                    }}
                    onPointerLeave={(event) => {
                      if (event.pointerType !== "touch") setHovered(null);
                    }}
                    onClick={() => commit({ kind: "column", id: column.id })}
                    onKeyDown={(event) => handleLaneKeyDown(event, index)}
                  >
                    <span
                      className="mg-composition-timeline-stack"
                      aria-hidden="true"
                      style={
                        {
                          "--mg-composition-rows": rows,
                        } as CSSProperties
                      }
                    >
                      {total > 0
                        ? ordered.map((entry) => (
                            <i
                              key={entry.id}
                              className="mg-composition-timeline-segment"
                              data-tone={
                                entry.residual ? "residual" : entry.tone
                              }
                              data-emphasis={resolveSegmentEmphasis(
                                inspection,
                                column.id,
                                entry.id,
                              )}
                            />
                          ))
                        : null}
                    </span>

                    {isInspected ? (
                      <span
                        id={inspectorId}
                        className="mg-composition-timeline-inspector"
                        data-placement={placement}
                      >
                        <span className="mg-composition-timeline-inspector-domain">
                          {column.label}
                        </span>
                        {column.caption ? (
                          <span className="mg-composition-timeline-inspector-caption">
                            {column.caption}
                          </span>
                        ) : null}
                        <span className="mg-composition-timeline-inspector-rows">
                          {ordered.map((entry) => (
                            <span key={entry.id}>
                              <i
                                aria-hidden="true"
                                className="mg-composition-timeline-swatch"
                                data-tone={
                                  entry.residual ? "residual" : entry.tone
                                }
                              />
                              <span>{entry.label}</span>
                              <b>{formatValue(column.shares[entry.id] ?? 0)}</b>
                            </span>
                          ))}
                        </span>
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {inspection.kind !== "none" ? (
          <button
            type="button"
            className="mg-composition-timeline-dismiss"
            onClick={() => commit(NO_INSPECTION)}
          >
            Clear
          </button>
        ) : null}
      </div>

      {axisStart || axisEnd ? (
        <figcaption className="mg-composition-timeline-caption">
          <span>{axisStart}</span>
          <span>{axisEnd}</span>
        </figcaption>
      ) : null}

      <ul className="mg-composition-timeline-key">
        {ordered.map((entry) => {
          const selected = inspectedSeries?.id === entry.id;
          return (
            <li key={entry.id}>
              <button
                type="button"
                className="mg-composition-timeline-key-item"
                data-tone={entry.residual ? "residual" : entry.tone}
                data-emphasis={
                  inspection.kind === "series" && !selected
                    ? "graphite"
                    : "vivid"
                }
                aria-pressed={selected}
                onPointerEnter={(event) => {
                  if (event.pointerType !== "touch") {
                    setHovered({ kind: "series", id: entry.id });
                  }
                }}
                onPointerLeave={(event) => {
                  if (event.pointerType !== "touch") setHovered(null);
                }}
                onClick={() =>
                  commit(
                    selected ? NO_INSPECTION : { kind: "series", id: entry.id },
                  )
                }
              >
                <i
                  aria-hidden="true"
                  data-tone={entry.residual ? "residual" : entry.tone}
                />
                <span>{entry.label}</span>
                {entry.residual ? <em>derived</em> : null}
              </button>
            </li>
          );
        })}
      </ul>

      <p className="sr-only" role="status" aria-live="polite">
        {liveSummary}
      </p>

      {/*
        The alternative representation. This genre routinely ships without one,
        which leaves the numbers reachable only by pointer; a real table means
        the chart is an instrument rather than the sole source of truth.

        It carries its own visually-hidden class rather than the shared
        `sr-only` utility, and that is not a style preference: `sr-only` hides
        by setting `width: 1px`, which a table simply ignores — its intrinsic
        column widths win — so the element kept a full-size layout box and
        tripped the responsive-overflow check at every viewport under 1280px.
        `table-layout: fixed` is what makes a table honour the declared width.
      */}
      <table className="mg-composition-timeline-data" id={tableId}>
        <caption>{tableCaption ?? ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {ordered.map((entry) => (
              <th key={entry.id} scope="col">
                {entry.label}
                {entry.residual ? " (derived)" : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {columns.map((column) => (
            <tr key={column.id}>
              <th scope="row">{column.label}</th>
              {ordered.map((entry) => (
                <td key={entry.id}>
                  {formatValue(column.shares[entry.id] ?? 0)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
