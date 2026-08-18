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
 * `reason (key=value, ...)`, the bare reason when nothing is measurable, or the
 * bare facts when there is no reason.
 *
 * ## A HEALTHY LANE PUBLISHES ITS COUNTS TOO (#11390)
 *
 * This used to return null the moment `reason` was absent, on the reading that
 * "an `ok` verdict has no reason and gains no facts". The first half is right;
 * the second turned out to be the thing blocking its own sibling issue.
 *
 * #11384 published these counts so a verdict could be triaged from the durable
 * record. #11390 then wants to replace `NOMINATOR_POSITIONS_EXPECTED_COLDKEYS`
 * -- a pinned constant that has gone stale three times -- with a floor derived
 * from a trailing median of the lane's own coverage, and named these counts as
 * "the only place a trailing baseline can come from".
 *
 * They could not be. Measured 2026-08-18: of 658 `nominator-positions-staleness`
 * verdicts only 20 carried counts, spanning 27 hours and then stopping -- not
 * because the lane stopped ticking, but because it RECOVERED. A baseline
 * sampled only while a lane is unhealthy is a median of bad passes, which is
 * the same error as the pinned constant approached from the other side.
 *
 * The pass-tally table is not a substitute either: `received_rows` counts rows
 * POSTED, and `nominator_positions` upserts on `(coldkey, hotkey, netuid)`, so
 * a pass posting 108,306 rows lands 95,086 -- 12% of the posted rows are
 * duplicate keys collapsing. It cannot be compared against a count read from
 * the table.
 *
 * So the facts are published whether or not there is a reason, and the baseline
 * exists by construction from the next tick onward.
 *
 * ## What did not change
 *
 * A verdict with neither a reason nor a measurable fact is still null -- the
 * column's meaning for "nothing to say" is unchanged, and every lane with no
 * coverage leg keeps writing null exactly as before.
 */
export function laneVerdictDetail(
  reason: string | null | undefined,
  facts: Readonly<Record<string, number | null | undefined>> = {},
): string | null {
  const named = typeof reason === "string" && reason !== "" ? reason : null;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(facts ?? {})) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    parts.push(`${key}=${value}`);
  }
  if (parts.length === 0) return named;
  // Bare, without an empty `()` in front of them: a healthy lane's detail reads
  // as the measurement it is, not as a reason that went missing.
  return named === null ? parts.join(", ") : `${named} (${parts.join(", ")})`;
}
