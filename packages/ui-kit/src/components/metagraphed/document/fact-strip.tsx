import type { ReactNode } from "react";
import { classNames } from "@/lib/format";
import { Definition } from "../interaction/definition";

/**
 * A single row of 2–6 bordered cells (#11607): label 11px muted, value 28px
 * mono 500 ink tabular, optional delta chip. Shared edges, no gap, 4px radius
 * on the outer box only. No icon, no sparkline, no per-cell "updated", no hint
 * line. `<dl>` semantics. `grid` is the 3×2 variant for a six-number answer.
 */
export interface FactCellData {
  label: string;
  value: ReactNode;
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
  return (
    <dl
      className={classNames("mg-facts", className)}
      data-variant={variant}
      data-count={cells?.length}
    >
      {cells?.map((cell) => (
        <FactCell key={cell.label} {...cell} />
      ))}
      {children}
    </dl>
  );
}

export interface FactCellProps extends FactCellData {
  /** A one-sentence definition of the label, shown as a `Definition` beside it. */
  hint?: ReactNode;
  className?: string;
}

/** One cell of a `FactStrip`. */
export function FactCell({
  label,
  value,
  delta,
  hint,
  className,
}: FactCellProps) {
  return (
    <div className={classNames("mg-fact", className)}>
      <dt>
        {label}
        {typeof hint === "string" ? (
          <Definition term={label} sentence={hint} />
        ) : null}
      </dt>
      <dd>
        <span className="mg-fact-value">{value}</span>
        {delta ? (
          <span className="mg-fact-delta" data-tone={delta.tone}>
            {delta.text}
          </span>
        ) : null}
      </dd>
    </div>
  );
}
