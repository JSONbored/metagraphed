// Per-validator nominator counts served from the lakehouse (#9146).
//
// `nominator_count` was null on EVERY validator on /api/v1/validators and
// /api/v1/validators/{hotkey} (verified live 2026-08-03). The field comes from
// the validator_nominator_counts side table, which was Postgres-only: when the
// neurons family moved to D1 its twins had no such table to read, so
// workers/data-api.ts passes buildGlobalValidators an empty map and
// buildValidatorDetail a null count, and every card serves "unknown".
//
// The table itself survived the box -- chain.validator_nominator_counts, 112,550
// rows of (hotkey, nominator_count, captured_at). Reading it here rather than in
// data-api's D1 twin is not a preference: R2_SQL_TOKEN is bound to the MAIN
// Worker (see wrangler.jsonc), not to metagraphed-data-api, so the lakehouse is
// only reachable from the serving side. That is also why this is an overlay on
// an already-built payload rather than a builder argument -- see
// src/validator-nominator-summary.ts's own note.
//
// LATEST-ONLY PER HOTKEY. Postgres held this table at PRIMARY KEY (hotkey),
// REPLACE-on-conflict, so a hotkey had exactly one row; the Iceberg mirror has
// no such constraint and may carry more than one capture generation. A plain
// equality read would therefore hand the formatter duplicate hotkeys and let
// Map.set pick whichever the engine returned last -- an arbitrary, possibly
// stale count presented as current. The group-wise MAX on captured_at is
// correct under BOTH shapes: a no-op when there is genuinely one row, and the
// current capture when there is not.
//
// Failure posture is the family's: any decline returns the payload untouched,
// so the field stays null exactly as it is today. A degraded count is worse
// than no count, because a card cannot tell its reader which one it got.

import {
  nominatorCountsByHotkey,
  overlayNominatorCounts,
  validatorHotkeysNeedingCount,
} from "./validator-nominator-summary.ts";
import { r2SqlQuery, safeSs58Literal } from "./r2-sql.ts";
import { GLOBAL_VALIDATOR_LIMIT_MAX } from "./route-limits.ts";

/**
 * Hotkeys per query.
 *
 * R2 SQL takes no bound parameters, so the hotkey filter is an inlined IN list
 * and its size is the query's size: the validators directory fetches
 * `?limit=2000` (apps/ui's SSR path does exactly this), and 2,000 inlined SS58
 * literals is a ~100KB statement. Chunking keeps each statement ~13KB and the
 * fan-out at 8 parallel reads for the largest page the route can serve, instead
 * of betting the whole enrichment on one oversized query.
 */
export const NOMINATOR_COUNT_HOTKEY_CHUNK = 250;

/** The columns the shared formatter reads, kept to its exact field names. */
const COUNT_COLUMNS = "hotkey, nominator_count, captured_at";

/**
 * The newest row per hotkey for one chunk.
 *
 * ROW_NUMBER() over a per-hotkey partition rather than a MAX/JOIN pair so the
 * inlined IN list appears once: repeating it would double the statement size
 * and give the two halves a chance to disagree. Every value inlined here has
 * passed safeSs58Literal -- refused, never escaped.
 */
function latestCountsSql(hotkeys: readonly string[]): string {
  const list = hotkeys.map((hotkey) => `'${hotkey}'`).join(", ");
  return (
    `SELECT hotkey, nominator_count FROM (` +
    `SELECT ${COUNT_COLUMNS},` +
    ` ROW_NUMBER() OVER (PARTITION BY hotkey ORDER BY captured_at DESC) AS rn` +
    ` FROM chain.validator_nominator_counts WHERE hotkey IN (${list})` +
    `) WHERE rn = 1`
  );
}

/**
 * hotkey -> nominator_count for the given hotkeys, or null when the lakehouse
 * cannot answer.
 *
 * Unusable hotkeys are DROPPED rather than declining the whole read: they reach
 * a string-built query, so they must pass the SS58 guard, but one bad address in
 * a page of a thousand should cost that address its count, not everyone else's.
 * A page with no usable hotkey at all resolves to an empty map without touching
 * the engine -- an empty IN list is not a query worth sending.
 *
 * Rows go through nominatorCountsByHotkey, the same formatter the Postgres tier
 * fed, so the null/negative/non-integer handling is not restated here.
 */
export async function loadValidatorNominatorCountsColdTier(
  env: Env | null | undefined,
  hotkeys: readonly unknown[],
  { query = r2SqlQuery }: { query?: typeof r2SqlQuery } = {},
): Promise<Map<string, number> | null> {
  const safe: string[] = [];
  const seen = new Set<string>();
  for (const candidate of Array.isArray(hotkeys) ? hotkeys : []) {
    // Capped at the ceiling the widest route can actually serve, so an
    // unexpected caller cannot turn this into an unbounded fan-out.
    if (safe.length >= GLOBAL_VALIDATOR_LIMIT_MAX) break;
    const hotkey = safeSs58Literal(candidate);
    if (hotkey === null || seen.has(hotkey)) continue;
    seen.add(hotkey);
    safe.push(hotkey);
  }
  if (safe.length === 0) return new Map();

  const chunks: string[][] = [];
  for (let i = 0; i < safe.length; i += NOMINATOR_COUNT_HOTKEY_CHUNK) {
    chunks.push(safe.slice(i, i + NOMINATOR_COUNT_HOTKEY_CHUNK));
  }
  const results = await Promise.all(
    chunks.map((chunk) => query(env, latestCountsSql(chunk))),
  );

  // One failed chunk declines the WHOLE read. Keeping the chunks that did
  // answer would serve a page where the presence of a count depends on where a
  // hotkey happened to fall in the batching -- an invisible, unreproducible
  // split between "no nominators recorded" and "we did not ask".
  const rows: Record<string, unknown>[] = [];
  for (const result of results) {
    if (result === null) return null;
    rows.push(...result);
  }
  return nominatorCountsByHotkey(rows);
}

/**
 * Fill `nominator_count` on an already-built validator payload -- the
 * leaderboard or one hotkey's detail -- from the lakehouse.
 *
 * The single entry point every serving surface calls, so REST, MCP and GraphQL
 * cannot drift onto different reads of the same field. Returns `data`
 * unchanged whenever there is nothing to ask for or the lakehouse declines,
 * which is what keeps this additive: the caller's existing payload is always
 * the floor.
 */
export async function enrichValidatorNominatorCounts<T>(
  env: Env | null | undefined,
  data: T,
  {
    load = loadValidatorNominatorCountsColdTier,
  }: { load?: typeof loadValidatorNominatorCountsColdTier } = {},
): Promise<T> {
  const hotkeys = validatorHotkeysNeedingCount(data);
  if (hotkeys.length === 0) return data;
  const counts = await load(env, hotkeys);
  if (counts === null) return data;
  return overlayNominatorCounts(data, counts);
}
