import { registerModuleStateReset } from "./module-state-registry.ts";

/**
 * How deep an emulated OFFSET may go. Past this the over-fetch stops being a
 * reasonable trade and the loader declines, so the caller degrades to its
 * schema-stable empty rather than serving a page that is quietly wrong or
 * spending seconds scanning for a page nobody paginated to by hand.
 *
 * ## WHY 250 AND NOT 1000 (#11140)
 *
 * This is a ROW count standing in for a BYTE budget, and the two came apart on
 * `chain.extrinsics`. R2 SQL has no OFFSET, so a deep page is emulated by
 * over-fetching `limit + offset` rows and slicing -- at the old 1000, with a
 * limit ceiling of 100, one page pulled up to 1,100 rows. Every row carries
 * `call_args`, whose width is not bounded by anything.
 *
 * Measured 2026-08-14 on `chain_detail_extrinsics` (120,373 rows): avg
 * `call_args` 1,425 B, p99 4,894 B, max 67,657 B -- a 45x spread. A typical
 * 1,100-row page is ~1.5 MB and fine. But a FILTERED read concentrates the wide
 * rows: `MevShield.submit_encrypted` averages 4,821 B and `Proxy.proxy` reaches
 * 67,657 B, so `WHERE signer = ...` for an account that batches heavily returns
 * a page of uniformly large rows.
 *
 * That is not hypothetical. Production declined four of these with
 * `body_too_large`, and the received counts say the cap is not the variable:
 * three tripped an 8 MB cap and the fourth tripped a **12 MB** one, after the
 * cap had already been raised. Raising it again is the experiment that already
 * failed -- and buffering >12 MB inside an isolate to serve one page is the
 * wrong trade regardless.
 *
 * 250 caps the over-fetch at 350 rows, which is ~4 MB at the density that blew
 * past 12 MB -- back under budget with room, by shrinking the fetch rather than
 * growing the buffer. Depth beyond this is NOT lost: a cursor page sets `paged`
 * to 0 and never over-fetches, so keyset pagination still walks the whole feed.
 * A row count cannot bound bytes when row width varies 45x, so this is a
 * measured margin, not a proof -- see the issue for the typed decline that
 * replaces the silent empty page when it is exceeded anyway.
 */
export const OFFSET_EMULATION_CAP = 250;

/**
 * How many times a read has declined a too-deep offset, this isolate.
 *
 * Same contract as `currentR2SqlFailureGeneration`: a caller snapshots this
 * before serving and compares after. It exists because that counter CANNOT see
 * this decline -- the cap is checked before any SQL is built, so no query is
 * issued, nothing fails, and no failure generation moves.
 *
 * That blindness shipped. `handleRequest` labels a degraded answer by comparing
 * generations around the dispatch, so ten paginated routes answered a declined
 * page as a bare, edge-cacheable 200 whose body was byte-identical to
 * end-of-feed (#11142). `/api/v1/extrinsics?offset=260` reported
 * `extrinsic_count: 0, next_cursor: null` with millions of rows behind it.
 *
 * UNMEASURED rather than transient, which is why it is a separate counter from
 * the failure one rather than an increment of it: the same offset declines the
 * same way for the whole TTL, so the answer stays cacheable and merely stops
 * claiming to be measured. See `degradedSince` for that split.
 */
let offsetCapDeclineGeneration = 0;

registerModuleStateReset("src/cold-tier-offset.ts", () => {
  offsetCapDeclineGeneration = 0;
});

export function currentOffsetCapDeclineGeneration(): number {
  return offsetCapDeclineGeneration;
}

/**
 * Whether `offset` is past the emulated-offset ceiling, RECORDING the decline.
 *
 * Every cold-tier reader asks through here rather than comparing against
 * OFFSET_EMULATION_CAP itself. A bare comparison returns null silently, and the
 * answer that reaches the caller is then indistinguishable from an empty feed
 * -- which is the entire defect. Routing the check through one function is what
 * makes a reader added tomorrow report the decline without its author having to
 * know the labelling exists.
 */
export function offsetBeyondEmulationCap(offset: number): boolean {
  if (offset <= OFFSET_EMULATION_CAP) return false;
  offsetCapDeclineGeneration += 1;
  return true;
}
