import { buildOpenApiArtifact } from "../src/contracts.mjs";
import { buildApiComponentBundle } from "./bundle-schemas.mjs";
import { buildTimestamp } from "./lib.mjs";

export async function loadOpenApiComponentSchemas(
  generatedAt = buildTimestamp(),
) {
  const document = await buildApiComponentBundle();
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
