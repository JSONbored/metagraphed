// Keyword ranking shared by the MCP discovery tools (search_subnets,
// find_subnets_by_capability, find_subnet_for_task's keyword fallback). Pure and
// dependency-free so every call site ranks identically and it unit-tests
// directly. The AI semantic_search path is separate.
//
// Improvements over a raw substring haystack:
//   - word/prefix matching, so "ai" no longer matches "brain"/"domain";
//   - field weighting, so a name/slug hit outranks a deep token hit;
//   - boosts for an exact name/slug match and full term coverage.

// Identity (name, slug) outweighs secondary text (subtitle, tokens, categories).
const NAME_WEIGHT = 3;
const TEXT_WEIGHT = 1;
// A prefix hit ("infer" → "inference") counts, but less than a whole word.
const PREFIX_FACTOR = 0.5;
// Below this a term only matches whole words — a lone "a" must not prefix-explode.
const MIN_PREFIX_LENGTH = 2;
// A precise query — whole-query name/slug match, or every term landing — is a
// strong intent signal.
const EXACT_NAME_BOOST = 5;
const FULL_COVERAGE_BOOST = 2;
// Bound attacker-controlled query work on the public MCP search tools. Terms
// stay ordered for scoring/exact-match semantics, but duplicates are removed
// and only the first bounded set is considered.
export const MAX_QUERY_TERMS = 32;

// Lowercase alphanumeric terms. maxTerms caps the loop early so callers that
// bound attacker-controlled input avoid building an unbounded intermediate array.
// Document-side callers pass Infinity (default) to index the full field value.
function tokenize(value: unknown, maxTerms: number = Infinity): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const term of String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    if (term.length === 0 || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= maxTerms) break;
  }
  return terms;
}

// Capped variant for attacker-controlled query input. Breaks early after
// MAX_QUERY_TERMS so neither the loop nor the resulting array grow unbounded.
export function queryTerms(query: unknown): string[] {
  return tokenize(query, MAX_QUERY_TERMS);
}

// Distinct words across a list of field values (each a string or nullish).
function wordSet(values: unknown[]): Set<string> {
  const words = new Set<string>();
  for (const value of values) {
    for (const word of tokenize(value)) words.add(word);
  }
  return words;
}

// Weight of a term against a field: full for a whole word, PREFIX_FACTOR for a
// word prefix, 0 otherwise — never a mid-word substring (that kills "ai" → "brain").
function termWeight(term: string, words: Set<string>, weight: number): number {
  if (words.has(term)) return weight;
  if (term.length >= MIN_PREFIX_LENGTH) {
    for (const word of words) {
      if (word.length > term.length && word.startsWith(term)) {
        return weight * PREFIX_FACTOR;
      }
    }
  }
  return 0;
}

// Relevance of a document (identity name/slug + recall-only text) against
// pre-tokenized terms; 0 when nothing matches. Each term scores its strongest
// field — so a name hit isn't diluted by the same word in the token list — then
// the coverage and exact-match boosts apply.
export function keywordScore(
  { name, slug, text }: { name?: unknown; slug?: unknown; text?: unknown } = {},
  terms: string[],
): number {
  if (!Array.isArray(terms) || terms.length === 0) return 0;

  const nameTokens = tokenize(name);
  const slugTokens = tokenize(slug);
  const nameWords = new Set([...nameTokens, ...slugTokens]);
  const textWords = wordSet(Array.isArray(text) ? text : [text]);

  let score = 0;
  let matched = 0;
  for (const term of terms) {
    const best = Math.max(
      termWeight(term, nameWords, NAME_WEIGHT),
      termWeight(term, textWords, TEXT_WEIGHT),
    );
    if (best > 0) {
      score += best;
      matched += 1;
    }
  }
  if (score === 0) return 0;

  // Every term matched → a precise, fully-covered query.
  if (matched === terms.length) score += FULL_COVERAGE_BOOST;
  // Whole query equals the name or slug → almost certainly the intended target.
  const query = terms.join(" ");
  if (nameTokens.join(" ") === query || slugTokens.join(" ") === query) {
    score += EXACT_NAME_BOOST;
  }
  return score;
}
