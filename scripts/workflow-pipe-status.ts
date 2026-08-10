// Keeps a scheduled sweep's verdict from being thrown away by its own logging.
//
// The sweeps pipe their report into `tee` so the text survives for the job
// summary. That hands the STEP's exit status to `tee`, which always succeeds,
// because Actions' default shell on Linux is `bash -e {0}` -- `-e` without
// `-o pipefail`. Ten steps do this and eight of them signal failure by exit
// code, so eight scheduled sweeps ran green for months while reporting real
// findings (#10564):
//
//   check-operation-latency    printed "12 over the 5000ms budget"
//                              and "3 stale DECLARED entr(y/ies)"  -> green
//   check-cross-surface-values printed "6 divergence(s)"           -> green
//
// Both scripts exit 1 on exactly those conditions. Nothing was wrong with the
// checks; the verdict never left the pipe.
//
// `shell: bash` is Actions' documented opt-in to
// `bash --noprofile --norc -eo pipefail {0}`, so declaring it restores the
// status without changing a byte of what the step prints.
//
// This module is the derivation, kept separate from the validator so it can be
// unit-tested against synthetic documents -- the same split
// scripts/workflow-observability.ts uses, and for the same reason: the
// validator self-executes on import, so a test cannot reach a helper declared
// inside it.

/** The subset of a workflow document this rule reads. */
interface WorkflowRunDefaults {
  defaults?: { run?: { shell?: unknown } };
}
interface WorkflowStep extends WorkflowRunDefaults {
  name?: unknown;
  run?: unknown;
  shell?: unknown;
}
interface WorkflowJob extends WorkflowRunDefaults {
  steps?: unknown;
}
interface WorkflowDocument extends WorkflowRunDefaults {
  jobs?: unknown;
}

export interface PipedLogStep {
  /** The step's `name`, or `(unnamed)` -- only ever used in the message. */
  name: string;
  /** Whether the pipeline's exit status survives `tee`. */
  preservesStatus: boolean;
}

/**
 * Every step whose `run` pipes into `tee`, with whether its exit status
 * survives.
 *
 * Matched on `tee` specifically rather than on any pipe. `tee` is THIS repo's
 * idiom for "keep the output for the job summary and still fail on it", so a
 * `tee` pipe is exactly the case where the status is meant to matter. A rule
 * over every pipe would flag `grep`/`head` filters where a non-zero status is
 * ordinary and expected, and a gate that fails on correct code teaches people
 * to exempt it.
 *
 * `shell` may be declared on the step, on the job's defaults, or on the
 * workflow's; the innermost wins, which is Actions' own precedence.
 *
 * Reads a PARSED document rather than the file text, so a reformatting -- a
 * folded scalar, a quoted key, a different indent -- cannot make the rule stop
 * seeing a step it was written to see.
 */
export function pipedLogSteps(document: unknown): PipedLogStep[] {
  const doc = (document ?? {}) as WorkflowDocument;
  const found: PipedLogStep[] = [];
  const jobs = doc.jobs;
  if (typeof jobs !== "object" || jobs === null) return found;
  for (const job of Object.values(jobs as Record<string, WorkflowJob>)) {
    if (!Array.isArray(job?.steps)) continue;
    for (const step of job.steps as WorkflowStep[]) {
      const run = step?.run;
      if (typeof run !== "string" || !/\|\s*tee\b/.test(run)) continue;
      const shell =
        step?.shell ?? job?.defaults?.run?.shell ?? doc.defaults?.run?.shell;
      found.push({
        name: typeof step?.name === "string" ? step.name : "(unnamed)",
        // `set -o pipefail` and `set -euo pipefail` are both in use in this
        // repo, so match any `set` line that turns it on rather than one form.
        preservesStatus:
          shell === "bash" || /\bset\b[^\n]*\bpipefail\b/.test(run),
      });
    }
  }
  return found;
}
