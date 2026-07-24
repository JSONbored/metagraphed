import { buildOpenApiArtifact } from "../src/contracts.ts";
import { buildApiComponentBundle } from "./bundle-schemas.ts";
import { generateOpenApiZodComponents } from "./generate-openapi-zod-components.ts";
import { buildTimestamp } from "./lib.ts";

type Row = Record<string, unknown>;

export async function loadOpenApiComponentSchemas(
  generatedAt: string = buildTimestamp(),
): Promise<Row> {
  const document = await buildApiComponentBundle();
  return {
    ...structuredClone((document.components as Row).schemas as Row),
    // Zod-owned components (types-epic B, #7860) -- overlaid last so they
    // win if a stale hand-edited key with the same name ever reappears
    // (schemas/components/*.schema.json already has the pilot keys deleted;
    // this is belt-and-suspenders, not the primary mechanism).
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
