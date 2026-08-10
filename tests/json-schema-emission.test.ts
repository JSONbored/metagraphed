// One place decides how a published schema is emitted (#10583).
//
// `src/mcp-input-schema.ts` exists so the emission options are chosen once.
// `src/mcp-server.ts` went through it at 388 call sites; 78 more, across 38
// satellite modules, hand-spelled `{ target: "draft-2020-12" }` instead. Those
// schemas are PUBLISHED, so the "chosen once" property the helper was written
// for did not actually hold: change the target draft, or reconsider
// `reused: "ref"` on evidence, and 388 sites move while 78 silently do not.
//
// Not a payload question. #9685 measured `reused: "ref"` at 5.8% and
// deliberately declined it; that decision is recorded in
// `src/mcp-input-schema.ts`. This is the ordinary single-source rule: the point
// is not the current value, it is that there is one place to change it.
//
// THE `io:` CALLS ARE A DIFFERENT EMISSION and are deliberately not covered.
// `src/contracts.ts` and `src/route-query.ts` emit OpenAPI *parameters* with
// `io: "input"`, which is a different mode producing a different document.
// Folding them into an MCP tool-schema helper would merge two contracts that
// only look alike.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../scripts/lib.ts";

/** The one module allowed to call Zod's emitter for a tool schema. */
const HELPER = "src/mcp-input-schema.ts";

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) found.push(full);
  }
  return found;
}

/**
 * Raw emitter calls, excluding whole comment lines.
 *
 * The prose in these modules quotes `z.toJSONSchema(...)` when explaining why
 * the helper exists, so counting comment text would make the rule fail on its
 * own explanation -- the same trap the untyped-read ratchet hit.
 */
function rawEmitterCalls(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .filter((line) => line.includes("z.toJSONSchema("));
}

const offenders: string[] = [];
let ioCalls = 0;
for (const file of sourceFiles(path.join(repoRoot, "src"))) {
  const rel = path.relative(repoRoot, file);
  if (rel === HELPER) continue;
  const source = readFileSync(file, "utf8");
  for (const line of rawEmitterCalls(source)) {
    // An `io:` emission may sit on the following line once prettier wraps it,
    // so the whole call is what decides, not the line the name lands on.
    const at = source.indexOf(line);
    const window = source.slice(at, at + 200);
    if (/io:\s*"(input|output)"/.test(window)) {
      ioCalls += 1;
      continue;
    }
    offenders.push(`${rel}: ${line.trim()}`);
  }
}

describe("how a published schema is emitted", () => {
  // Without this the rule below passes on an empty scan, which is the failure
  // shape it exists to prevent one level up.
  it("finds the OpenAPI parameter emissions it deliberately exempts", () => {
    expect(ioCalls).toBeGreaterThan(0);
  });

  it("routes every tool schema through the helper", () => {
    expect(offenders).toEqual([]);
  });
});
