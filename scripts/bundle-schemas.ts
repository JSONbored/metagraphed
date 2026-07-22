import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, repoRoot, stableStringify, writeJson } from "./lib.mjs";

const writeMode = process.argv.includes("--write");
const componentRoot = path.join(repoRoot, "schemas/components");
const outputPath = path.join(repoRoot, "schemas/api-components.schema.json");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bundled = await buildApiComponentBundle();

  if (writeMode) {
    await writeJson(outputPath, bundled);
    console.log("Bundled OpenAPI component schemas.");
  } else {
    const current = await readJson(outputPath);
    if (stableStringify(current) !== stableStringify(bundled)) {
      console.error(
        "Bundled OpenAPI component schema is stale. Run npm run schemas:bundle.",
      );
      process.exit(1);
    }
    console.log("Bundled OpenAPI component schema is current.");
  }
}

export async function buildApiComponentBundle(): Promise<
  Record<string, unknown>
> {
  const entries = (await fs.readdir(componentRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".schema.json"))
    .map((entry) => entry.name)
    .sort();

  const schemas: Record<string, unknown> = {};
  for (const entry of entries) {
    const document = await readJson(path.join(componentRoot, entry));
    const components = document.components?.schemas || {};
    for (const [name, schema] of Object.entries(components)) {
      if (schemas[name]) {
        throw new Error(`Duplicate OpenAPI component schema: ${name}`);
      }
      schemas[name] = schema;
    }
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://metagraph.sh/schemas/api-components.schema.json",
    title: "Metagraphed API Component Schemas",
    description:
      "Generated bundle of canonical reusable JSON Schema components embedded into the generated OpenAPI contract. Edit schemas/components/*.schema.json instead.",
    type: "object",
    required: ["components"],
    properties: {
      components: {
        type: "object",
        required: ["schemas"],
        properties: {
          schemas: {
            type: "object",
            additionalProperties: true,
          },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
    components: {
      schemas,
    },
  };
}
