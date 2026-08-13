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
// Failure posture matches workers/data-api-tier.ts: ANY failure (missing
// token, HTTP error, malformed body, timeout) returns null so the caller
// degrades to the schema-stable empty it already has, never a 5xx. A tier
// that turns a slow archive query into a broken page would be worse than the
// empty it replaced.

import { z } from "zod";
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

/**
 * How long to stop querying after the ACCOUNT-wide rate limit rejects us, as a
 * wrangler var in ms. Unset or malformed falls back to
 * `R2_SQL_RATE_LIMIT_COOLDOWN_DEFAULT_MS`; an explicit "0" disables the breaker.
 */
export const R2_SQL_RATE_LIMIT_COOLDOWN_MS_ENV =
  "R2_SQL_RATE_LIMIT_COOLDOWN_MS";

/** Long enough to outlast the limit's own window, short enough that a lane tick
 * 30 minutes later is never still suppressed by it. */
export const R2_SQL_RATE_LIMIT_COOLDOWN_DEFAULT_MS = 60_000;

/** The status R2 SQL answers an account-wide rejection with (engine code
 * 80014). Per ACCOUNT, not per Worker and not per query — which is why the
 * cooldown below is module-global rather than threaded through a caller. */
const RATE_LIMIT_STATUS = 429;

// Same contract as the Postgres tier's fallback generation: a caller can
// snapshot this before a read and compare after, so a degraded (empty) answer
// is never written into the edge cache as though it were real.
let r2SqlFailureGeneration = 0;

/**
 * When the account-wide cooldown expires; 0 when the breaker is closed.
 *
 * WHY A BREAKER AT ALL. 80014 is an ACCOUNT limit, so every caller in this
 * codebase shares one budget: ~44 request-time cold-tier entry points (several
 * fanning out 3-4 wide through `Promise.all`) plus the projection lanes' 148
 * queries per tick. Nothing retried a 429 — so the storm was never amplified by
 * retries — but nothing backed off either, so each rejection was followed
 * immediately by the next caller firing into the same exhausted budget, holding
 * the limit open and spending one `$exception` per attempt. 2026-08-04 cost
 * ~1,500 429s across two hours that way, against a ~100K/month error-tracking
 * allowance (#9465).
 *
 * Module-global to match the limit's scope. Per-isolate, so it is a pressure
 * valve rather than a guarantee: it cannot see rejections another isolate took,
 * and it is not trying to. Stopping ONE isolate's cron tick from issuing its
 * remaining ~140 doomed queries is the whole win.
 */
let r2SqlRateLimitedUntilMs = 0;

/**
 * How many CONSECUTIVE upstream 5xx open the outage breaker.
 *
 * Two, not one, and the difference is the whole point: a lone 500 is a blip
 * worth an exception, because it might be the first sign of a query this repo
 * needs to fix. Two in a row is an upstream that is down, and the 1,546 that
 * followed the first on 2026-08-03..10 said nothing the first had not (#10741).
 */
export const R2_SQL_OUTAGE_STREAK = 2;

/** Shorter than the rate-limit cooldown deliberately. A 429 has a budget that
 * genuinely needs a minute to refill; an upstream fault has no budget, so the
 * only thing this cooldown buys is not re-reporting -- and holding a whole tier
 * dark for a minute to save log lines is the wrong trade. */
export const R2_SQL_OUTAGE_COOLDOWN_MS = 15_000;

/** The status floor this module treats as "the far side broke, not us". */
const SERVER_ERROR_FLOOR = 500;

/**
 * The largest response body this client will buffer, in bytes.
 *
 * ## A ROW LIMIT IS NOT A BYTE LIMIT
 *
 * Every query here is bounded by `LIMIT`, and that bounds ROWS. It does not
 * bound bytes, because `chain.extrinsics.call_args` has no width: one
 * `set_weights` carries a weight per UID, and a `utility.batch` carries every
 * call inside it. A page of 200 such rows is not 200 small objects.
 *
 * On 2026-08-12 that produced a `TypeError: Memory limit exceeded before EOF`
 * from this exact query:
 *
 *     SELECT block_number, ..., call_args, observed_at FROM chain.extrinsics
 *     WHERE signer = ? ORDER BY ... LIMIT ?
 *
 * ## WHY A CAP AND NOT JUST A SMALLER LIMIT
 *
 * The module header promises "ANY failure (missing token, HTTP error,
 * malformed body, timeout) returns null so the caller degrades to the
 * schema-stable empty it already has, never a 5xx". An out-of-memory throw is
 * the one failure that does not keep that promise: it is raised by the
 * RUNTIME, not by a response this code inspected, and it does not decline one
 * query -- it kills the isolate, taking every unrelated request sharing it.
 *
 * A cap converts that into an ordinary decline this module already knows how
 * to report. Tuning `LIMIT` per caller would narrow the odds without closing
 * the hole, and the next unbounded column would reopen it.
 *
 * 8 MiB of RAW body against a 128 MB isolate. Deliberately far below the
 * ceiling rather than near it: the bytes are held once as chunks, again as a
 * decoded string, and a third time as parsed objects, so the resident cost of
 * a body is several times its wire size. Every legitimate result measured in
 * this repo is orders of magnitude under it -- the widest documented read is
 * the deregistrations lane's 33,386 rows over six narrow columns. Overridable
 * per-deployment via R2_SQL_MAX_BODY_BYTES, because the right number follows
 * the isolate's memory rather than this comment.
 */
export const R2_SQL_MAX_BODY_BYTES_ENV = "R2_SQL_MAX_BODY_BYTES";
export const R2_SQL_MAX_BODY_BYTES_DEFAULT = 8 * 1024 * 1024;

/**
 * The `error_code` a response too large to buffer reports.
 *
 * DELIBERATELY NOT an EXPECTED_FAILURE_CODE, for the same reason `http_422`
 * is not: this is correctness, not capacity. It says a query in THIS repo
 * asked for more than a page, and the error inbox is exactly where that
 * belongs. Filing it as expected would silence the only signal that an
 * unbounded column had started returning unbounded data.
 */
const BODY_TOO_LARGE_CODE = "body_too_large";

/**
 * Thrown by the capped reader, so the call site can tell "too big" from "not
 * JSON" by TYPE rather than by matching on a message. A string match would
 * reclassify itself the first time the wording changed.
 */
class R2SqlBodyTooLargeError extends Error {
  // Declared and assigned, NOT constructor parameter properties: this repo runs
  // .ts through Node's strip-only mode, which rejects that syntax outright.
  readonly received: number;
  readonly maxBytes: number;
  constructor(received: number, maxBytes: number) {
    super(
      `r2 sql: response exceeded ${maxBytes} bytes before EOF (${received} received) -- declining rather than buffering it`,
    );
    this.received = received;
    this.maxBytes = maxBytes;
    this.name = "R2SqlBodyTooLargeError";
  }
}

/**
 * When the upstream-outage cooldown expires; 0 when closed.
 *
 * A SEPARATE breaker from the rate-limit one, not a widened version of it. They
 * mean different things and must be able to be open at once: 429 says the
 * ACCOUNT budget is spent and backing off refills it, 5xx says R2 SQL itself is
 * failing and backing off changes nothing upstream. Collapsing them would let a
 * 15s outage cooldown clear a 60s rate-limit cooldown early.
 */
let r2SqlOutageUntilMs = 0;

/** Consecutive 5xx seen. Reset by ANY response that is not a 5xx -- including a
 * rejection, because a 429 or a 422 both prove the far side is answering. */
let r2SqlServerErrorStreak = 0;

registerModuleStateReset("src/r2-sql.ts", () => {
  r2SqlFailureGeneration = 0;
  r2SqlRateLimitedUntilMs = 0;
  r2SqlOutageUntilMs = 0;
  r2SqlServerErrorStreak = 0;
});

/** Milliseconds remaining on the upstream-outage cooldown, or 0 when closed. */
export function r2SqlOutageRemainingMs(nowMs: number = Date.now()): number {
  return Math.max(0, r2SqlOutageUntilMs - nowMs);
}

// Same contract as usage-telemetry's storm window: wrangler vars arrive as
// strings, and stating the shape once as a schema beats a typeof/isFinite
// ladder at each use. `.nonnegative()` rather than `.positive()` so an explicit
// "0" survives parsing as the disabled sentinel instead of being caught into
// the default -- an operator must be able to turn a safety valve off.
const RateLimitCooldownSchema = z.coerce
  .number()
  .finite()
  .nonnegative()
  .catch(R2_SQL_RATE_LIMIT_COOLDOWN_DEFAULT_MS);

function rateLimitCooldownMs(env: Env | null | undefined): number {
  const raw = env?.[R2_SQL_RATE_LIMIT_COOLDOWN_MS_ENV as keyof Env];
  // Absent coerces to NaN and an empty string to 0, which mean opposite things
  // here -- unset must take the default, while a deliberate "" is as much an
  // unset as `undefined` is. Both route to the default; only a real "0" disables.
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return R2_SQL_RATE_LIMIT_COOLDOWN_DEFAULT_MS;
  }
  return RateLimitCooldownSchema.parse(raw);
}

/** Milliseconds remaining on the account-wide cooldown, or 0 when closed.
 * Exported for tests and for a caller that wants to explain a degraded answer
 * without issuing a query to discover it. */
export function r2SqlRateLimitRemainingMs(nowMs: number = Date.now()): number {
  return Math.max(0, r2SqlRateLimitedUntilMs - nowMs);
}

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
  /**
   * The row schema to VALIDATE against, rather than cast to.
   *
   * `r2SqlQuery<ExtrinsicsRow>(...)` types the return and checks nothing: the
   * generated interfaces in generated/lakehouse/types.ts are a compile-time
   * claim about somebody else's engine. Pass the matching schema from
   * generated/lakehouse/schemas.ts -- same catalog snapshot, same generator --
   * and the claim is checked at the boundary where it can actually be wrong.
   *
   * A row that fails is a DECLINE, not a repair: the schemas are `.partial()`
   * (a query selects a subset) and `.loose()` (it also selects aggregates that
   * are not columns), so a rejection means a column arrived with a type the
   * catalog says it cannot have. Serving that as though it were data is how a
   * silent wrong number reaches a published figure.
   *
   * Optional, because 30 of the reads here select aggregates or hand-written
   * subsets and are migrated one at a time -- see
   * scripts/validate-untyped-lakehouse-reads.ts, the ratchet that counts them.
   */
  rowSchema?: { safeParse: (value: unknown) => { success: boolean } };
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
  /** Read the clock. Injectable for the same reason `scheduleAbort` is: the
   * breaker's open/expired branches are decided by elapsed time, and a test
   * that had to wait out a real cooldown would be a slow test that proves less. */
  now?: () => number;
}

/**
 * The engine's response envelope, PARSED rather than asserted.
 *
 * This used to be a hand-written interface behind a `JSON.parse(...) as
 * R2SqlBody` cast -- a shape this repo declared about somebody else's API and
 * then never checked. A cast is not a check: a body that had drifted, or an
 * HTML error page from a proxy, satisfied the compiler and reached the row
 * reader as `undefined` fields, which is how "no rows" and "we could not tell"
 * became the same answer.
 *
 * Loose on purpose -- unknown keys pass, because this is Cloudflare's envelope
 * and gaining a field is their business, not a fault here. What it pins is the
 * three fields this module actually reads, so a body that cannot answer them
 * is a classified decline instead of a silent empty.
 */
const R2SqlBodySchema = z.object({
  result: z
    .object({
      rows: z.unknown().optional(),
      metrics: z.record(z.string(), z.unknown()).optional(),
    })
    .nullish(),
  success: z.boolean().optional(),
  errors: z
    .array(
      z.object({ code: z.number().optional(), message: z.string().optional() }),
    )
    .optional(),
});
type R2SqlBody = z.infer<typeof R2SqlBodySchema>;

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

// Same shape as the cooldown knob above, and disabled the same way: a real
// "0" turns the cap off, because an operator must be able to open a safety
// valve they have decided is in the way.
const MaxBodyBytesSchema = z.coerce
  .number()
  .finite()
  .nonnegative()
  .catch(R2_SQL_MAX_BODY_BYTES_DEFAULT);

/** The body-size ceiling for this deployment, or 0 when disabled. */
export function maxBodyBytes(env: Env | null | undefined): number {
  const raw = env?.[R2_SQL_MAX_BODY_BYTES_ENV as keyof Env];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return R2_SQL_MAX_BODY_BYTES_DEFAULT;
  }
  return MaxBodyBytesSchema.parse(raw);
}

/**
 * Read a response body, refusing to buffer more than `maxBytes` of it.
 *
 * Counts what has ALREADY been received rather than trusting `Content-Length`:
 * the header is absent on a chunked response, and a body that lies about its
 * length is exactly the one worth stopping. Cancels the stream on the way out,
 * so a refused read does not keep pulling bytes nobody will look at.
 *
 * `Response.body` is nullable by spec, and `maxBytes <= 0` disables the cap.
 * Either way there is no stream to meter, so the body is taken whole -- a
 * response the runtime already materialised cannot be refused halfway through
 * something that has finished arriving.
 */
async function readCappedBody(
  res: Response,
  maxBytes: number,
): Promise<unknown> {
  const reader = maxBytes > 0 ? res.body?.getReader?.() : undefined;
  if (!reader) return await res.json();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new R2SqlBodyTooLargeError(total, maxBytes);
      chunks.push(value);
    }
  } finally {
    // Best-effort: the read already failed or finished, and a cancel that
    // throws must not replace the reason we are here.
    try {
      await reader.cancel();
    } catch {
      /* the stream is already done or errored */
    }
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(joined));
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
 * The `error_code` a query suppressed by the breaker reports.
 *
 * Sits alongside `failureClassification`'s vocabulary rather than inside it:
 * the others classify a rejection we actually received, and this one names a
 * query we deliberately never sent. Worth telling apart in a log — "we were
 * refused" and "we declined to ask" are different operational facts.
 */
const RATE_LIMITED_CODE = "rate_limited";

/** The `error_code` a query suppressed by the OUTAGE breaker reports.
 *
 * Distinct from `rate_limited` so a reader can tell which breaker declined:
 * "the account budget is spent" and "the engine is failing" call for different
 * responses, and one label for both would hide that. */
const UPSTREAM_DOWN_CODE = "upstream_down";

/**
 * The failure codes that are CAPACITY, not correctness (#9900).
 *
 * Each of these means the engine (or this module's own breaker) declined to
 * answer right now -- an account-level rate limit, a query that ran past its
 * ceiling, a call the breaker never sent. None of them indicates a defect in
 * this code, and between them they were ~49.5K events/month against a 100K
 * error-tracking free tier, measured 2026-08-03..04.
 *
 * They are still recorded, with identical attribution, as `usage_event`s
 * (`expected: true`) -- see ExceptionEvent.expected. An r2-sql rate-limit
 * storm remains just as visible; it stops being billed as an error.
 *
 * DELIBERATELY NOT LISTED: `http_422`. A scan-budget or malformed-query
 * rejection means a query in THIS repo needs fixing, which is precisely what
 * the error inbox is for -- and at ~7K/month it is affordable. Capacity and
 * correctness are different facts, and only one of them is somebody's bug.
 */
const EXPECTED_FAILURE_CODES: ReadonlySet<string> = new Set([
  "timeout",
  "http_429",
  RATE_LIMITED_CODE,
  // The query the OUTAGE breaker never sent. The 5xx responses themselves stay
  // OFF this list on purpose: a first 500 must still reach the inbox, because
  // it is the only thing that would tell us a query in this repo started
  // breaking the engine. It is the suppressed follow-ups that carry nothing.
  UPSTREAM_DOWN_CODE,
]);

/** Whether a classified r2-sql failure is an expected capacity condition. */
export function isExpectedR2SqlFailure(errorCode: string): boolean {
  return EXPECTED_FAILURE_CODES.has(errorCode);
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
/**
 * The shape an injected r2-sql reader must have.
 *
 * NOT `R2SqlReader`, now that the real one is generic. A generic
 * signature is not satisfied by the concrete stubs every loader test passes --
 * a double returning `Promise<Record<string, unknown>[] | null>` cannot stand
 * in for a function that promises `Row[]` for any `Row` the CALLER picks.
 *
 * The seam does not need that freedom: every loader that takes a `query` dep
 * reads the default row shape and narrows afterwards. `r2SqlQuery` itself is
 * assignable here, because its type parameter defaults.
 */
export type R2SqlReader = (
  env: Env | null | undefined,
  sql: string,
  deps?: R2SqlDeps,
) => Promise<Record<string, unknown>[] | null>;

export async function r2SqlQuery<Row = Record<string, unknown>>(
  env: Env | null | undefined,
  sql: string,
  deps: R2SqlDeps = {},
): Promise<Row[] | null> {
  if (!isR2SqlConfigured(env)) {
    // Unconfigured is not a fault: self-hosters and local/CI runs simply have
    // no lakehouse, and the caller's existing empty payload is correct there.
    return null;
  }
  const now = deps.now ?? Date.now;
  const outage = r2SqlOutageRemainingMs(now());
  if (outage > 0) {
    // The engine is failing, so this query cannot succeed. Decline WITHOUT the
    // exception hop, for the same reason the rate-limit branch below does: the
    // 5xx that opened this breaker already recorded one, and 1,546 identical
    // follow-ups said nothing it had not (#10741).
    r2SqlFailureGeneration += 1;
    const detail = `r2 sql: upstream unavailable, ${outage}ms of cooldown remaining`;
    console.error("[r2-sql]", UPSTREAM_DOWN_CODE, r2SqlQueryKind(sql), detail);
    try {
      deps.onError?.(detail);
    } catch {
      // A caller's own reporting must never turn a declined query into a thrown one.
    }
    return null;
  }
  const remaining = r2SqlRateLimitRemainingMs(now());
  if (remaining > 0) {
    // The account budget is known-exhausted, so this query cannot succeed and
    // issuing it would only hold the limit open longer. Decline WITHOUT the
    // exception hop: the 429 that opened the breaker already recorded one, and
    // recording another per suppressed query would rebuild the storm this
    // exists to stop -- in telemetry cost, if no longer in load.
    r2SqlFailureGeneration += 1;
    const detail = `r2 sql: account rate limited, ${remaining}ms of cooldown remaining`;
    // Same labelled log shape #9459 gave the failure path, for the same reason:
    // the tail is where every occurrence can be read, and a suppressed query is
    // exactly the one the exception stream deliberately will NOT show.
    console.error("[r2-sql]", RATE_LIMITED_CODE, r2SqlQueryKind(sql), detail);
    try {
      deps.onError?.(detail);
    } catch {
      // A caller's own reporting must never turn a declined query into a thrown one.
    }
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
      if ((res?.status ?? 0) >= SERVER_ERROR_FLOOR) {
        // Opened BEFORE the throw, exactly as the rate-limit branch is, so this
        // rejection records one exception and the callers behind it are
        // declined rather than each paying for their own.
        r2SqlServerErrorStreak += 1;
        if (r2SqlServerErrorStreak >= R2_SQL_OUTAGE_STREAK) {
          r2SqlOutageUntilMs = now() + R2_SQL_OUTAGE_COOLDOWN_MS;
        }
      } else {
        // ANY non-5xx response proves the far side is answering, so the streak
        // is not merely paused -- it is over.
        r2SqlServerErrorStreak = 0;
      }
      if (res?.status === RATE_LIMIT_STATUS) {
        // Opened BEFORE the throw, so the catch below records exactly one
        // exception for this rejection and every caller behind it is suppressed
        // by the breaker rather than each paying for its own.
        const cooldown = rateLimitCooldownMs(env);
        if (cooldown > 0) r2SqlRateLimitedUntilMs = now() + cooldown;
      }
      throw new Error(
        `r2 sql: HTTP ${res?.status}${await rejectionDetail(res)}`,
      );
    }
    r2SqlServerErrorStreak = 0;
    // Read through the cap rather than `res.json()`, which buffers whatever
    // arrives and hands an oversized body to the runtime to fail on. See
    // R2_SQL_MAX_BODY_BYTES_DEFAULT: the throw below is an ordinary decline,
    // where the out-of-memory it replaces killed the isolate.
    let parsed: unknown;
    try {
      parsed = await readCappedBody(res as Response, maxBodyBytes(env));
    } catch (err) {
      // The cap's own refusal is a distinct fact from a body that was not
      // JSON: one says the query asked for too much, the other that the far
      // side answered with something else.
      if (err instanceof R2SqlBodyTooLargeError) {
        thrownCode = BODY_TOO_LARGE_CODE;
        throw err;
      }
      thrownCode = "unparseable";
      throw new Error("r2 sql: response body was not JSON");
    }
    // safeParse, not a cast: see R2SqlBodySchema. A body that does not carry
    // the envelope becomes a decline the caller can read, where the cast made
    // it an empty result indistinguishable from a real one.
    const decoded = R2SqlBodySchema.safeParse(parsed);
    if (!decoded.success) {
      thrownCode = "unparseable";
      throw new Error(
        `r2 sql: response body did not match the engine envelope: ${decoded.error.issues[0]?.message ?? "unknown"}`,
      );
    }
    const body: R2SqlBody = decoded.data;
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
    if (!Array.isArray(rows)) return [];
    if (deps.rowSchema) {
      for (const row of rows) {
        if (deps.rowSchema.safeParse(row).success) continue;
        thrownCode = "row_schema";
        throw new Error(
          `r2 sql: a row did not match the catalog schema for ${r2SqlQueryKind(sql)}`,
        );
      }
    }
    return rows as Row[];
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
      // Capacity conditions (timeout, 429, breaker) are recorded as counted
      // usage events instead of exceptions -- same route, same error_code,
      // same query attribution, different product. See
      // EXPECTED_FAILURE_CODES for why 422 is pointedly absent.
      expected: isExpectedR2SqlFailure(errorCode),
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

/** A `YYYY-MM-DD` day that is safe to inline, refused rather than escaped like
 * every other guard here.
 *
 * SHAPE IS NOT ENOUGH, so this also checks the date EXISTS. `2026-02-31` and
 * `2026-13-01` both satisfy the obvious regex and neither is a day; round-
 * tripping through Date is what rejects them. A nonsense date reaching the
 * engine would not be an injection, but it would silently match no rows, and
 * "no rows" is indistinguishable from "no history" at the seam this feeds --
 * which is the failure mode the whole cold tier exists to avoid.
 *
 * Deliberately NOT a range check. The lakehouse's own floor moves, and pinning
 * a plausible window here would be a second seam constant to forget. */
export function safeIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const day = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return null;
  // Date rolls an out-of-range component over (Feb 31 -> Mar 3) rather than
  // failing, so the only way to know the input was a real day is to ask what
  // it came back as.
  return parsed.toISOString().slice(0, 10) === day ? day : null;
}
