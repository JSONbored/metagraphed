import { ApiError } from "@/lib/metagraphed/client";
import type { AskCitation } from "@/lib/metagraphed/types";

/**
 * The labels and the error sentence for an `/api/v1/ask` answer.
 *
 * This was `ask-box.tsx`, a whole answer panel with its own form, mutation and
 * citation rows. The command palette renders the answer itself (#11626) and
 * imported only these four pure functions from it, so #11628 kept the four and
 * dropped the panel -- what is left is a `.ts` module of strings, not a
 * component.
 */

/** Distinguishes a 429 (rate-limited) and 503 (AI disabled/unavailable) ask rejection from a generic failure. */
export function describeAskError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return "Rate-limited — try again shortly.";
    if (error.status === 503) return error.message || "AI is temporarily unavailable.";
    return error.message || "Couldn't get an answer — try again.";
  }
  return "Couldn't get an answer — try again.";
}

/** Relevance score (0-1 per the ask-answer schema) as a rounded percentage; "—" for a non-finite/out-of-range value. */
export function formatScore(score: number): string {
  return Number.isFinite(score) && score >= 0 && score <= 1 ? `${Math.round(score * 100)}%` : "—";
}

/** A citation's display title, falling back to its 1-based ref when the registry has no title. */
export function citationLabel(citation: AskCitation): string {
  return citation.title ?? `Citation ${citation.ref}`;
}

/** The netuid + score meta string next to a citation, omitting the netuid segment when it's null. */
export function citationMeta(citation: AskCitation): string {
  const netuidPrefix = citation.netuid != null ? `SN${citation.netuid} · ` : "";
  return `${netuidPrefix}${formatScore(citation.score)}`;
}

/** "N source(s) · model" meta line, singular/plural correct at exactly 1. */
export function sourceCountLabel(contextCount: number, model: string): string {
  return `${contextCount} source${contextCount === 1 ? "" : "s"} · ${model}`;
}
