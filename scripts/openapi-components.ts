// The published OpenAPI component set. ONE source: schemas-src (#9830).
//
// Until #9830 this function merged two sources -- a bundle of hand-written
// JSON Schema under schemas/components/*.schema.json, with the Zod-owned
// components overlaid on top "so they win if a stale hand-edited key with the
// same name ever reappears". That overlay is why the contract could drift
// without anyone noticing: a component had two possible homes, only one of
// them was type-checked, and editing the wrong one changed nothing at all
// (schemas/api-components.schema.json is a build OUTPUT, so an edit there was
// silently overwritten on the next build, with no error).
//
// Every component now comes from schemas-src/openapi-registry.ts. There is no
// second source to shadow, so there is nothing to merge and no precedence
// rule to get wrong. scripts/validate-single-schema-source.ts fails the build
// if a hand-written component layer reappears.
import { buildOpenApiArtifact } from "../src/contracts.ts";
import { generateOpenApiZodComponents } from "./generate-openapi-zod-components.ts";
import { buildTimestamp } from "./lib.ts";

type Row = Record<string, unknown>;

export async function loadOpenApiComponentSchemas(
  generatedAt: string = buildTimestamp(),
): Promise<Row> {
  return {
    ...generateOpenApiZodComponents(),
    GeneratedOpenApiMarker: {
      type: "object",
      properties: {
        generated_at: { const: generatedAt },
      },
    },
  };
}

export async function buildCanonicalOpenApiArtifact(
  generatedAt: string = buildTimestamp(),
): Promise<Row> {
  return buildOpenApiArtifact(
    generatedAt,
    await loadOpenApiComponentSchemas(generatedAt),
  );
}
