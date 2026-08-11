// `run_step` collects failures; `report_steps` is what turns them into one
// (#10608).
//
// The validate job used to chain its validators under Actions' default
// `bash -e`, so the first failure ended the step and skipped every validator
// after it. Measured over one evening: #10577 skipped 39 of 52 steps behind a
// single stale generated type, #10572 skipped 20, #10563 skipped 14 -- three
// PRs that each cost an extra ~5-minute round trip to learn the next thing the
// same run could have said.
//
// .github/scripts/run-step.sh fixes that by recording failures instead of
// propagating them. Which means the step's exit status now depends ENTIRELY on
// the closing `report_steps` call: a block that runs ten validators, watches
// all ten fail, and forgets that one line exits 0 and reports green. That is
// strictly worse than the chain it replaced, and it looks completely correct in
// review -- the validators are all still listed.
//
// So it is asserted here rather than left to care.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import { repoRoot } from "../scripts/lib.ts";

const WORKFLOW_DIR = path.join(repoRoot, ".github/workflows");
const HELPER = ".github/scripts/run-step.sh";

interface Block {
  file: string;
  /** The step's `name:`, for a message that says which one. */
  name: string;
  body: string;
}

/** Every `run:` block in every workflow that sources the helper. */
function blocksSourcingHelper(): Block[] {
  const blocks: Block[] = [];
  for (const file of readdirSync(WORKFLOW_DIR)) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    const source = readFileSync(path.join(WORKFLOW_DIR, file), "utf8");
    const lines = source.split("\n");
    let name = "(unnamed)";
    let current: string[] | null = null;
    for (const line of lines) {
      const named = /^\s+- name: (.*)$/.exec(line);
      if (named) {
        // A new step ends the previous block.
        if (current) {
          blocks.push({ file, name, body: current.join("\n") });
          current = null;
        }
        name = named[1]!;
        continue;
      }
      if (/^\s+run: \|/.test(line)) {
        current = [];
        continue;
      }
      // A key at step level (`if:`, `env:`, `shell:`, `- name:`) ends a block.
      if (current !== null && /^\s{0,8}[a-z-]+:/.test(line)) {
        blocks.push({ file, name, body: current.join("\n") });
        current = null;
        continue;
      }
      if (current !== null) current.push(line);
    }
    if (current) blocks.push({ file, name, body: current.join("\n") });
  }
  return blocks.filter((block) => block.body.includes(HELPER));
}

describe("run_step blocks report their result (#10608)", () => {
  test("the parser found the blocks at all", () => {
    // Without this the two assertions below pass on an empty list the moment
    // the workflow's indentation or `run: |` spelling changes -- the same
    // vacuous-pass this repo's validators all guard against.
    assert.ok(
      blocksSourcingHelper().length >= 3,
      `expected at least 3 run: blocks sourcing ${HELPER}, found ` +
        `${blocksSourcingHelper().length} -- the parser has gone blind`,
    );
  });

  test("every block that sources the helper ends by reporting", () => {
    const silent = blocksSourcingHelper()
      .filter((block) => !/^\s*report_steps\s*$/m.test(block.body))
      .map((block) => `${block.file}: ${block.name}`);
    assert.deepEqual(
      silent,
      [],
      "these steps collect failures with run_step and never call " +
        "report_steps, so they exit 0 no matter what failed:\n" +
        silent.join("\n"),
    );
  });

  test("report_steps is the LAST thing each block does", () => {
    // A command after it never runs on the failing path, which makes the block
    // read as though it does more than it does.
    const trailing = blocksSourcingHelper()
      .filter((block) => {
        const meaningful = block.body
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "" && !line.startsWith("#"));
        return (
          meaningful.length > 0 &&
          meaningful[meaningful.length - 1] !== "report_steps"
        );
      })
      .map((block) => `${block.file}: ${block.name}`);
    assert.deepEqual(
      trailing,
      [],
      `these blocks run something after report_steps:\n${trailing.join("\n")}`,
    );
  });

  test("every run_step invocation names a real npm script", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const unknown: string[] = [];
    for (const block of blocksSourcingHelper()) {
      for (const match of block.body.matchAll(
        /^\s*run_step npm run ([a-z0-9:_-]+)\s*$/gm,
      )) {
        if (!(match[1]! in pkg.scripts)) {
          unknown.push(`${block.file}: ${match[1]}`);
        }
      }
    }
    assert.deepEqual(
      unknown,
      [],
      "run_step names npm scripts that do not exist -- CI would fail on the " +
        `missing script rather than on what it was meant to check:\n${unknown.join("\n")}`,
    );
  });
});
