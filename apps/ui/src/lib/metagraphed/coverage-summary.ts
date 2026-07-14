export interface CoverageMissingSummary {
  /** Compact label, e.g. "5 missing" or "all present". */
  label: string;
  /** True when nothing is missing — drives the ok (vs. down) tone. */
  complete: boolean;
}

/**
 * Summarize a subnet's missing-kind count for the coverage matrix. Below `lg`
 * the matrix's kind columns (the real gaps) scroll off-screen, so the sticky
 * first column shows this instead — a mobile reader can tell a subnet has gaps
 * without blindly scrolling (#5310). Kept pure so the count/label mapping is
 * unit-tested apart from the DOM.
 */
export function coverageMissingSummary(missingCount: number): CoverageMissingSummary {
  const n = Number.isFinite(missingCount) ? Math.max(0, Math.floor(missingCount)) : 0;
  return n === 0
    ? { label: "all present", complete: true }
    : { label: `${n} missing`, complete: false };
}
