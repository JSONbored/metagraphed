// #5551: schemas/public-artifacts.schema.json documents the top-level shape of
// every generated public artifact (schema_version: 1, network: "finney", the
// required per-kind fields), but nothing ever validated a real artifact's data
// against it — it was only ajv.compile()-syntax-checked and fs.access()
// -existence-checked. scripts/validate-schemas.ts now validates each real
// artifact against the matching top-level $def. These tests lock that contract:
// a real committed artifact passes, and deliberate constraint violations fail.
import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsPlugin from "ajv-formats";
import { readJson, repoRoot } from "../scripts/lib.ts";

const schema = await readJson(
  path.join(repoRoot, "schemas/public-artifacts.schema.json"),
);
const addFormats = addFormatsPlugin as unknown as (instance: Ajv2020) => void;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema, schema.$id);

function validatorFor(defName: string) {
  return ajv.compile({ $ref: `${schema.$id}#/$defs/${defName}` });
}

const genericArtifact = validatorFor("genericArtifact");
const subnetsArtifact = validatorFor("subnetsArtifact");

// A real, committed artifact this schema's genericArtifact def directly covers.
const apiIndex = await readJson(
  path.join(repoRoot, "public/metagraph/api-index.json"),
);

describe("public-artifacts.schema.json validates real artifacts (#5551)", () => {
  test("the committed api-index.json artifact is valid", () => {
    assert.equal(
      genericArtifact(apiIndex),
      true,
      ajv.errorsText(genericArtifact.errors),
    );
  });

  test("rejects an artifact whose schema_version is not the const 1", () => {
    assert.equal(genericArtifact({ ...apiIndex, schema_version: 2 }), false);
  });

  test("rejects an artifact missing the required generated_at", () => {
    const { generated_at: _omitted, ...withoutGeneratedAt } = apiIndex;
    assert.equal(genericArtifact(withoutGeneratedAt), false);
  });

  test("rejects a subnets artifact whose network is not the const finney", () => {
    const bad = {
      schema_version: 1,
      generated_at: "1970-01-01T00:00:00.000Z",
      network: "test",
      source: {},
      subnets: [],
    };
    assert.equal(subnetsArtifact(bad), false);
    assert.match(ajv.errorsText(subnetsArtifact.errors), /network|finney/i);
  });

  test("accepts a minimally-valid subnets artifact (network: finney)", () => {
    const good = {
      schema_version: 1,
      generated_at: "1970-01-01T00:00:00.000Z",
      network: "finney",
      source: {},
      subnets: [],
    };
    assert.equal(
      subnetsArtifact(good),
      true,
      ajv.errorsText(subnetsArtifact.errors),
    );
  });
});
