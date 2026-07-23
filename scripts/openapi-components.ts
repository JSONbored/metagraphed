import { buildOpenApiArtifact } from "../src/contracts.ts";
import { buildApiComponentBundle } from "./bundle-schemas.ts";
import { buildTimestamp } from "./lib.ts";

type Row = Record<string, unknown>;

export async function loadOpenApiComponentSchemas(
  generatedAt: string = buildTimestamp(),
): Promise<Row> {
  const document = await buildApiComponentBundle();
  return {
    ...structuredClone((document.components as Row).schemas as Row),
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
