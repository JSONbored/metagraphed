import type { ReactNode } from "react";
import { classNames } from "@/lib/format";

/**
 * The hero's one sentence (#11607): 16px ink-2 prose whose facts are inline
 * `<Fact>` chips (11px mono, `--layer`, 4px, tabular). Health and curation
 * states are words inside chips, never coloured badges.
 */
export function Fact({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={classNames("mg-fact-chip", className)}>{children}</span>
  );
}

export interface FactSentenceProps {
  children: ReactNode;
  className?: string;
}

export function FactSentence({ children, className }: FactSentenceProps) {
  return (
    <p className={classNames("mg-fact-sentence", className)}>{children}</p>
  );
}
