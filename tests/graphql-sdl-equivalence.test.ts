// The equivalence report is the measure of how far #10214 has to go, so it has
// to be able to report a gap -- a reporter that says "0 differences" no matter
// what is worse than no reporter.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { reportEquivalence } from "../scripts/report-graphql-sdl-equivalence.ts";
import { extractSdl } from "../scripts/validate-graphql-component-parity.ts";
import { QUERY_BINDINGS } from "../schemas-src/graphql/published-names.ts";
import type { OpenApiParameters } from "../schemas-src/graphql/query-arguments.ts";

const sdl = extractSdl(readFileSync("src/graphql-sdl.ts", "utf8"))!;
const openapi = JSON.parse(
  readFileSync("public/metagraph/openapi.json", "utf8"),
) as OpenApiParameters;

describe("sdl equivalence", () => {
  test("every published object type has a generator source", () => {
    const report = reportEquivalence(sdl, openapi);
    assert.deepEqual(report.missingTypes, []);
    assert.equal(report.generatedTypes, report.publishedTypes);
    assert.equal(report.differences.length, 0);
  });

  test("every Query return type comes from the registry", () => {
    const report = reportEquivalence(sdl, openapi);
    assert.equal(report.queryFieldsExact, QUERY_BINDINGS.length);
  });

  test("it REPORTS a published type nothing generates", () => {
    // A type the SDL declares that is neither an emitted component, nor a
    // declared projection, nor declared resolver-built, is the exact hole the
    // cutover would fall into.
    const withOrphan = `${sdl}\n  type OrphanedByNothing {\n    x: String\n  }\n`;
    const report = reportEquivalence(withOrphan, openapi);
    assert.deepEqual(report.missingTypes, ["OrphanedByNothing"]);
  });

  test("it REPORTS a return type the registry disagrees with", () => {
    const drifted = sdl.replace(
      "    subnets(\n",
      "    subnets_renamed_by_a_test(\n",
    );
    const report = reportEquivalence(drifted, openapi);
    assert.ok(
      report.differences.some((line) =>
        line.startsWith("Query.subnets -- QUERY_BINDINGS declares it"),
      ),
      `expected the missing Query field to be reported, got: ${report.differences.join("; ")}`,
    );
  });

  test("the argument count is the DERIVED one, not a restatement of the SDL", () => {
    // 187 fields derive exactly (#10403); the 9 with no route and the 20
    // missing `network` (#10394) do not. A reporter that echoed the SDL back
    // would say 196 and mean nothing.
    const report = reportEquivalence(sdl, openapi);
    assert.ok(report.queryArgumentsExact > 150);
    assert.ok(report.queryArgumentsExact < QUERY_BINDINGS.length);
  });
});
