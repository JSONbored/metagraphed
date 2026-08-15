// Routing for the shared probe queue (#10894). The vocabulary lives in
// `schemas-src/probe-jobs.ts`; this is what the producer and the consumer DO
// with it.
//
// A BATCH IS NO LONGER ONE LANE'S. With four queues, `batch.queue` said who
// owned every message in a delivery and the consumer could hand the whole batch
// to one handler. With one queue, Cloudflare fills a batch from whatever is
// pending, so a delivery can mix all four lanes -- and the handlers are not
// interchangeable: each opens a store scoped to its OWN tables
// (`producerStore(env, ctx, [...TABLES])`) and would refuse a table it was not
// told about. So the batch is partitioned first and each group is dispatched to
// its owner with its own store.
import {
  PROBE_JOB_TYPES,
  ProbeJobEnvelopeSchema,
  type ProbeJobType,
} from "../schemas-src/probe-jobs.ts";
import type { LaneMessage } from "./lane-queue.ts";

/**
 * Stamp a payload with the lane that owns it.
 *
 * The producer's only change. `job_type` rides beside the payload rather than
 * wrapping it, so each lane's `parse` still reads the same field names off the
 * same object and none of them needed touching -- an envelope would have made
 * this a four-lane rewrite instead of a transport change.
 */
export function probeJob<T extends Record<string, unknown>>(
  jobType: ProbeJobType,
  payload: T,
): T & { job_type: ProbeJobType } {
  return { ...payload, job_type: jobType };
}

export interface PartitionedProbeJobs {
  /** Messages grouped by the lane that owns them, in vocabulary order. */
  byType: Map<ProbeJobType, LaneMessage[]>;
  /** Messages carrying no recognised `job_type`. */
  unrecognised: LaneMessage[];
}

/**
 * Split a delivery by owner.
 *
 * ORDER IS THE VOCABULARY'S, not the batch's. Iterating a Map built in arrival
 * order would make the dispatch sequence depend on which lane happened to
 * enqueue first, and a store opened per group means that ordering is
 * observable. Fixed order makes a run reproducible.
 */
export function partitionProbeJobs(
  messages: readonly LaneMessage[],
): PartitionedProbeJobs {
  const byType = new Map<ProbeJobType, LaneMessage[]>();
  const unrecognised: LaneMessage[] = [];
  for (const message of messages) {
    const parsed = ProbeJobEnvelopeSchema.safeParse(message.body);
    if (!parsed.success) {
      unrecognised.push(message);
      continue;
    }
    const bucket = byType.get(parsed.data.job_type);
    if (bucket) bucket.push(message);
    else byType.set(parsed.data.job_type, [message]);
  }
  // Rebuilt in vocabulary order rather than sorted in place, so the returned
  // Map iterates the same way every run.
  const ordered = new Map<ProbeJobType, LaneMessage[]>();
  for (const jobType of PROBE_JOB_TYPES) {
    const bucket = byType.get(jobType);
    if (bucket) ordered.set(jobType, bucket);
  }
  return { byType: ordered, unrecognised };
}

/**
 * Ack messages nothing owns, and SAY SO.
 *
 * ACKED, NOT RETRIED, and that follows `lane-queue.ts`'s recorded rule: a body
 * that cannot be acted on will not become actionable on redelivery, so retrying
 * spends the whole budget to reach the dead letter with a message nobody can
 * use.
 *
 * DECLINED, NOT DROPPED, which is the half that matters and the half #10827
 * established for cron dispatch: an unmatched discriminator must produce a
 * verdict. A message silently acked is indistinguishable from one correctly
 * handled, so a producer emitting a job type no consumer knows -- a rename
 * half-deployed, a lane added on one side only -- would look exactly like a
 * healthy queue draining.
 *
 * There is deliberately NO default branch upstream of this. An unrecognised
 * type arrives here or nowhere.
 */
export function declineUnknownProbeJobs(
  messages: readonly LaneMessage[],
  report: (reason: string, count: number) => void = (reason, count) =>
    console.error(`probe-jobs: ${count} message(s) declined -- ${reason}`),
): number {
  if (!messages.length) return 0;
  for (const message of messages) message.ack();
  // ONE REPORT PER BATCH, not per message: a producer emitting the wrong type
  // emits it for every message, so per-message reporting turns one fault into a
  // hundred records. The same storm control `consumeBatch` applies to retries.
  try {
    report(
      `unrecognised job_type; known types are ${PROBE_JOB_TYPES.join(", ")}`,
      messages.length,
    );
  } catch {
    // Reporting must never make the batch worse: every message is already
    // acked, so a throwing reporter would lose nothing -- but it would turn a
    // diagnosable fault into an undiagnosable one.
  }
  return messages.length;
}
