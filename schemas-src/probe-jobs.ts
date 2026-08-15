// The one queue the probe lanes share, and the discriminator that tells them
// apart (#10894, consolidation item 4 of #10849).
//
// FOUR LANES WERE THE SAME SHAPE: enqueue a target, probe it, record the
// result. Each arrived with its own queue and its own dead-letter queue, so
// four copies of one pattern were 8 of the account's 12 queues. `attribution-
// sweep`, `origin-reachability` and `revenue-probe` were the three #10849
// counted; `compute-declaration` landed on 2026-08-13 as a fourth, and its own
// module header names the other three as siblings on the same heartbeat -- so
// collapsing only the original three would have shipped the consolidation and
// left a fresh copy of the thing being consolidated.
//
// A CLOSED VOCABULARY, DECLARED ONCE. The enum is the source; the array is
// derived from it rather than written beside it, because two lists that must
// agree are two lists that eventually do not. Adding a lane means adding one
// member here and one branch in the dispatcher, and the dispatcher's exhaustive
// switch is what makes the second impossible to forget.
//
// WHY THE DISCRIMINATOR IS ON THE BODY rather than inferred from anything else:
// with one queue there is no `batch.queue` to switch on, and a batch may mix
// job types freely -- Cloudflare fills a batch from whatever is pending. The
// consumer therefore has to read each message to know who owns it, which means
// the type has to survive the round trip inside the message itself.
import { z } from "zod";

/** The queue every probe lane now produces to. */
export const PROBE_JOBS_QUEUE = "probe-jobs";

/** Its dead letter. Bound to the same consumer, which branches on it first. */
export const PROBE_JOBS_DLQ = "probe-jobs-dlq";

/**
 * Who owns a message.
 *
 * The values are the LANE names already used in `lane_health` verdicts and in
 * the freshness watchdog, deliberately: a job type that did not match the lane
 * it belongs to would make a queue depth impossible to line up against the
 * lane's own reporting.
 */
export const ProbeJobTypeSchema = z.enum([
  "attribution-sweep",
  "origin-reachability",
  "revenue-probe",
  "compute-declaration",
]);

export type ProbeJobType = z.infer<typeof ProbeJobTypeSchema>;

/** Derived, never hand-listed -- see the header. */
export const PROBE_JOB_TYPES: readonly ProbeJobType[] =
  ProbeJobTypeSchema.options;

/**
 * The routing half of a message. The payload is the lane's own business.
 *
 * NEITHER `.strict()` NOR `.passthrough()`, and both would be wrong here.
 * `.strict()` rejects all four bodies, since every one of them carries payload
 * fields this file has no business declaring. `.passthrough()` would return
 * them, which is what #10790 forbids and which nothing here needs -- the raw
 * body is handed to the lane's own `parse` regardless.
 *
 * Zod's default is STRIP: unknown keys are ignored and the parsed value is the
 * declared field alone. That is exactly a router's contract -- read the
 * destination, carry nothing else -- so the default is the right behaviour
 * rather than the absence of a decision.
 */
export const ProbeJobEnvelopeSchema = z.object({
  job_type: ProbeJobTypeSchema,
});
