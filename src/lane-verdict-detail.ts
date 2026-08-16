// The counts a staleness verdict was decided ON, in the record that outlives it
// (#11384).
//
// ## The gap this closes
//
// Every staleness lane builds a rich exception message and then writes
// `detail: verdict.reason ?? null` to `lane_health` -- the bare word `partial`
// or `stale`. So the DURABLE record carries strictly less than the transient
// notification, on a surface whose own comment argues it is the record
// precisely because "a dropped $exception is indistinguishable from a lane that
// was fine".
//
// Measured 2026-08-16: `nominator-positions-staleness` published `partial` for
// five consecutive ticks. Triaging it needed the covered count, the total and
// the floor -- all three already computed, all three one field away, none of
// them published. The answer turned out to be a 22-coldkey miss against a floor
// of 17,010, but nothing on `/self-health` could distinguish that from a scan
// that died halfway.
//
// ## Why a formatter rather than columns
//
// The five coverage lanes count different things -- rows, netuids, coldkeys --
// and two more lanes have no coverage leg at all. A column per fact would be
// mostly null and would need a migration per lane. The verdict is already
// serialised for humans; what it lacked was the numbers, not a schema.
//
// ## Facts are OMITTED, never guessed
//
// A non-finite fact is dropped rather than rendered as `0` or `null`. Zero
// covered rows and "we could not count the rows" are different claims and only
// one of them is a fact -- the same rule `loadAxonLossMechanisms` follows for
// an unmeasured mechanism (#11381).

/**
 * `reason (key=value, ...)`, or the bare reason when nothing is measurable.
 *
 * Returns null for a healthy lane, matching the `detail` column's existing
 * meaning -- an `ok` verdict has no reason and gains no facts.
 */
export function laneVerdictDetail(
  reason: string | null | undefined,
  facts: Readonly<Record<string, number | null | undefined>> = {},
): string | null {
  if (typeof reason !== "string" || reason === "") return null;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(facts ?? {})) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    parts.push(`${key}=${value}`);
  }
  return parts.length === 0 ? reason : `${reason} (${parts.join(", ")})`;
}
