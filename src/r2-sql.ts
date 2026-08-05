// R2 SQL client — the read path over the chain lakehouse.
//
// WHY THIS EXISTS. The self-hosted Postgres served every chain-history route
// through Hyperdrive. With that box decommissioned those routes would degrade
// to schema-stable empties, which is honest but useless. The same data now
// lives in R2 Data Catalog (Iceberg), verified row-for-row against the box's
// frozen counts, and R2 SQL is the query engine over it.
//
// MEASURED CHARACTERISTICS, not assumed (probed live 2026-08-02):
//   blocks, ORDER BY DESC LIMIT 3   ~1.0-1.3s   24 files scanned
//   blocks, point lookup by height  ~1.9s       19 files
//   extrinsics, all rows in a block ~2.2s       884 files
// So this is a SECOND-scale engine, not a millisecond one: the beta prunes
// columns well but files poorly, so even a point lookup opens most of a
// table's parts. That is fine for an archival tier BEHIND an edge cache and
// wrong as a hot path -- which is exactly how the callers use it.
//
// RE-MEASURED 2026-08-05, end to end through the deployed Worker with the
// edge cache defeated, because the numbers above had aged into a misleading
// comment. Eight uncached runs of GET /api/v1/accounts/{ss58}/events for the
// top-balance account -- a filtered, ordered, LIMITed scan of account_events,
// no GROUP BY:
//   4.0s  4.0s  5.0s  5.6s  6.2s  8.7s   (limit=200)
//   5.6s  11.0s                          (limit=50)
// So a plain page of one account's events is a 4-11s read, not a ~2s one,
// with a ~2.7x spread run to run and no relationship to the page size. The
// engine's profile did not change; the table grew. Read the ceiling below
// against THESE numbers, not the 2026-08-02 ones -- and see #9459 for why the
// tail that crosses the ceiling could not be attributed to a specific query
// until this module started labelling its captures.
//
// Failure posture matches workers/postgres-tier.ts: ANY failure (missing
// token, HTTP error, malformed body, timeout) returns null so the caller
// degrades to the schema-stable empty it already has, never a 5xx. A tier
// that turns a slow archive query into a broken page would be worse than the
// empty it replaced.

import { recordExceptionEvent } from "./usage-telemetry.ts";
import { registerModuleStateReset } from "./module-state-registry.ts";

/** Personal/API token with R2 SQL read access (wrangler secret). */
export const R2_SQL_TOKEN_ENV = "R2_SQL_TOKEN";
/** Cloudflare account that owns the warehouse. */
export const R2_SQL_ACCOUNT_ENV = "R2_SQL_ACCOUNT_ID";
/** Warehouse name — the R2 BUCKET name, not the account-prefixed form the
 * wrangler CLI takes (confirmed live: the prefixed form 404s here). */
export const R2_SQL_WAREHOUSE_ENV = "R2_SQL_WAREHOUSE";

const DEFAULT_ACCOUNT = "918f0f0e2eb26709d1cf4fb76085c8fb";
const DEFAULT_WAREHOUSE = "metagraphed-lakehouse";

/**
 * Hard ceiling per query on the REQUEST path, so a genuinely stuck query
 * cannot pin a caller's request open.
 *
 * Sized when the worst measured read was ~2.2s, which made 15s a ~7x
 * headroom. The 2026-08-05 re-measurement above puts the same class of read
 * at 4-11s, so the headroom is now ~1.4x over the observed max, and a run-to-
 * run spread of ~2.7x means the tail crosses it — which is exactly the steady
 * AbortError stream #9459 is about.
 *
 * DELIBERATELY UNCHANGED HERE. Raising it is a caller-facing change to every
 * cold-tier route, and readers that issue two reads in sequence (e.g.
 * loadValidatorNominatorsColdTier's page + its true-count subquery) stack it,
 * so the number should be chosen against the query that actually aborts, not
 * against the one route probed above. That query is unidentifiable today —
 * every failure here captures under one flat `route: "r2-sql"` — which is why
 * this change ships the attribution first. #9423 is the precedent and the
 * caution both: the fix there WAS a bigger bound, and its own comment still
 * says a statement that cannot answer in time is a query to fix rather than
 * one to wait longer for.
 */
export const QUERY_TIMEOUT_MS = 15_000;

// Same contract as the Postgres tier's fallback generation: a caller can
// snapshot this before a read and compare after, so a degraded (empty) answer
// is never written into the edge cache as though it were real.
let r2SqlFailureGeneration = 0;

registerModuleStateReset("src/r2-sql.ts", () => {
  r2SqlFailureGeneration = 0;
});

export function currentR2SqlFailureGeneration(): number {
  return r2SqlFailureGeneration;
}

export interface R2SqlDeps {
  fetch?: typeof fetch;
  recordException?: typeof recordExceptionEvent;
  /**
   * Called with the engine's own explanation before a failed query returns null.
   *
   * Every failure mode here collapses to the same `null`, which is the right return
   * type -- a caller must not have to distinguish a timeout from a rejection to know
   * it has no rows. But the DIAGNOSIS is then discarded, and #9386 is what that
   * costs: /accounts/{ss58} declined ~50% of requests for a high-activity coldkey
   * with a typed 503 that could not say which of five concurrent reads failed, or
   * why. The message this receives already distinguishes them -- an HTTP status, a
   * numbered engine rejection (`40015: scan budget exceeded ...`), or an abort.
   *
   * Optional and side-effect-only, so no existing caller changes behaviour.
   */
  onError?: (detail: string) => void;
  /** Override the query ceiling. Tests use a tiny value so the abort path is
   * exercised in milliseconds rather than by waiting out the real ceiling. */
  timeoutMs?: number;
  /**
   * Schedule the abort. Defaults to a real `setTimeout`; returns its own
   * canceller so the caller need not know which timer primitive was used.
   *
   * Injectable because a real timer is not dependable in CI's shared-registry
   * pass (#9123). The abort test hung there until vitest killed it at 30s: the
   * fetch it stubs only settles on abort, so a timer that never fires leaves
   * nothing to end the promise. Same seam, and the same reason, as
   * src/webhooks.ts's `sleepFn` -- a real `setTimeout`, even at 1ms, has been
   * observed not firing in one shared-pass worker, with a fake-timer leak
   * investigated and ruled out.
   */
  scheduleAbort?: (abort: () => void, ms: number) => () => void;
}

interface R2SqlBody {
  result?: { rows?: unknown; metrics?: Record<string, unknown> } | null;
  success?: boolean;
  errors?: { code?: number; message?: string }[];
}

/** True when this deployment can talk to R2 SQL at all. */
export function isR2SqlConfigured(env: Env | null | undefined): boolean {
  const token = env?.[R2_SQL_TOKEN_ENV];
  return typeof token === "string" && token.trim().length > 0;
}

/** How much of a rejected query's body to keep in the thrown error. */
const MAX_REJECTION_DETAIL = 300;

/**
 * The engine's own explanation of a rejection, appended to the status.
 *
 * R2 SQL answers a refused query with a numbered, self-explaining message
 * (`40015: scan budget exceeded: scanning too much data for count(DISTINCT)
 * without GROUP BY` is the one that mattered here). Only the non-2xx arm threw
 * that message away; the `success: false` arm below has always surfaced it.
 * That asymmetry is why an account summary served zeros for every account
 * while the same table answered the /events route beside it, and why finding
 * out took a live tail rather than reading the log.
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
 * The lakehouse table a statement reads, e.g. `chain.account_events`.
 *
 * The coarse half of #9459's attribution: a bounded label (four tables times
 * two namespaces, per LAKEHOUSE_NAMESPACES) that an inbox can group and filter
 * by. The FIRST `FROM` is the right one even for the CTE and subquery shapes
 * this codebase builds — `SELECT count(*) FROM (SELECT coldkey FROM
 * chain.account_events ...)` names the derived table nowhere and the real one
 * once.
 *
 * Never throws and never returns empty: an unrecognised statement is reported
 * as `unknown` rather than omitted, so "we could not tell" stays visibly
 * distinct from "this capture predates attribution".
 */
export function r2SqlQueryKind(sql: string): string {
  const match =
    /\bFROM\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)/i.exec(sql);
  return match?.[1] ?? "unknown";
}

/**
 * The statement with its literals collapsed to `?`, whitespace flattened.
 *
 * The precise half of the attribution: the shape identifies the exact call
 * site, which the table alone cannot — a dozen readers query
 * `chain.account_events`, and the point of #9459 is to say WHICH one is slow.
 *
 * Collapsing is not only for cardinality. It removes the one class of value
 * that reaches a query here from outside (an ss58 address, a block height, a
 * hash — public chain data, but caller-supplied all the same), so what leaves
 * this module is a shape rather than a record of who looked up what. Length
 * is capped by sanitizeLabel in usage-telemetry.ts at the same 256 chars every
 * other free-form field gets; no second cap is invented here.
 *
 * String literals go first: they can contain digits, and collapsing numbers
 * first would leave `'0x1a2b'` half-rewritten. The number pass is anchored on
 * word boundaries so identifiers that merely contain digits (`net_flow_7d`,
 * `ss58`) survive intact — they are the diagnostic content, the same reason
 * normalizeExceptionMessage refuses to be a blanket hex-strip.
 */
export function r2SqlQueryShape(sql: string): string {
  return sql
    .replace(/'[^']*'/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Which failure this was, for the `error_code` property: `timeout`,
 * `http_<status>`, `engine_<code>` or `transport`.
 *
 * The other half of #9459's blocker. Timeouts, 429s, 422 scan-budget
 * rejections and 400s all arrive at the same catch and all captured as one
 * undifferentiated `r2-sql:Error`; PostHog even titled the aggregate issue
 * "HTTP 500" off one unrepresentative sample while the actual 500s numbered
 * two.
 *
 * The timeout arm reads the signal rather than sniffing the message, because
 * the abort's own text ("The operation was aborted") is the runtime's, not
 * ours, and has changed spelling across workerd versions before.
 */
function failureClassification(
  aborted: boolean,
  thrownCode: string | undefined,
): string {
  if (aborted) return "timeout";
  // No recorded code means the throw came from the transport (DNS, TLS, a
  // socket dropped mid-body) rather than from a response we inspected.
  return thrownCode ?? "transport";
}

/**
 * Run one read-only query and return its rows, or null on ANY failure.
 *
 * `sql` is built by the caller from validated, non-caller-controlled pieces —
 * this module deliberately does NOT interpolate user input, because R2 SQL has
 * no parameter binding and a string-built query over user input would be an
 * injection surface. Callers pass literal-safe values (integers they parsed,
 * hashes they regex-validated) and are responsible for that validation.
 */
export async function r2SqlQuery(
  env: Env | null | undefined,
  sql: string,
  deps: R2SqlDeps = {},
): Promise<Record<string, unknown>[] | null> {
  if (!isR2SqlConfigured(env)) {
    // Unconfigured is not a fault: self-hosters and local/CI runs simply have
    // no lakehouse, and the caller's existing empty payload is correct there.
    return null;
  }
  const doFetch = deps.fetch ?? globalThis.fetch;
  const account = env?.[R2_SQL_ACCOUNT_ENV] || DEFAULT_ACCOUNT;
  const warehouse = env?.[R2_SQL_WAREHOUSE_ENV] || DEFAULT_WAREHOUSE;
  const url = `https://api.sql.cloudflarestorage.com/api/v1/accounts/${account}/r2-sql/query/${warehouse}`;

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
  // Set at the throw site rather than parsed back out of the message in the
  // catch: the status and the engine's numbered code are both in hand here,
  // and a message-sniffing classifier is exactly the thing that goes stale.
  let thrownCode: string | undefined;
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${String(env?.[R2_SQL_TOKEN_ENV]).trim()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: sql, warehouse }),
      signal: abort.signal,
    } as RequestInit);
    if (!res?.ok) {
      thrownCode = `http_${res?.status}`;
      throw new Error(
        `r2 sql: HTTP ${res?.status}${await rejectionDetail(res)}`,
      );
    }
    const body = (await res.json()) as R2SqlBody;
    if (body?.success !== true) {
      const first = body?.errors?.[0];
      // `engine` unnumbered rather than `engine_undefined`: a rejection whose
      // body carried no code is a real, distinct state, not a missing field.
      thrownCode = first?.code ? `engine_${first.code}` : "engine";
      throw new Error(
        `r2 sql: ${first?.message ?? "query failed"}${first?.code ? ` (${first.code})` : ""}`,
      );
    }
    const rows = body?.result?.rows;
    // A successful query with no rows is a legitimate answer (no such block),
    // and must not be conflated with a failure — hence [] rather than null.
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  } catch (error) {
    r2SqlFailureGeneration += 1;
    const detail = String((error as Error)?.message ?? error);
    const errorCode = failureClassification(abort.signal.aborted, thrownCode);
    const queryKind = r2SqlQueryKind(sql);
    // Workers logs get the same attribution the exception does — #9459's
    // option 1 and option 2 are not alternatives, they cost nothing together,
    // and a tail is the one place you can read every occurrence rather than
    // one per storm-guard window.
    console.error("[r2-sql]", errorCode, queryKind, detail);
    // Reported before the exception hop, so a caller still learns the reason even if
    // the telemetry sink is unavailable -- the point of this seam is that the answer
    // must not depend on another service being up.
    try {
      deps.onError?.(detail);
    } catch {
      // A caller's own reporting must never turn a declined query into a thrown one.
    }
    await (deps.recordException ?? recordExceptionEvent)(env, {
      error,
      // Unchanged, and that is the point: `route` is the fingerprint input, so
      // every occurrence stays in the one issue it is in today. The three
      // fields below are properties only — see recordExceptionEvent for why
      // splitting the fingerprint would multiply billable volume instead.
      route: "r2-sql",
      errorCode,
      queryKind,
      queryShape: r2SqlQueryShape(sql),
    });
    return null;
  } finally {
    cancelAbort();
  }
}

/** A block height that is safe to inline into SQL: a real non-negative
 * integer and nothing else. Callers MUST route user input through this (or
 * an equivalent) rather than interpolating it, since R2 SQL takes no bound
 * parameters. */
export function safeBlockNumber(value: unknown): number | null {
  // Number() coerces null -> 0, "" -> 0, false -> 0 and true -> 1, every one
  // of which is a "valid" height. Without this guard a missing or malformed
  // parameter would silently resolve to block 0 (or 1) and serve the wrong
  // block confidently. Accept only a real number, or a string that is
  // entirely digits.
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) ? n : null;
}

/** An SS58 address that is safe to inline: only the base58 alphabet, at the
 * lengths Substrate addresses actually take. Refused rather than escaped, for
 * the same reason as the other literal guards here. */
export function safeSs58Literal(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^[1-9A-HJ-NP-Za-km-z]{47,49}$/.test(value) ? value : null;
}

/** A bare SQL identifier value (a pallet or call name). These reach a
 * string-built query as VALUES, not as identifiers, but the character set is
 * still constrained to what the chain actually emits so nothing else can be
 * smuggled through. */
export function safeNameLiteral(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : null;
}

/** A 0x-prefixed hex hash that is safe to inline. Anything else is refused
 * rather than escaped — this codebase's hashes are always plain hex, so a
 * value that is not is a bug or an attack, and neither should reach the
 * engine. */
export function safeHexLiteral(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^0x[0-9a-fA-F]{1,128}$/.test(value) ? value.toLowerCase() : null;
}
