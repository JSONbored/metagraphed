// Tests for scripts/workflow-pipe-status.ts -- the rule that stopped eight
// scheduled sweeps from reporting findings into a green run (#10564).
//
// The live workflows only exercise the PASSING side once they are fixed, which
// is the shape of check that quietly stops meaning anything. These cover the
// failing side, the three places `shell` can be declared, and the malformed
// documents that would otherwise make the scan return nothing and pass
// vacuously.

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { pipedLogSteps } from "../scripts/workflow-pipe-status.ts";

const workflow = (steps: string): unknown =>
  parse(`
jobs:
  sweep:
    steps:
${steps}
`);

describe("a step that pipes into tee", () => {
  it("is reported as losing its status under the default shell", () => {
    const found = pipedLogSteps(
      workflow(`      - name: Time every operation
        run: node scripts/check-operation-latency.ts | tee latency.log`),
    );
    expect(found).toEqual([
      { name: "Time every operation", preservesStatus: false },
    ]);
  });

  it("preserves its status with shell: bash on the step", () => {
    const found = pipedLogSteps(
      workflow(`      - name: Sweep
        shell: bash
        run: node scripts/sweep.ts | tee sweep.log`),
    );
    expect(found[0]?.preservesStatus).toBe(true);
  });

  it("preserves its status with an explicit set -o pipefail", () => {
    const found = pipedLogSteps(
      workflow(`      - name: Sweep
        run: |
          set -o pipefail
          node scripts/sweep.ts | tee sweep.log`),
    );
    expect(found[0]?.preservesStatus).toBe(true);
  });

  // `set -euo pipefail` is the form actually used by the publish workflows, and
  // a regex written for `set -o pipefail` alone silently misses it.
  it("accepts the combined set -euo pipefail form", () => {
    const found = pipedLogSteps(
      workflow(`      - name: Sweep
        run: |
          set -euo pipefail
          node scripts/sweep.ts | tee sweep.log`),
    );
    expect(found[0]?.preservesStatus).toBe(true);
  });

  it("reads shell from the job's defaults", () => {
    const found = pipedLogSteps(
      parse(`
jobs:
  sweep:
    defaults:
      run:
        shell: bash
    steps:
      - name: Sweep
        run: node scripts/sweep.ts | tee sweep.log
`),
    );
    expect(found[0]?.preservesStatus).toBe(true);
  });

  it("reads shell from the workflow's defaults", () => {
    const found = pipedLogSteps(
      parse(`
defaults:
  run:
    shell: bash
jobs:
  sweep:
    steps:
      - name: Sweep
        run: node scripts/sweep.ts | tee sweep.log
`),
    );
    expect(found[0]?.preservesStatus).toBe(true);
  });

  // The step's own declaration wins over the job's, which is Actions' own
  // precedence -- so a job-wide bash default does NOT excuse a step that opts
  // back out.
  it("lets the step's shell override the job's default", () => {
    const found = pipedLogSteps(
      parse(`
jobs:
  sweep:
    defaults:
      run:
        shell: bash
    steps:
      - name: Sweep
        shell: sh
        run: node scripts/sweep.ts | tee sweep.log
`),
    );
    expect(found[0]?.preservesStatus).toBe(false);
  });
});

describe("what the rule deliberately ignores", () => {
  it("ignores a pipe that is not into tee", () => {
    expect(
      pipedLogSteps(
        workflow(`      - name: Filter
        run: node scripts/sweep.ts | grep -c warning`),
      ),
    ).toEqual([]);
  });

  it("ignores a step with no run block", () => {
    expect(
      pipedLogSteps(
        workflow(`      - name: Checkout
        uses: actions/checkout@v7`),
      ),
    ).toEqual([]);
  });
});

// Each of these would make the scan return nothing. The validator's own
// vacuous-pass guard fails when the total is zero across the whole tree, but
// these pin the reason it could go to zero.
describe("malformed documents yield nothing rather than throwing", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a scalar", "not a workflow"],
    ["no jobs key", parse("name: Sweep\n")],
    ["jobs that is not a mapping", parse("jobs: []\n")],
    [
      "a job whose steps is not a sequence",
      parse("jobs:\n  a:\n    steps: {}\n"),
    ],
  ])("%s", (_label, document) => {
    expect(pipedLogSteps(document)).toEqual([]);
  });
});
