// Where a request's milliseconds actually went, as `Server-Timing`.
//
// ## Why this exists
//
// Optimising these routes on 2026-08-16 meant guessing. `/accounts/{ss58}`
// issues 28 requests across three storage layers -- an R2 artifact, Neon, and
// R2 SQL over Iceberg -- and NOTHING said which one a given millisecond
// belonged to. The same request measured 1.8s and 8.8s twenty minutes apart,
// and the tell that it was not the code came from a route nobody had touched:
// `/blocks/{ref}` moved 0.196s -> 4.65s in the same window, because the shared
// Neon compute was contended. Three separate optimisations were made against
// end-to-end numbers that could not distinguish any of that.
//
// A cache hit is 0.12s and a cold read is seconds; between those two facts sit
// three storage layers and no measurement. This is the measurement.
//
// ## Why the BOUNDARIES and not the routes
//
// Instrumenting handlers would mean touching every one of them and remembering
// to on the next -- the same argument `withEdgeCache`, `dataRouteRateLimit` and
// `labelDegradedResponse` all make for living at the dispatch point. There are
// exactly three places a request can spend real time here, and each has ONE
// function in front of it:
//
//   neon    `pgReadStore`'s runner      src/read-store.ts
//   r2sql   `r2SqlQuery`                src/r2-sql.ts
//   r2      the projection's `readJson` src/account-summary-projection.ts
//
// Instrument those and every route -- including ones written next year -- is
// covered without its author doing anything.
//
// The tier that answered falls out of the same data rather than needing a
// mechanism of its own: `r2sql;count=0` beside `neon;count=2` IS "served from
// the hot tier", and no separate header can disagree with it.
//
// ## AsyncLocalStorage, and why it is safe here
//
// `nodejs_compat` is on, so the store is native. It is what lets a counter deep
// in `r2SqlQuery` attribute to the right request without threading a context
// through forty call sites -- the exact cost src/tracing.ts's header cites as
// its reason for NOT nesting spans.
//
// The alternative in this repo is `degradedSnapshot`'s module-global
// counter-and-diff, which documents that a concurrent request can label this
// one. That trade is defensible for a boolean that errs safe; it is not
// defensible for a number, where cross-request bleed does not degrade the
// answer, it invents one.
//
// ## Cost when nobody is looking
//
// `mark` outside a request scope is a map lookup returning undefined, and
// `timed` still awaits its callback. No allocation per call, no header emitted
// when nothing was measured.
import { AsyncLocalStorage } from "node:async_hooks";

/** One boundary's tally for one request. */
export interface TimingMark {
  /** Total wall time across every call, in milliseconds. */
  durationMs: number;
  /** How many calls -- the number that names the TIER that answered. */
  count: number;
}

const store = new AsyncLocalStorage<Map<string, TimingMark>>();

/**
 * Run `fn` with a fresh timing scope.
 *
 * Nested calls REUSE the outer scope rather than shadowing it, so a handler
 * that wraps itself does not silently drop the marks its caller collected.
 */
export function withRequestTiming<T>(fn: () => Promise<T>): Promise<T> {
  if (store.getStore()) return fn();
  return store.run(new Map(), fn);
}

/** Add `ms` to a boundary's tally. A no-op outside a request scope. */
export function mark(name: string, ms: number): void {
  const marks = store.getStore();
  if (!marks) return;
  const existing = marks.get(name);
  if (existing) {
    existing.durationMs += ms;
    existing.count += 1;
    return;
  }
  marks.set(name, { durationMs: ms, count: 1 });
}

/**
 * Time `fn` under `name`, whatever it does.
 *
 * THE TIMER RUNS ON THE FAILURE PATH TOO. A boundary that threw still spent the
 * time, and a request whose slowness came from a read that timed out is exactly
 * the one worth measuring -- dropping it would make the header quietest about
 * the requests it exists for.
 */
export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!store.getStore()) return fn();
  const started = Date.now();
  try {
    return await fn();
  } finally {
    mark(name, Date.now() - started);
  }
}

/** The marks collected so far, or null outside a request scope. */
export function requestTimings(): ReadonlyMap<string, TimingMark> | null {
  return store.getStore() ?? null;
}

/**
 * The `Server-Timing` value for this request, or null when nothing was
 * measured -- an empty header is noise on the ~40 routes that touch no store.
 *
 * `dur` and `desc` are the standard's own fields; `count` rides in `desc`
 * because the standard has no field for it and inventing a key would put this
 * outside what a browser's devtools panel will render. That panel is most of
 * the value: it is where somebody debugging a slow page will actually look.
 */
export function serverTimingHeader(
  marks: ReadonlyMap<string, TimingMark> | null = requestTimings(),
): string | null {
  if (!marks || marks.size === 0) return null;
  return [...marks.entries()]
    .map(
      ([name, { durationMs, count }]) =>
        `${name};dur=${durationMs};desc="${count} call${count === 1 ? "" : "s"}"`,
    )
    .join(", ");
}

/** The boundary names, so a reader and a writer cannot drift. */
export const TIMING_NEON = "neon";
export const TIMING_R2_SQL = "r2sql";
export const TIMING_R2 = "r2";
