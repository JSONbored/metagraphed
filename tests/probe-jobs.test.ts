// Routing for the shared probe queue (#10894).
//
// Four lanes that each had their own queue now share one, so the discriminator
// is the only thing standing between a message and the wrong handler. The
// dangerous failures are not "the wrong lane ran" -- a handler given a foreign
// body parses it to null and acks -- but the quiet ones: a message silently
// dropped, or a batch that stops being processed because one member of it was
// unrecognised.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  PROBE_JOBS_DLQ,
  PROBE_JOBS_QUEUE,
  PROBE_JOB_TYPES,
  ProbeJobEnvelopeSchema,
  ProbeJobTypeSchema,
} from "../schemas-src/probe-jobs.ts";
import {
  declineUnknownProbeJobs,
  partitionProbeJobs,
  probeJob,
} from "../src/probe-jobs.ts";
import type { LaneMessage } from "../src/lane-queue.ts";

function message(body: unknown) {
  const state = { acked: 0, retried: 0 };
  const msg: LaneMessage & { state: typeof state } = {
    body,
    ack: () => void (state.acked += 1),
    retry: () => void (state.retried += 1),
    state,
  };
  return msg;
}

describe("the vocabulary is closed and derived once", () => {
  test("the array comes FROM the enum, not beside it", () => {
    // Two lists that must agree are two lists that eventually do not.
    assert.deepEqual([...PROBE_JOB_TYPES], [...ProbeJobTypeSchema.options]);
  });

  test("it names the four lanes that shared the pattern", () => {
    assert.deepEqual(
      [...PROBE_JOB_TYPES].sort(),
      [
        "attribution-sweep",
        "compute-declaration",
        "origin-reachability",
        "revenue-probe",
      ].sort(),
    );
  });

  test("the job types ARE the lane names", () => {
    // Deliberate: a job type that did not match the lane it belongs to would
    // make a queue depth impossible to line up against `lane_health`.
    for (const jobType of PROBE_JOB_TYPES) {
      assert.match(jobType, /^[a-z]+(-[a-z]+)*$/);
    }
  });

  test("the queue and its dead letter are named as a pair", () => {
    assert.equal(PROBE_JOBS_DLQ, `${PROBE_JOBS_QUEUE}-dlq`);
  });

  test("an unknown type does not parse", () => {
    assert.equal(
      ProbeJobEnvelopeSchema.safeParse({ job_type: "nope" }).success,
      false,
    );
    assert.equal(ProbeJobEnvelopeSchema.safeParse({}).success, false);
    assert.equal(ProbeJobEnvelopeSchema.safeParse(null).success, false);
  });

  test("the payload is IGNORED, not rejected and not returned", () => {
    // Strip, deliberately: `.strict()` would reject every real body, and
    // `.passthrough()` would return payload fields a router has no business
    // carrying (#10790).
    const parsed = ProbeJobEnvelopeSchema.safeParse({
      job_type: "revenue-probe",
      surface_id: "sn-64-api",
    });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data, { job_type: "revenue-probe" });
  });
});

describe("probeJob stamps without wrapping", () => {
  test("the payload stays at the top level", () => {
    // An envelope would have made this a four-lane rewrite: every lane's
    // `parse` reads its fields off the body directly.
    assert.deepEqual(probeJob("attribution-sweep", { netuid: 64 }), {
      netuid: 64,
      job_type: "attribution-sweep",
    });
  });
});

describe("a mixed batch is partitioned before anything runs", () => {
  test("messages group by owner", () => {
    const a = message(probeJob("attribution-sweep", { netuid: 1 }));
    const b = message(probeJob("revenue-probe", { surface_id: "x" }));
    const c = message(probeJob("attribution-sweep", { netuid: 2 }));
    const { byType, unrecognised } = partitionProbeJobs([a, b, c]);
    assert.deepEqual(unrecognised, []);
    assert.deepEqual(byType.get("attribution-sweep"), [a, c]);
    assert.deepEqual(byType.get("revenue-probe"), [b]);
  });

  test("iteration order is the VOCABULARY's, not the batch's", () => {
    // A store is opened per group, so dispatch order is observable. Arrival
    // order would make a run's behaviour depend on which lane enqueued first.
    const { byType } = partitionProbeJobs([
      message(probeJob("compute-declaration", { netuid: 3 })),
      message(probeJob("attribution-sweep", { netuid: 1 })),
      message(probeJob("revenue-probe", { surface_id: "x" })),
    ]);
    assert.deepEqual(
      [...byType.keys()],
      ["attribution-sweep", "revenue-probe", "compute-declaration"],
    );
  });

  test("a lane with no messages is absent, not empty", () => {
    const { byType } = partitionProbeJobs([
      message(probeJob("attribution-sweep", { netuid: 1 })),
    ]);
    assert.equal(byType.has("revenue-probe"), false);
    assert.equal(byType.size, 1);
  });

  test("an empty batch partitions to nothing", () => {
    const { byType, unrecognised } = partitionProbeJobs([]);
    assert.equal(byType.size, 0);
    assert.deepEqual(unrecognised, []);
  });

  test("ONE BAD MESSAGE DOES NOT COST THE BATCH", () => {
    // The property the whole partition exists to preserve: a poison message
    // costs one subject, never every subject delivered beside it.
    const good = message(
      probeJob("origin-reachability", { origin: "https://x" }),
    );
    const bad = message({ job_type: "not-a-lane", origin: "https://y" });
    const { byType, unrecognised } = partitionProbeJobs([bad, good]);
    assert.deepEqual(byType.get("origin-reachability"), [good]);
    assert.deepEqual(unrecognised, [bad]);
  });

  test("a body with no job_type at all is unrecognised, not guessed", () => {
    // There is deliberately no inference from payload shape: `{netuid}` could
    // be an attribution sweep or a compute declaration, and guessing would run
    // the wrong handler against a store scoped to the wrong tables.
    const orphan = message({ netuid: 64 });
    const { byType, unrecognised } = partitionProbeJobs([orphan]);
    assert.equal(byType.size, 0);
    assert.deepEqual(unrecognised, [orphan]);
  });
});

describe("an unrecognised job is DECLINED, never dropped", () => {
  test("it is acked, not retried", () => {
    // `lane-queue.ts`'s recorded rule: a body that cannot be acted on will not
    // become actionable on redelivery, so retrying spends the whole budget to
    // reach the dead letter with a message nobody can use.
    const bad = message({ job_type: "gone" });
    declineUnknownProbeJobs([bad], () => {});
    assert.equal(bad.state.acked, 1);
    assert.equal(bad.state.retried, 0);
  });

  test("and it SAYS SO, naming the known types", () => {
    // The half that matters, and #10827's rule for cron dispatch: an unmatched
    // discriminator must produce a verdict. A silent ack is indistinguishable
    // from correct handling, so a half-deployed rename would look exactly like
    // a healthy queue draining.
    const reports: [string, number][] = [];
    declineUnknownProbeJobs([message({ job_type: "gone" })], (reason, count) =>
      reports.push([reason, count]),
    );
    assert.equal(reports.length, 1);
    assert.match(reports[0]![0], /unrecognised job_type/);
    for (const jobType of PROBE_JOB_TYPES) {
      assert.ok(
        reports[0]![0].includes(jobType),
        `the report must name ${jobType} as a known type`,
      );
    }
  });

  test("ONE report per batch, not one per message", () => {
    // A producer emitting the wrong type emits it for every message, so
    // per-message reporting turns one fault into a hundred records -- the same
    // storm control consumeBatch applies to retries.
    const reports: [string, number][] = [];
    const bad = Array.from({ length: 50 }, () => message({ job_type: "gone" }));
    const declined = declineUnknownProbeJobs(bad, (reason, count) =>
      reports.push([reason, count]),
    );
    assert.equal(declined, 50);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]![1], 50, "the count rides along");
  });

  test("nothing to decline reports nothing", () => {
    const reports: unknown[] = [];
    assert.equal(
      declineUnknownProbeJobs([], () => reports.push(1)),
      0,
    );
    assert.deepEqual(reports, []);
  });

  test("a throwing reporter cannot make the batch worse", () => {
    // Every message is already acked by the time reporting runs, so a throwing
    // reporter loses nothing -- but it would turn a diagnosable fault into an
    // undiagnosable one.
    const bad = message({ job_type: "gone" });
    assert.doesNotThrow(() =>
      declineUnknownProbeJobs([bad], () => {
        throw new Error("reporter down");
      }),
    );
    assert.equal(bad.state.acked, 1);
  });
});
