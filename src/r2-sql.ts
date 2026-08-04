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

/** Hard ceiling per query. Deliberately well above the ~2.2s worst case
 * measured above, so an ordinary heavy scan is not mistaken for a fault,
 * while a genuinely stuck query still cannot pin a request open. */
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
      throw new Error(
        `r2 sql: HTTP ${res?.status}${await rejectionDetail(res)}`,
      );
    }
    const body = (await res.json()) as R2SqlBody;
    if (body?.success !== true) {
      const first = body?.errors?.[0];
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
    console.error("[r2-sql]", detail);
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
      route: "r2-sql",
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
