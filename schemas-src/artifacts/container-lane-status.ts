// The status object every container-written lane publishes (metagraphed-infra).
//
// LIVES HERE for the reason chain-rpc-envelope.ts states: a schema outside
// schemas-src is outside `no-passthrough`, `schema-shape-duplicates` and
// `schema-opacity`.
//
// ## Why one schema for five lanes that do not agree on their field names
//
// These objects are written by a container in ANOTHER REPOSITORY, by five
// different scripts, and they diverge:
//
//   decode-run-status.json            updated_at, status: "ok",  detail
//   account-summary-status.json       checked_at, ok: true,      phase, failures
//   daily-rollup-status.json          checked_at, ok, complete
//   state-mirror-status.json          checked_at, ok, complete,  failures
//   account-events-rollup-status.json checked_at, ok,            failures
//
// Declaring five schemas would state five vocabularies this repo does not own
// and cannot keep in step. Declaring ONE that accepts either spelling of each
// idea -- a timestamp, an outcome, an explanation -- states exactly what the
// watchdog depends on and nothing else, which is the honest inventory
// foreign-wire.ts's header argues for.
//
// EVERY FIELD OPTIONAL AND `.catch`-GUARDED. The producer is deployed
// independently of this reader, so a field that changes type must degrade to
// "the watchdog could not measure this" -- a `unknown` verdict -- rather than
// throw and take the other four lanes' verdicts down with it.
import { z } from "zod";

/**
 * What a container lane's status object must carry for a verdict to be drawn.
 *
 * `checked_at` OR `updated_at`: four lanes publish the first and decode
 * publishes the second. Both are accepted and the reader takes whichever is
 * present, because which word a script chose is not a fact about lane health.
 *
 * `ok` OR `status`: same argument. A boolean and the string "ok" are the same
 * claim, and a lane that reports neither is not asserting success -- it is
 * simply not saying, which the rule treats as "cannot tell" rather than as a
 * pass.
 *
 * `detail`, `phase` are carried purely so a `stale` verdict can quote the
 * producer's own words instead of a message this repo invented about a process
 * it does not run.
 */
export const ContainerLaneStatusSchema = z.object({
  checked_at: z.string().nullable().optional().catch(null),
  updated_at: z.string().nullable().optional().catch(null),
  ok: z.boolean().nullable().optional().catch(null),
  status: z.string().nullable().optional().catch(null),
  detail: z.string().nullable().optional().catch(null),
  phase: z.string().nullable().optional().catch(null),
});
