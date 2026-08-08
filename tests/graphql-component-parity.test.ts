import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { GraphQLObjectType } from "graphql";
import { emitTypes, pascalCase } from "../schemas-src/graphql/emit.ts";
import {
  checkComponentParity,
  extractSdl,
  type OpenApiDocument,
} from "../scripts/validate-graphql-component-parity.ts";

const openapi = JSON.parse(
  readFileSync("public/metagraph/openapi.json", "utf8"),
) as OpenApiDocument;
const sdl = extractSdl(readFileSync("src/graphql-sdl.ts", "utf8"))!;

describe("Zod -> GraphQL type emitter (#10214)", () => {
  test("emits an object type for every registry component that has fields", () => {
    const { types } = emitTypes();
    assert.ok(
      types.size > 250,
      `expected the registry to yield the full type system, got ${types.size}`,
    );
    for (const name of [
      "SelfHealthArtifact",
      "SelfHealthLane",
      "BuildSummaryArtifact",
    ]) {
      assert.ok(
        types.get(name) instanceof GraphQLObjectType,
        `${name} missing`,
      );
    }
  });

  test("a pinned literal version is an Int, not a Float", () => {
    // z.literal(1) emits {type:"number", const:1}. Reading `type` before
    // `const` published Float for all 68 components that pin schema_version
    // that way, against Int on the 140 using z.int() -- the same field, two
    // types, decided by which Zod call the author reached for.
    const { types } = emitTypes();
    const field = types.get("SelfHealthArtifact")!.getFields().schema_version;
    assert.equal(field.type.toString(), "Int!");
  });

  test("drops properties GraphQL cannot name rather than inventing one", () => {
    const { unnameable } = emitTypes();
    // `x-metagraphed` is an OpenAPI vendor extension on the OpenApiArtifact.
    // Renaming it to `xMetagraphed` would publish a field name that appears in
    // no contract, so it is reported and skipped instead.
    assert.ok(
      unnameable.includes("OpenApiArtifact.x-metagraphed"),
      `expected the vendor extension to be reported, got ${unnameable.join(", ")}`,
    );
    for (const entry of unnameable) {
      assert.match(
        entry,
        /[.-]/,
        "an unnameable entry names the path it was dropped from",
      );
    }
  });

  test("drops a z.null() property instead of publishing an empty field", () => {
    const { nullOnly, types } = emitTypes();
    // buildContractsArtifact hardcodes `status_domain: null`, so z.null() is
    // faithful -- and GraphQL has no null type. Publishing it as JSON would
    // advertise a field a client can select and never learn anything from.
    assert.ok(
      nullOnly.includes("ContractsArtifact.status_domain"),
      `expected the null-only field to be reported, got ${nullOnly.join(", ")}`,
    );
    assert.equal(
      types.get("ContractsArtifact")!.getFields().status_domain,
      undefined,
    );
  });

  test("pascalCase joins on any non-alphanumeric boundary", () => {
    assert.equal(pascalCase("subnet_health"), "SubnetHealth");
    assert.equal(pascalCase("coverage-gaps"), "CoverageGaps");
    assert.equal(pascalCase("already"), "Already");
  });
});

describe("graphql component parity gate (#10214)", () => {
  test("the committed SDL declares every field its components publish", () => {
    const report = checkComponentParity(sdl, openapi);
    assert.deepEqual(
      report.violations,
      [],
      "a component field GraphQL does not expose is drift, not a choice",
    );
    assert.ok(
      report.comparedTypes > 300,
      `only ${report.comparedTypes} types compared`,
    );
    assert.ok(
      report.comparedFields > 2000,
      `only ${report.comparedFields} fields compared`,
    );
  });

  test("it FAILS when a type stops declaring a field its component publishes", () => {
    // Delete SelfHealth.stale_lane_count -- one of the fields this gate was
    // written to catch. Without this the gate is only ever run against a
    // passing tree, which proves it runs, not that it can fail.
    const broken = sdl.replace(/^ {4}stale_lane_count: Int\n/m, "");
    assert.notEqual(broken, sdl, "the fixture field must exist to be removed");
    const report = checkComponentParity(broken, openapi);
    assert.ok(
      report.violations.some((v) =>
        v.startsWith("SelfHealth.stale_lane_count"),
      ),
      `expected the removed field to be reported, got: ${report.violations.join("; ")}`,
    );
  });

  test("a DECLARED omission is accepted, and a stale one fails", () => {
    const broken = sdl.replace(/^ {4}stale_lane_count: Int\n/m, "");
    const key = "SelfHealth.stale_lane_count";
    const accepted = checkComponentParity(broken, openapi, {
      [key]: "under test",
    });
    assert.ok(
      !accepted.violations.some((v) => v.startsWith(key)),
      "a declared omission must not be reported as a violation",
    );
    assert.deepEqual(
      accepted.stale,
      [],
      "the entry matches a live omission, so it is not stale",
    );

    // Same entry against the UNBROKEN schema: the omission is gone, so the
    // exemption has to go with it. This is what stops the list from growing.
    const fixed = checkComponentParity(sdl, openapi, { [key]: "under test" });
    assert.deepEqual(fixed.stale, [key]);
  });

  test("resolver-built pagination views are skipped, not compared", () => {
    const report = checkComponentParity(sdl, openapi);
    assert.ok(
      report.projections.length > 0,
      "the list views the resolvers build are not mirrors and must be skipped",
    );
    assert.ok(
      report.projections.some((p) => p.startsWith("EndpointList ")),
      `expected EndpointList among the projections, got ${report.projections.join(", ")}`,
    );
  });
});
