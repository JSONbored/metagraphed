import path from "node:path";
import { buildOpenApiArtifact } from "../src/contracts.mjs";
import { buildTimestamp, readJson, repoRoot } from "./lib.mjs";

export async function loadOpenApiComponentSchemas(
  generatedAt = buildTimestamp(),
) {
  const document = await readJson(
    path.join(repoRoot, "schemas/api-components.schema.json"),
  );
  return {
    ...structuredClone(document.components.schemas),
    GeneratedOpenApiMarker: {
      type: "object",
      properties: {
        generated_at: { const: generatedAt },
      },
    },
  };
}

export async function buildCanonicalOpenApiArtifact(
  generatedAt = buildTimestamp(),
) {
  return buildOpenApiArtifact(
    generatedAt,
    await loadOpenApiComponentSchemas(generatedAt),
  );
}
