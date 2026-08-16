import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import { repoRoot } from "../scripts/lib.ts";
import { generateOpenApiZodComponents } from "../scripts/generate-openapi-zod-components.ts";

// #9945: this step ran bare and printed the whole component map -- ~1,040,000
// bytes / 42,664 lines, 99.8% of the build log, against 2,358 bytes from every
// other step combined -- while nothing read a byte of it. A healthy build got
// reported as a failing one because the outcome was unfindable in the noise.
//
// Two things have to hold together for that to stay fixed, so both are asserted
// here: the script has to be quiet under --check, AND the build has to pass it.
// Testing only the script would let build.ts silently drop the flag and restore
// the megabyte.

const SCRIPT = "scripts/generate-openapi-zod-components.ts";

/**
 * Compiling the registry is the expensive part, and this file used to do it
 * FOUR times: two subprocess spawns plus a fresh in-process call inside each
 * test. Hoisted so the in-process half happens once.
 */
const COMPONENT_NAMES = Object.keys(generateOpenApiZodComponents()).sort();

/**
 * This file spawns the real CLI twice, and each spawn compiles all 338
 * component schemas. Measured on 2026-08-16: 6.6s per spawn bare, 9.4s with
 * `NODE_V8_COVERAGE` inherited. Two of those plus the in-process compile runs
 * past the suite's 30s default whenever the machine is also running the other
 * test workers -- which is why this timed out under `test:coverage` while
 * passing under a plain `vitest run`.
 *
 * Same escape hatch tests/public-safety.test.ts takes for its full-repo scan:
 * the 30s default is a default, and a file doing genuinely slow work says so.
 */
const CLI_TEST_TIMEOUT_MS = 90_000;

function run(args: string[]): string {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    // The bare mode legitimately emits ~1MB; the default 1MB stdout cap would
    // truncate it and fail the JSON.parse below for the wrong reason.
    maxBuffer: 64 * 1024 * 1024,
    // COVERAGE IS STRIPPED FROM THE CHILD, deliberately. Vitest exports
    // `NODE_V8_COVERAGE` and every subprocess inherits it, so this CLI was
    // being instrumented too -- 43% slower (6.6s -> 9.4s) and 1.7MB of
    // coverage data written per spawn. None of it is ever read: this script is
    // not in vitest.config.ts's `coverage.include`, which lists src/**,
    // workers/**, schemas-src/** and six named scripts. Pure cost, and it was
    // the difference between passing and timing out.
    // Spread rather than rebuilt: `process.env` is strictly typed here, and
    // Node omits an env entry whose value is `undefined` rather than passing
    // an empty string -- which is what actually unsets it for the child.
    env: { ...process.env, NODE_V8_COVERAGE: undefined },
  });
}

/** Every `nodeStep("openapi-zod", ...)` argument list in scripts/build.ts. */
function openApiZodStepCalls(source: string): string[] {
  return [...source.matchAll(/nodeStep\(\s*"openapi-zod",([^)]*)\)/g)].map(
    (match) => match[1],
  );
}

describe("generate-openapi-zod-components CLI", () => {
  test(
    "--check reports a count instead of the payload",
    { timeout: CLI_TEST_TIMEOUT_MS },
    () => {
      const out = run(["--check"]);
      const lines = out.trimEnd().split("\n");
      assert.equal(lines.length, 1, "--check must emit exactly one line");
      // The count is real, not a hardcoded string: it has to match what the
      // function returns, so a registry that silently emptied still fails.
      const expected = COMPONENT_NAMES.length;
      assert.ok(expected > 0, "registry should compile at least one component");
      assert.equal(
        lines[0],
        `openapi-zod: ${expected} component schema(s) compiled.`,
      );
      // The whole point: no JSON body.
      assert.ok(
        !out.includes('"type": "object"'),
        "--check must not print JSON",
      );
      assert.ok(out.length < 200, `--check output was ${out.length} bytes`);
    },
  );

  test(
    "bare still prints the full component JSON",
    { timeout: CLI_TEST_TIMEOUT_MS },
    () => {
      const out = run([]);
      const parsed = JSON.parse(out) as Record<string, unknown>;
      assert.deepEqual(Object.keys(parsed).sort(), COMPONENT_NAMES);
      // Guards the escape hatch the fix deliberately kept: `npm run
      // build:openapi-zod` runs bare and must keep emitting the payload.
      assert.ok(
        out.length > 100_000,
        `bare output was only ${out.length} bytes`,
      );
    },
  );
});

describe("scripts/build.ts wires --check", () => {
  const source = readFileSync(path.join(repoRoot, "scripts/build.ts"), "utf8");
  const calls = openApiZodStepCalls(source);

  test("both step lists run the openapi-zod step", () => {
    // localSteps + productionSteps. If a third list ever appears this fails
    // rather than silently checking two of three.
    assert.equal(calls.length, 2, "expected exactly two openapi-zod steps");
  });

  test("every openapi-zod step passes --check", () => {
    for (const args of calls) {
      assert.ok(
        args.includes('"--check"'),
        `openapi-zod step missing --check: nodeStep("openapi-zod",${args})`,
      );
    }
  });

  test("the parser would notice a step that dropped the flag", () => {
    // Positive control -- a matcher that silently found nothing would pass the
    // assertion above over an empty list, which is the failure mode this whole
    // test exists to prevent.
    const withoutFlag = openApiZodStepCalls(
      'nodeStep("openapi-zod", "scripts/generate-openapi-zod-components.ts"),',
    );
    assert.equal(withoutFlag.length, 1);
    assert.ok(!withoutFlag[0].includes('"--check"'));
  });
});
