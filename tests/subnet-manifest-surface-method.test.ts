// #11146 phase 3: the surface `method` dimension. The registry can now NAME a
// declared mutation (POST/PUT/PATCH/DELETE) instead of only representing what
// the prober can GET.
//
// Two contracts under test, and the second is the load-bearing one:
//   1. absent means GET -- every pre-existing surface validates unchanged, and
//      a surface may say `method: "GET"` explicitly with a probe.
//   2. a non-GET surface may NEVER enable a probe. The prober only speaks
//      GET/HEAD, and probing a mutation with GET would score a route nobody
//      declared -- so the cross-field rule must REJECT, not merely warn.
import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsPlugin from "ajv-formats";
import { readJson, repoRoot } from "../scripts/lib.ts";
import { QUERY_ENUMS } from "../src/contracts.ts";

const addFormats = addFormatsPlugin as unknown as (instance: Ajv2020) => void;
const ajv = new Ajv2020({
  strict: false,
  validateFormats: true,
  allErrors: true,
});
addFormats(ajv);
const manifestSchema = await readJson(
  path.join(repoRoot, "schemas/subnet-manifest.schema.json"),
);
const validate = ajv.compile(manifestSchema);

type Json = Record<string, unknown>;

function manifest(surfaceOverrides: Json): Json {
  return {
    schema_version: 1,
    netuid: 105,
    name: "Beam",
    slug: "sn-105",
    status: "active",
    categories: ["compute"],
    surfaces: [
      {
        id: "sn-105-beam-orchestrator-register",
        name: "Beam orchestrator registration",
        kind: "subnet-api",
        url: "https://beamcore.b1m.ai/orchestrators/register",
        provider: "beam",
        auth_required: true,
        authority: "community",
        public_safe: true,
        ...surfaceOverrides,
      },
    ],
  };
}

function errorsFor(doc: Json): string[] {
  validate(doc);
  return (validate.errors || []).map(
    (error) => `${error.instancePath} ${error.message}`,
  );
}

describe("absent means GET", () => {
  test("a surface with no method still validates (all 3,329 existing rows)", () => {
    assert.deepEqual(errorsFor(manifest({})), []);
  });

  test("an explicit GET with an enabled probe validates", () => {
    assert.deepEqual(
      errorsFor(
        manifest({
          method: "GET",
          probe: { enabled: true, method: "GET", expect: "json" },
        }),
      ),
      [],
    );
  });

  test("the schema's enum is the QUERY_ENUMS vocabulary, by value", () => {
    // validate:schema-enums pins this in CI; the test pins it in the suite so
    // a drift fails close to the declaration.
    const surfaceDef = (manifestSchema.$defs as Json).surface as Json;
    const methodProp = ((surfaceDef.properties as Json).method as Json)
      .enum as string[];
    assert.deepEqual(methodProp, [...QUERY_ENUMS.surfaceMethod]);
  });
});

describe("a declared mutation", () => {
  test("validates with no probe block at all", () => {
    assert.deepEqual(errorsFor(manifest({ method: "POST" })), []);
  });

  test("validates with a probe explicitly disabled", () => {
    assert.deepEqual(
      errorsFor(
        manifest({
          method: "POST",
          probe: { enabled: false, method: "GET", expect: "json" },
        }),
      ),
      [],
    );
  });

  test("is REJECTED with an enabled probe -- the prober never GETs a mutation", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const errors = errorsFor(
        manifest({
          method,
          probe: { enabled: true, method: "GET", expect: "json" },
        }),
      );
      assert.ok(
        errors.some((error) => error.includes("/probe/enabled")),
        `${method} + enabled probe must fail on probe.enabled, got: ${errors.join("; ")}`,
      );
    }
  });

  test("an out-of-vocabulary method is rejected", () => {
    const errors = errorsFor(manifest({ method: "OPTIONS" }));
    assert.ok(
      errors.some((error) => error.includes("/method")),
      errors.join("; "),
    );
  });
});
