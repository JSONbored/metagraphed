// Workers Analytics Engine SQL client — the read path over the AE datasets.
//
// Deliberately the same shape as src/r2-sql.ts: a POST to an HTTP SQL
// endpoint, a hard query ceiling, an injectable abort scheduler, a failure
// generation counter, and null on ANY failure so a caller degrades to the
// answer it already had rather than 5xx-ing. Two engines, one failure
// posture, so a reviewer only has to learn it once.
//
// WHAT IS DIFFERENT FROM R2 SQL, and it matters at every call site:
//
//   AE SAMPLES. At high write volumes the engine stores a subset of data
//   points and exposes the rate through `_sample_interval`. A plain COUNT(*)
//   over a sampled dataset is therefore an UNDERCOUNT, silently and without
//   any signal in the response. Cloudflare's own guidance is the correction:
//   `sum(_sample_interval)` for counts, `sum(_sample_interval * doubleN)`
//   for sums, and the weighted quantile family for percentiles. Callers here
//   MUST use `sampledCount`/`sampledSum`/`sampledMean`/`weightedQuantile`
//   below rather than writing the raw aggregate, which is why those helpers
//   exist as exported functions instead of inline strings.
//
//   THE DIALECT IS SMALLER THAN IT LOOKS, AND FAILS OPAQUELY. AE accepts a
//   fixed function list; anything outside it is a 422 with no partial
//   success. There is no NULL literal, and no null-guard function at all --
//   `nullif`, `ifNull` and `coalesce` are all absent. That is why a mean is
//   computed as `sampledSum / sampledCount` in TypeScript rather than as a
//   guarded division in SQL: the guard cannot be expressed here, and the
//   unguarded form divides by zero on an empty window.
//
//   Function names are emitted in the exact spelling the reference documents
//   (lowercase `sum`/`max`/`now`, camelCase `sumIf`/`toUnixTimestamp`), and
//   `unsupportedAeFunctions` is the guard against reaching for a builtin that
//   reads as obviously available and is not.
//
//   THE SCHEMA IS POSITIONAL. There are no named columns: a dataset's rows
//   are blob1..blob20, double1..double20, index1, timestamp and
//   _sample_interval. The mapping from meaning to slot lives with the writer
//   (src/rpc-usage-capture.ts) and is imported here rather than retyped, so
//   the query and the write cannot drift into two different schemas.
//
//   THERE ARE NO BOUND PARAMETERS. Same hazard as R2 SQL, same rule: this
//   module never interpolates caller input, and every literal a caller
//   inlines must come from a validated, non-caller-controlled source.
import { recordExceptionEvent } from "./usage-telemetry.ts";
import { registerModuleStateReset } from "./module-state-registry.ts";

/**
 * Cloudflare API token with the `Account | Account Analytics | Read`
 * permission scope, the only scope the AE SQL API accepts.
 *
 * This is a NEW Worker secret; nothing else in this repo needs that scope
 * (the R2 SQL token is a different credential with a different permission).
 * Provision with:
 *
 *   npx wrangler secret put ANALYTICS_ENGINE_SQL_TOKEN
 *
 * Absent is not a fault -- see isAnalyticsSqlConfigured. Until it is
 * provisioned every AE read declines and /api/v1/rpc/usage keeps answering
 * from the lakehouse cold tier, exactly as it does today.
 */
export const ANALYTICS_SQL_TOKEN_ENV = "ANALYTICS_ENGINE_SQL_TOKEN";

/** Cloudflare account that owns the dataset. */
export const ANALYTICS_SQL_ACCOUNT_ENV = "ANALYTICS_ENGINE_SQL_ACCOUNT_ID";

/** The same account id src/r2-sql.ts defaults to -- one account owns both
 * engines. Repeated rather than imported so neither module's default becomes
 * load-bearing for the other. Not a secret: an account id is an identifier,
 * and the token is what grants access. */
const DEFAULT_ACCOUNT = "918f0f0e2eb26709d1cf4fb76085c8fb";

/**
 * Hard ceiling per query. Lower than r2-sql.ts's 15s on purpose: AE is a
 * columnar engine over a bounded retention window rather than an archival
 * scan over Iceberg files, and this client sits behind a request-time route.
 * A query that has not answered in five seconds is not going to make the
 * request useful.
 */
const QUERY_TIMEOUT_MS = 5_000;

// Same contract as the R2 SQL tier: a caller can snapshot this before a read
// and compare after, so a degraded (empty) answer is never written into the
// edge cache as though it were real.
let analyticsSqlFailureGeneration = 0;

registerModuleStateReset("src/analytics-engine-sql.ts", () => {
  analyticsSqlFailureGeneration = 0;
});

export function currentAnalyticsSqlFailureGeneration(): number {
  return analyticsSqlFailureGeneration;
}

export interface AnalyticsSqlDeps {
  fetch?: typeof fetch;
  recordException?: typeof recordExceptionEvent;
  /** Override the query ceiling. Tests use a tiny value so the abort path is
   * exercised in milliseconds rather than by waiting out the real ceiling. */
  timeoutMs?: number;
  /** Schedule the abort. Injectable for the same reason as r2-sql.ts's --
   * see that module's comment on why a real timer is not dependable in CI's
   * shared-registry pass. */
  scheduleAbort?: (abort: () => void, ms: number) => () => void;
}

/** The default FORMAT JSON envelope: `meta` (column names/types), `data`
 * (row objects) and a `rows` count. */
interface AnalyticsSqlBody {
  data?: unknown;
  rows?: number;
  meta?: unknown;
}

/** True when this deployment can talk to the AE SQL API at all. */
export function isAnalyticsSqlConfigured(env: Env | null | undefined): boolean {
  const token = env?.[ANALYTICS_SQL_TOKEN_ENV];
  return typeof token === "string" && token.trim().length > 0;
}

/** How much of a rejected query's body to keep in the thrown error. */
const MAX_REJECTION_DETAIL = 300;

/**
 * The engine's own explanation of a rejection, appended to the status.
 *
 * AE answers an invalid query with a plain-text body naming what it refused,
 * and discarding it is what let an unsupported builtin (`nullif`, which is in
 * neither AE's conditional nor its mathematical function set) 422 every hot
 * tier query in production while the route quietly fell through to the frozen
 * lakehouse. A bare `HTTP 422` said only that something was wrong; finding
 * WHICH something took a live tail and a walk through the SQL reference.
 *
 * Bounded, and never allowed to replace the status: a body we cannot read is
 * strictly less informative than the status we already have.
 */
async function rejectionDetail(
  res: { text?: () => Promise<string> } | null | undefined,
): Promise<string> {
  try {
    const text = (await res?.text?.())?.trim();
    return text ? `: ${text.slice(0, MAX_REJECTION_DETAIL)}` : "";
  } catch {
    return "";
  }
}

/**
 * Run one read-only query and return its rows, or null on ANY failure.
 *
 * Note the error shape difference from R2 SQL: the AE SQL API reports query
 * errors as a NON-2xx with a plain-text body, not as a 200 carrying
 * `success: false`. So the status check is the error check, and a 200 whose
 * body is not the documented JSON envelope is treated as a failure rather
 * than as an empty result -- an unparseable answer is not the same claim as
 * "no rows matched".
 */
export async function analyticsSqlQuery(
  env: Env | null | undefined,
  sql: string,
  deps: AnalyticsSqlDeps = {},
): Promise<Record<string, unknown>[] | null> {
  if (!isAnalyticsSqlConfigured(env)) {
    // Unconfigured is not a fault: local/CI runs and self-hosters have no AE
    // dataset, and the caller's existing fallback is correct there.
    return null;
  }
  const doFetch = deps.fetch ?? globalThis.fetch;
  const account = env?.[ANALYTICS_SQL_ACCOUNT_ENV] || DEFAULT_ACCOUNT;
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`;

  const abort = new AbortController();
  const scheduleAbort =
    deps.scheduleAbort ??
    ((fire: () => void, ms: number) => {
      const handle = setTimeout(fire, ms);
      return () => clearTimeout(handle);
    });
  const cancelAbort = scheduleAbort(
    () => abort.abort(),
    deps.timeoutMs ?? QUERY_TIMEOUT_MS,
  );
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${String(env?.[ANALYTICS_SQL_TOKEN_ENV]).trim()}`,
        // The API takes the query as the raw request body, not as JSON.
        "content-type": "text/plain",
      },
      body: sql,
      signal: abort.signal,
    } as RequestInit);
    if (!res?.ok) {
      throw new Error(
        `analytics engine sql: HTTP ${res?.status}${await rejectionDetail(res)}`,
      );
    }
    const body = (await res.json()) as AnalyticsSqlBody;
    const rows = body?.data;
    if (!Array.isArray(rows)) {
      throw new Error("analytics engine sql: response had no data array");
    }
    // A successful query with no rows is a legitimate answer (an untouched
    // window), and must not be conflated with a failure -- hence [].
    return rows as Record<string, unknown>[];
  } catch (error) {
    analyticsSqlFailureGeneration += 1;
    console.error(
      "[analytics-engine-sql]",
      String((error as Error)?.message ?? error),
    );
    await (deps.recordException ?? recordExceptionEvent)(env, {
      error,
      route: "analytics-engine-sql",
    });
    return null;
  } finally {
    cancelAbort();
  }
}

// --- sampling-aware aggregate builders --------------------------------------
//
// Every one of these exists so a caller cannot accidentally write the raw
// aggregate. On an unsampled dataset the raw and corrected forms agree, which
// is precisely what makes the mistake invisible until traffic grows enough
// for AE to start sampling -- at which point every number quietly shrinks.

/** True event count: each stored row stands for `_sample_interval` events. */
export function sampledCount(): string {
  return "sum(_sample_interval)";
}

/** True count of the events matching `predicate`. */
export function sampledCountIf(predicate: string): string {
  return `sumIf(_sample_interval, ${predicate})`;
}

/** True sum of a numeric column across the events it stands for. */
export function sampledSum(column: string): string {
  return `sum(_sample_interval * ${column})`;
}

/**
 * Sampling-corrected mean, computed HERE rather than in SQL.
 *
 * This used to be `sampledSum(col) / nullif(sampledCount(), 0)`, and that
 * expression 422'd every query it appeared in: AE has no `nullif`, no
 * `ifNull`, no `coalesce`, and no NULL literal to feed them, so an empty
 * window simply cannot be guarded engine-side. Dropping the guard is not the
 * alternative -- an unguarded `x / 0` yields a non-finite value that has no
 * JSON representation, which trades a loud failure for a corrupt payload.
 *
 * So the query selects the numerator (`sampledSum`) alongside the count it
 * already selects, and the division happens where `null` is expressible and
 * means exactly what the route publishes: not measured.
 *
 * Null for an empty window, a non-finite input, or a negative count -- never
 * a number derived from nothing.
 */
export function sampledMean(sum: unknown, count: unknown): number | null {
  const n = Number(count);
  const s = Number(sum);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (!Number.isFinite(s)) return null;
  return s / n;
}

/**
 * Every function Analytics Engine documents, by family.
 *
 * Transcribed from the SQL reference (verified 2026-08-03). This exists
 * because AE's dialect looks like ClickHouse and is a strict, much smaller
 * subset of it: the functions a SQL author reaches for by reflex -- `nullif`,
 * `coalesce`, `ifNull`, `CASE` -- are simply absent, and reaching for one
 * costs a 422 on EVERY query that carries it, with no partial success and,
 * before this change, no message saying which name was refused.
 *
 * A name missing from this list is not proof it is unsupported; it is proof
 * nobody verified it. Check the reference, then add it here in the same
 * change that uses it -- that is the point of the list.
 */
export const AE_SUPPORTED_FUNCTIONS: ReadonlySet<string> = new Set([
  // Aggregate
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "quantileExactWeighted",
  "quantileWeighted",
  "argMax",
  "argMin",
  "first_value",
  "last_value",
  "topK",
  "topKWeighted",
  "countIf",
  "sumIf",
  "avgIf",
  // Conditional -- `if` is the ONLY one. No nullif, ifNull, coalesce, CASE.
  "if",
  // Date and time
  "formatDateTime",
  "now",
  "today",
  "toDateTime",
  "toYear",
  "toMonth",
  "toDayOfWeek",
  "toDayOfMonth",
  "toHour",
  "toMinute",
  "toSecond",
  "toUnixTimestamp",
  "toStartOfInterval",
  "toStartOfYear",
  "toStartOfMonth",
  "toStartOfWeek",
  "toStartOfDay",
  "toStartOfHour",
  "toStartOfFifteenMinutes",
  "toStartOfTenMinutes",
  "toStartOfFiveMinutes",
  "toStartOfMinute",
  "toYYYYMM",
  // Mathematical
  "intDiv",
  "log",
  "pow",
  "round",
  "floor",
  "ceil",
  // String
  "length",
  "empty",
  "lower",
  "lowerUTF8",
  "upper",
  "upperUTF8",
  "startsWith",
  "endsWith",
  "position",
  "substring",
  "format",
  "extract",
  // Type conversion
  "toUInt8",
  "toUInt32",
  // Bit
  "bitAnd",
  "bitCount",
  "bitHammingDistance",
  "bitNot",
  "bitOr",
  "bitRotateLeft",
  "bitRotateRight",
  "bitShiftLeft",
  "bitShiftRight",
  "bitTest",
  "bitXor",
  // Encoding
  "bin",
  "hex",
]);

/**
 * The function names a query calls that AE does not document.
 *
 * A call is an identifier immediately followed by `(`, which is what makes
 * this precise rather than a substring hunt: a column or alias containing the
 * text `count` is not a call, and is not reported. SQL keywords that take
 * parenthesised arguments are excluded for the same reason -- they are
 * syntax, not functions.
 */
export function unsupportedAeFunctions(sql: string): string[] {
  const found = new Set<string>();
  for (const [, name] of sql.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    if (AE_SUPPORTED_FUNCTIONS.has(name)) continue;
    if (AE_SQL_KEYWORDS.has(name.toUpperCase())) continue;
    found.add(name);
  }
  return [...found].sort();
}

/** Parenthesised syntax, not callable functions. */
const AE_SQL_KEYWORDS: ReadonlySet<string> = new Set([
  "AND",
  "AS",
  "BY",
  "FROM",
  "GROUP",
  "IN",
  "NOT",
  "OR",
  "SELECT",
  "WHERE",
  "HAVING",
  "ORDER",
  "LIMIT",
  "ON",
  "OVER",
  "INTERVAL",
]);

/**
 * A REAL percentile, weighted by the sampling interval.
 *
 * `quantileExactWeighted(q)(column, weight)` is AE's documented parametric
 * form; passing `_sample_interval` as the weight is what makes the result a
 * percentile of the underlying events rather than of the stored sample. This
 * is the capability the lakehouse tier does not have -- R2 SQL has no
 * percentile function at all, which is why src/rpc-usage-cold-tier.ts
 * declines p50/p95 instead of inventing them.
 */
export function weightedQuantile(q: number, column: string): string {
  // The level is a module-local literal in every call site, never caller
  // input; the guard is here so it cannot become one by refactor.
  if (!Number.isFinite(q) || q <= 0 || q >= 1) {
    throw new Error(`weightedQuantile: level must be in (0,1), got ${q}`);
  }
  return `quantileExactWeighted(${q})(${column}, _sample_interval)`;
}
