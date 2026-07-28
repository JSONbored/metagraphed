// #8381: pure query-classification helpers for the omnibox's Ask mode.
// Detection is deliberately presentation-only (per the issue's own
// requirement 1) -- these functions only decide whether/how prominently the
// "Ask" row is offered; they never suppress or replace entity search, which
// always runs regardless of what these return.

const INTERROGATIVE_STARTERS = /^(who|what|which|how|why|when|is|are|does|can)\b/i;

/** Ends with "?", or opens with a common question word. */
export function isQuestionLike(query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  return q.endsWith("?") || INTERROGATIVE_STARTERS.test(q);
}

const MIN_WORDS_FOR_ASK_ROW = 4;

/**
 * Whether the omnibox should offer the "Ask" row at all -- a clear question
 * (any length), OR any query long enough (>=4 words) that it reads more like
 * a natural-language request than an entity name/keyword, per requirement 1.
 */
export function shouldShowAskRow(query: string): boolean {
  const q = query.trim();
  if (!q) return false;
  if (isQuestionLike(q)) return true;
  return q.split(/\s+/).filter(Boolean).length >= MIN_WORDS_FOR_ASK_ROW;
}
