// Every `step("...")` in scripts/pipeline.ts must name a real npm script (#10567).
//
// `pipeline:check` ran `step("schemas:bundle:check")` for months after #9848
// deleted that script. Nothing noticed, because `pipeline:check` is a leg of
// `npm run check` and `npm run check` is NOT run by CI -- so the failure only
// ever appeared on a contributor's machine, at the very end of the chain, in
// the command the backend-code PR template tells them to run first. It read
// like they had broken something.
//
// Asserted here rather than in a validator because pipeline.ts self-executes on
// import (it spawns the steps), so nothing can import its step lists -- and a
// test already runs in CI, which is the property the original gap lacked.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../scripts/lib.ts";

const source = readFileSync(path.join(repoRoot, "scripts/pipeline.ts"), "utf8");
const scripts = new Set(
  Object.keys(
    (
      JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      }
    ).scripts ?? {},
  ),
);

/** Every distinct script name the pipeline declares a step for. */
const stepNames = [
  ...new Set([...source.matchAll(/step\("([^"]+)"/g)].map((m) => m[1])),
];

describe("pipeline steps", () => {
  // Without this the test below passes on an empty list -- the exact shape of
  // failure it exists to catch, one level up.
  it("finds the step list at all", () => {
    expect(stepNames.length).toBeGreaterThan(50);
  });

  it("names only scripts that exist in package.json", () => {
    const missing = stepNames.filter((name) => !scripts.has(name));
    expect(missing).toEqual([]);
  });
});
