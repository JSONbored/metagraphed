import path from "node:path";
import { buildCanonicalOpenApiArtifact } from "./openapi-components.ts";
import { repoRoot, stableStringify, writeJson } from "./lib.ts";

type Row = Record<string, unknown>;

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write");
const openapi: Row = await buildCanonicalOpenApiArtifact();
const outputPath = path.join(repoRoot, "public/metagraph/openapi.json");

if (shouldWrite) {
  await writeJson(outputPath, openapi);
}

console.log(
  stableStringify({
    mode: shouldWrite ? "write" : "dry-run",
    path_count: Object.keys(openapi.paths || {}).length,
    schema_count: Object.keys(
      (openapi.components as Row | undefined)?.schemas || {},
    ).length,
    output_path: "/metagraph/openapi.json",
  }),
);
