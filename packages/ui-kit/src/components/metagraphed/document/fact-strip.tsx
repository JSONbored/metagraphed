import { Children, type ReactNode } from "react";
import { classNames } from "@/lib/format";
import { Definition } from "../interaction/definition";

/**
 * KEEP THE LABEL SHORT. The "?" carries the detail, so the label does not have
 * to: "Candidates" over a tooltip that says "discovered surfaces queued for a
 * human to accept or reject" beats "Candidates awaiting review", which wrapped
 * to three lines in a 145px card on a phone while its neighbours took two, and
 * made the strip ragged (#11696). Roughly seventeen characters fit one line at
 * 375px, and the "?" takes a word's worth of the last one.
 *
 * A single row of 2–6 bordered cells (#11607): label 11px muted, value 28px
 * mono 500 ink tabular, optional delta chip. Shared edges, no gap, 4px radius
 * on the outer box only. No icon, no sparkline, no per-cell "updated", no hint
 * line. `<dl>` semantics. `grid` is the 3×2 variant for a six-number answer.
 */
export interface FactCellData {
  label: string;
  value: ReactNode;
  /**
   * A compact text reading (a service verdict, endpoint or transport) rather
   * than an instrument figure. Metrics stay mono and 28px; text stays legible
   * in a narrow cell instead of truncating like a very large number.
   */
  kind?: "text";
  /**
   * The value is still being read. A pending instrument must not look like a
   * measured zero or an unavailable value: those are three different states.
   */
  loading?: boolean;
  /**
   * An evidence-derived state for a fact. A tone is deliberately opt-in: a
   * metric does not become good or bad merely because it is large or small.
   */
  tone?: "good" | "warn" | "bad";
  /** A signed change shown right of the value; `tone` colours it. */
  delta?: { text: string; tone: "good" | "bad" | "neutral" };
}

/** 2 to 6 cells, enforced by the tuple type. */
export type FactCells =
  | readonly [FactCellData, FactCellData]
  | readonly [FactCellData, FactCellData, FactCellData]
  | readonly [FactCellData, FactCellData, FactCellData, FactCellData]
  | readonly [
      FactCellData,
      FactCellData,
      FactCellData,
      FactCellData,
      FactCellData,
    ]
  | readonly [
      FactCellData,
      FactCellData,
      FactCellData,
      FactCellData,
      FactCellData,
      FactCellData,
    ];

export interface FactStripProps {
  /** The cells, 2–6. Or compose `<FactCell>` children (routes mid-migration). */
  cells?: FactCells;
  children?: ReactNode;
  variant?: "row" | "grid";
  className?: string;
}

export function FactStrip({
  cells,
  children,
  variant = "row",
  className,
}: FactStripProps) {
  // Some migration-era callers still compose FactCell children. Treat their
  // count the same way as the `cells` shorthand so the mobile layout can make
  // an intentional choice about a two-reading grid versus a scrollable rail.
  const count = cells?.length ?? Children.count(children);
  return (
    <dl
      className={classNames("mg-facts", className)}
      data-variant={variant}
      data-count={count || undefined}
    >
      {cells?.map((cell) => (
        <FactCell key={cell.label} {...cell} />
      ))}
      {children}
    </dl>
  );
}

export interface FactCellProps extends FactCellData {
  /** Overrides the glossary sentence for this label. */
  hint?: string;
  className?: string;
}

/** One cell of a `FactStrip`. */
export function FactCell({
  label,
  value,
  kind,
  loading = false,
  tone,
  delta,
  hint,
  className,
}: FactCellProps) {
  return (
    <div className={classNames("mg-fact", className)} data-tone={tone}>
      <dt>
        {label}
        {/* The "?" appears wherever the GLOSSARY has a sentence for this
            label -- no call site has to remember to ask for it, and adding a
            definition is a one-line edit that lights up every card using that
            label at once. `Definition` renders nothing for a term it has no
            sentence for, so an undefined label is simply a card without a
            help affordance rather than an empty button (#11696). */}
        <Definition term={label} sentence={hint} />
      </dt>
      <dd aria-busy={loading || undefined}>
        {loading ? (
          <>
            <span className="mg-fact-loading" aria-hidden="true" />
            <span className="sr-only">Loading {label}</span>
          </>
        ) : (
          <span
            className={classNames(
              "mg-fact-value",
              kind === "text" && "mg-fact-value--text",
            )}
          >
            {value}
          </span>
        )}
        {!loading && delta ? (
          <span className="mg-fact-delta" data-tone={delta.tone}>
            {delta.text}
          </span>
        ) : null}
      </dd>
    </div>
  );
}
