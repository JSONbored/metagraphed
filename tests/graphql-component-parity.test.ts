import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { GraphQLObjectType } from "graphql";
import { emitTypes, pascalCase } from "../schemas-src/graphql/emit.ts";
import { PROJECTED_TYPES } from "../schemas-src/graphql/published-names.ts";
import {
  DECLARED,
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
    // A floor against the gate going BLIND (pairing nothing and reporting no
    // violations), not a target. It moves down as shared shapes get
    // registered and their duplicate mirrors collapse -- #10214 took this
    // from 324 to 299 by giving 41 inlined copies their names back -- so it
    // is set well under the current count. Blindness reads near zero.
    assert.ok(
      report.comparedTypes > 250,
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

/** Rewrite one field inside ONE named type, so a fixture cannot land on a
 * same-named field in another type and quietly test nothing. */
function inType(
  source: string,
  typeName: string,
  find: RegExp,
  replace: string,
): string {
  const start = source.search(new RegExp(`^ {2}type ${typeName} \\{$`, "m"));
  assert.notEqual(start, -1, `no type ${typeName} in the SDL`);
  const end = source.indexOf("\n  }\n", start) + "\n  }\n".length;
  const block = source.slice(start, end);
  const rewritten = block.replace(find, replace);
  assert.notEqual(rewritten, block, `${find} did not match inside ${typeName}`);
  return source.slice(0, start) + rewritten + source.slice(end);
}

describe("declared projections (#10214)", () => {
  test("every declared projection is checked, and against real fields", () => {
    const report = checkComponentParity(sdl, openapi);
    assert.deepEqual(report.violations, []);
    assert.equal(
      report.projectedTypes,
      Object.keys(PROJECTED_TYPES).length,
      "every declaration must be reached -- a skipped one is unchecked",
    );
    // These 15 types were reached by ZERO gates before this pass: the mirror
    // traversal seeds from Query's `Mirrors GET` annotations and a
    // resolver-built type has none, so nothing ever compared their fields.
    assert.ok(
      report.projectedFields > 100,
      `only ${report.projectedFields} projected fields compared`,
    );
  });

  test("it FAILS when a projection promises non-null over a nullable field", () => {
    // The response-shaped outage this pass exists for: graphql-js cannot hold
    // a null in a non-null position, so it nulls the whole surrounding object
    // and attaches an error. `Surface.status` is nullable in its component.
    const broken = inType(
      sdl,
      "Surface",
      /^ {4}status: String$/m,
      "    status: String!",
    );
    const report = checkComponentParity(broken, openapi);
    assert.ok(
      report.violations.some((v) => /the SDL declares it non-null/.test(v)),
      `expected a non-null violation, got: ${report.violations.join("; ")}`,
    );
  });

  test("it FAILS on a field neither the component nor `added` supplies", () => {
    const broken = inType(
      sdl,
      "Surface",
      /^ {2}type Surface \{$/m,
      "  type Surface {\n    invented_field: String",
    );
    const report = checkComponentParity(broken, openapi);
    assert.ok(
      report.violations.some((v) =>
        v.startsWith("Surface.invented_field -- neither"),
      ),
      `expected the invented field to be reported, got: ${report.violations.join("; ")}`,
    );
  });

  test("a stale `added` entry fails, so the list can only shrink", () => {
    // OpportunityEntry declares `validator_headroom` as resolver-added. Remove
    // it from the SDL and the declaration has to go too -- otherwise `added`
    // accumulates permissions for fields that no longer exist.
    const broken = inType(
      sdl,
      "OpportunityEntry",
      /^ {4}validator_headroom: Int\n/m,
      "",
    );
    const report = checkComponentParity(broken, openapi);
    assert.ok(
      report.violations.some((v) =>
        v.startsWith(
          "OpportunityEntry.validator_headroom -- declared as resolver-added",
        ),
      ),
      `expected the stale added entry to be reported, got: ${report.violations.join("; ")}`,
    );
  });
});

// Scalar identity (#10377's blind spot). Until this check, `String` against
// `JSON` read as agreement, so an emitter that retyped 348 fields as JSON
// would have passed every gate in the repo.
describe("scalar identity", () => {
  test("every JSON under-typing is declared, and all of them are live", () => {
    const report = checkComponentParity(sdl, openapi);
    assert.deepEqual(report.violations, []);
    assert.deepEqual(report.stale, []);
    assert.equal(report.undertyped, 28);
  });

  test("it FAILS when a field is retyped to a different scalar", () => {
    // The whole class the gate was blind to: a `String` where the component
    // publishes an OBJECT throws at serialization and nulls the surrounding
    // object, and the old comparison read it as agreement.
    const broken = inType(
      sdl,
      "SubnetHyperparameters",
      /^ {4}hyperparameters: Hyperparameters\n/m,
      "    hyperparameters: String\n",
    );
    const report = checkComponentParity(broken, openapi);
    assert.ok(
      report.violations.some((v) =>
        v.startsWith(
          "SubnetHyperparameters.hyperparameters -- the SDL declares String",
        ),
      ),
      `expected the retyped field to be reported, got: ${report.violations.join("; ")}`,
    );
  });

  test("it FAILS on a NEW under-typing that is not declared", () => {
    const broken = inType(
      sdl,
      "SubnetHyperparameters",
      /^ {4}hyperparameters: Hyperparameters\n/m,
      "    hyperparameters: JSON\n",
    );
    const report = checkComponentParity(broken, openapi);
    assert.ok(
      report.violations.some((v) =>
        v.includes("declare it in JSON_UNDERTYPED or publish the type"),
      ),
      `expected the new under-typing to be reported, got: ${report.violations.join("; ")}`,
    );
  });

  test("a CLOSED under-typing makes its declaration stale, so the list shrinks", () => {
    const fixed = inType(
      sdl,
      "SubnetConviction",
      /^ {4}king: JSON\n/m,
      "    king: String\n",
    );
    const report = checkComponentParity(fixed, openapi);
    assert.ok(
      report.stale.includes("SubnetConviction.king"),
      `expected the closed under-typing to be reported stale, got: ${report.stale.join("; ")}`,
    );
    assert.equal(report.undertyped, 27);
  });

  test("a Float over an Int component field is a WIDENING and stays allowed", () => {
    // 13 fields declare it deliberately for a computed value whose component
    // holds whole numbers today. The dangerous direction -- Int over Float --
    // is the separate narrowing check.
    const report = checkComponentParity(sdl, openapi);
    assert.ok(
      !report.violations.some((v) =>
        v.includes("ChainTurnoverNetwork.stability_score"),
      ),
    );
  });
});

// Paginated views (#10404). They used to be SKIPPED wholesale on the rule "two
// or more pagination fields the component lacks means this is a view" -- true
// of the paging and false of the 158 fields behind it.
describe("paginated views", () => {
  test("all 25 are declared, and their drops are the whole set", () => {
    const report = checkComponentParity(sdl, openapi);
    assert.deepEqual(report.violations, []);
    assert.equal(report.projections.length, 25);
    // Every projection's drops, not just the paginated ones -- `dropped` is
    // the whole set on all 38, which is what makes an undeclared drop a
    // failure rather than a silence.
    assert.equal(report.droppedFields, 194);
  });

  test("it FAILS when a component field is neither published nor declared dropped", () => {
    // The whole point: a field vanishing from a published view used to be a
    // silence. `min_incident_samples` is the threshold behind an incident
    // count -- the confident-zeros class (#9803).
    const report = checkComponentParity(sdl, openapi, DECLARED, {
      ...PROJECTED_TYPES,
      GlobalIncidents: {
        ...PROJECTED_TYPES.GlobalIncidents,
        dropped: [],
      },
    });
    assert.ok(
      report.violations.some((v) =>
        v.startsWith(
          "GlobalIncidents.min_incident_samples -- GlobalIncidentsArtifact publishes it",
        ),
      ),
      `expected the undeclared drop to be reported, got: ${report.violations.join("; ")}`,
    );
  });

  test("a STALE drop fails, so the list only shrinks", () => {
    const report = checkComponentParity(sdl, openapi, DECLARED, {
      ...PROJECTED_TYPES,
      GlobalIncidents: {
        ...PROJECTED_TYPES.GlobalIncidents,
        dropped: [
          ...(PROJECTED_TYPES.GlobalIncidents.dropped ?? []),
          "surfaces",
        ],
      },
    });
    assert.ok(
      report.violations.some((v) =>
        v.startsWith(
          "GlobalIncidents.surfaces -- declared as dropped, and the SDL publishes it",
        ),
      ),
      `expected the stale drop to be reported, got: ${report.violations.join("; ")}`,
    );
  });

  test("a drop naming a field the component does not publish is a typo", () => {
    const report = checkComponentParity(sdl, openapi, DECLARED, {
      ...PROJECTED_TYPES,
      GlobalIncidents: {
        ...PROJECTED_TYPES.GlobalIncidents,
        dropped: [
          ...(PROJECTED_TYPES.GlobalIncidents.dropped ?? []),
          "min_incident_sample",
        ],
      },
    });
    assert.ok(
      report.violations.some((v) => v.includes("publishes no such field")),
      `expected the typo to be reported, got: ${report.violations.join("; ")}`,
    );
  });

  test("a rename that names a field the component lacks fails", () => {
    // `items` IS the component's row array under another name; declaring the
    // wrong source silently compares nothing.
    const report = checkComponentParity(sdl, openapi, DECLARED, {
      ...PROJECTED_TYPES,
      BlockList: { ...PROJECTED_TYPES.BlockList, itemsFrom: "rows" },
    });
    assert.ok(
      report.violations.some((v) =>
        v.startsWith("BlockList.items -- declared as renaming"),
      ),
      `expected the bad rename to be reported, got: ${report.violations.join("; ")}`,
    );
  });

  test("an UNDECLARED paginated view is a violation, not a skip", () => {
    const { GlobalIncidents: _dropped, ...withoutOne } = PROJECTED_TYPES;
    const report = checkComponentParity(sdl, openapi, DECLARED, withoutOne);
    assert.ok(
      report.violations.some((v) =>
        v.startsWith("GlobalIncidents -- pages over GlobalIncidentsArtifact"),
      ),
      `expected the undeclared view to be reported, got: ${report.violations.join("; ")}`,
    );
  });
});
