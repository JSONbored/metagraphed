// types-epic B (#7860) acceptance criterion 3: public/metagraph/openapi.json
// must remain valid OpenAPI 3.1, checked against the *real* OpenAPI 3.1 meta-
// schema -- not just the ad-hoc literal/structural checks in
// scripts/validate-openapi.ts (which only asserts openapi.openapi === "3.1.0"
// and a handful of shape invariants, never actual meta-schema conformance).
//
// schemas/openapi-3.1-meta-schema.json is the OFFICIAL OpenAPI 3.1 JSON
// Schema, vendored verbatim from its canonical, versioned location
// (https://spec.openapis.org/oas/3.1/schema/2022-10-07, published by the
// OpenAPI Initiative) -- not hand-written or reconstructed from memory.
//
// `openapi-schema-validator` (npm) was evaluated and rejected for this: its
// published dist only bundles OpenAPI 2.0 and 3.0 meta-schemas, no 3.1
// support, despite implying broad "v3" coverage.
//
// Ajv $dynamicRef workaround (verified, not cosmetic): the official schema
// models "Schema Object" fields (Parameter.schema, MediaType.schema, etc.) as
// `{"$dynamicRef": "#meta"}`, intending it to resolve to the fuller
// json-schema-2020-12 + OAS dialect when THIS document is combined with
// https://spec.openapis.org/oas/3.1/dialect/base, or to fall back to this
// document's own lenient `$defs.schema: {type: ["object","boolean"]}`
// (its local $dynamicAnchor "meta") when used standalone. Empirically
// verified (against both a minimal known-valid document and several
// known-invalid ones) that ajv/dist/2020.js does NOT correctly perform that
// fallback: it resolves "#meta" back to the *enclosing* $defs node instead of
// the anchor-matching one, so e.g. Parameter.schema gets validated as if it
// were itself a full Parameter Object (requiring name/in/schema/content) --
// failing on every valid document, parameter or response schema. Registering
// the companion dialect/base + meta/base resources via ajv.addSchema() does
// not change this (they're never reached: nothing in the compiled graph
// $refs them, only a default string value mentions dialect/base's URI) --
// this is a genuine ajv $dynamicRef/$dynamicAnchor resolution gap, not a
// misconfiguration on this repo's part. inlineDynamicRefMetaFallback() below
// replaces every such node with the literal fallback it should already
// resolve to in the standalone (single-resource, no-dialect-combination)
// case this repo actually needs -- i.e. it makes ajv behave per-spec for this
// case, it does not loosen validation.
import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsPlugin from "ajv-formats";
import { readJson, repoRoot } from "../scripts/lib.ts";

type Row = Record<string, unknown>;

function inlineDynamicRefMetaFallback(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(inlineDynamicRefMetaFallback);
  if (!node || typeof node !== "object") return node;
  const obj = node as Row;
  if (obj.$dynamicRef === "#meta" && Object.keys(obj).length === 1) {
    return { type: ["object", "boolean"] };
  }
  const out: Row = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = inlineDynamicRefMetaFallback(value);
  }
  return out;
}

const addFormats = addFormatsPlugin as unknown as (instance: Ajv2020) => void;
const ajv = new Ajv2020({
  strict: false,
  validateFormats: true,
  allErrors: true,
});
addFormats(ajv);

const rawMetaSchema = await readJson(
  path.join(repoRoot, "schemas/openapi-3.1-meta-schema.json"),
);
const metaSchema = inlineDynamicRefMetaFallback(rawMetaSchema);
const validateOpenApi31 = ajv.compile(metaSchema as Row);

describe("public/metagraph/openapi.json conforms to the OpenAPI 3.1 meta-schema (#7860)", () => {
  test("the published contract validates against the official OpenAPI 3.1 schema", async () => {
    const openapi = await readJson(
      path.join(repoRoot, "public/metagraph/openapi.json"),
    );
    const valid = validateOpenApi31(openapi);
    assert.equal(
      valid,
      true,
      JSON.stringify(validateOpenApi31.errors, null, 2),
    );
  });

  // Guards against the meta-schema (or the workaround above) silently
  // degrading into a no-op that accepts anything.
  test("the validator still rejects a structurally invalid document", () => {
    const invalid = {
      openapi: "3.0.0", // wrong major/minor
      info: { title: "t", version: "1" },
      paths: {},
    };
    assert.equal(validateOpenApi31(invalid), false);
  });
});
