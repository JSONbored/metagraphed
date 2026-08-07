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

function run(args: string[]): string {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    // The bare mode legitimately emits ~1MB; the default 1MB stdout cap would
    // truncate it and fail the JSON.parse below for the wrong reason.
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Every `nodeStep("openapi-zod", ...)` argument list in scripts/build.ts. */
function openApiZodStepCalls(source: string): string[] {
  return [...source.matchAll(/nodeStep\(\s*"openapi-zod",([^)]*)\)/g)].map(
    (match) => match[1],
  );
}

describe("generate-openapi-zod-components CLI", () => {
  test("--check reports a count instead of the payload", () => {
    const out = run(["--check"]);
    const lines = out.trimEnd().split("\n");
    assert.equal(lines.length, 1, "--check must emit exactly one line");
    // The count is real, not a hardcoded string: it has to match what the
    // function returns, so a registry that silently emptied still fails.
    const expected = Object.keys(generateOpenApiZodComponents()).length;
    assert.ok(expected > 0, "registry should compile at least one component");
    assert.equal(
      lines[0],
      `openapi-zod: ${expected} component schema(s) compiled.`,
    );
    // The whole point: no JSON body.
    assert.ok(!out.includes('"type": "object"'), "--check must not print JSON");
    assert.ok(out.length < 200, `--check output was ${out.length} bytes`);
  });

  test("bare still prints the full component JSON", () => {
    const out = run([]);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(parsed).sort(),
      Object.keys(generateOpenApiZodComponents()).sort(),
    );
    // Guards the escape hatch the fix deliberately kept: `npm run
    // build:openapi-zod` runs bare and must keep emitting the payload.
    assert.ok(out.length > 100_000, `bare output was only ${out.length} bytes`);
  });
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
