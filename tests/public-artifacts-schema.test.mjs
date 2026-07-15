// #5551: schemas/public-artifacts.schema.json documents the top-level shape of
// every generated public artifact (the `schema_version: 1` const from
// artifactBase, per-kind required properties, `base_path: "/metagraph"`, etc.)
// but was only ever ajv-compiled for syntax — nothing validated real artifact
// data against it, and validate.mjs merely existence-checked the file. These
// tests exercise the schema directly: the real committed artifacts must pass
// against the `$def` their top-level property `$ref`s, and each documented
// constraint must reject a fixture that violates it.
import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readJson, repoRoot } from "../scripts/lib.mjs";

const SCHEMA_ID = "https://metagraph.sh/schemas/public-artifacts.schema.json";

const ajv = new Ajv2020({
  strict: false,
  validateFormats: true,
  allErrors: true,
});
addFormats(ajv);
ajv.addSchema(
  await readJson(path.join(repoRoot, "schemas/public-artifacts.schema.json")),
);

const validatorFor = (property) =>
  ajv.getSchema(`${SCHEMA_ID}#/properties/${property}`);

// The committed artifacts this schema covers (the rest — providers, subnets,
// health, ... — are R2-only / gitignored, built and served on deploy).
const COMMITTED = {
  api_index: "public/metagraph/api-index.json",
  contracts: "public/metagraph/contracts.json",
  r2_manifest: "public/metagraph/r2-manifest.json",
};

describe("public-artifacts.schema.json enforcement (#5551)", () => {
  for (const [property, file] of Object.entries(COMMITTED)) {
    test(`the committed ${property} artifact validates against its $def`, async () => {
      const validate = validatorFor(property);
      const data = await readJson(path.join(repoRoot, file));
      assert.equal(validate(data), true, JSON.stringify(validate.errors));
    });
  }

  test("rejects an artifact whose schema_version is not the const 1", async () => {
    const validate = validatorFor("api_index");
    const bad = structuredClone(
      await readJson(path.join(repoRoot, COMMITTED.api_index)),
    );
    bad.schema_version = 2;
    assert.equal(validate(bad), false);
  });

  test("rejects an artifact missing the required generated_at", async () => {
    const validate = validatorFor("api_index");
    const bad = structuredClone(
      await readJson(path.join(repoRoot, COMMITTED.api_index)),
    );
    delete bad.generated_at;
    assert.equal(validate(bad), false);
  });

  test("rejects a contracts artifact whose base_path isn't /metagraph", async () => {
    const validate = validatorFor("contracts");
    const bad = structuredClone(
      await readJson(path.join(repoRoot, COMMITTED.contracts)),
    );
    bad.base_path = "/not-metagraph";
    assert.equal(validate(bad), false);
  });

  test("rejects a contracts artifact missing a required property", async () => {
    const validate = validatorFor("contracts");
    const bad = structuredClone(
      await readJson(path.join(repoRoot, COMMITTED.contracts)),
    );
    delete bad.artifacts;
    assert.equal(validate(bad), false);
  });
});
