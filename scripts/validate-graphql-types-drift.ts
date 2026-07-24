import { promises as fs } from "node:fs";
import path from "node:path";
import { generateGraphqlTypes } from "./generate-graphql-types.ts";
import { repoRoot } from "./lib.ts";

// Drift gate for generated/graphql/types.ts (types-epic D, #7862) — same
// shape as validate-generated-client.ts: compare the committed file against
// a freshly-computed-in-memory expected value (generate(config, false),
// never written to disk), so this validator can never itself go stale
// relative to what `npm run build:graphql-types` would produce.
const outputs = await generateGraphqlTypes({ silent: true });
const errors: string[] = [];

for (const output of outputs) {
  const outputPath = path.join(repoRoot, output.filename);
  let current: string;
  try {
    current = await fs.readFile(outputPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      errors.push(
        `${output.filename} is missing. Run npm run build:graphql-types.`,
      );
      continue;
    }
    throw error;
  }
  if (current !== output.content) {
    errors.push(
      `${output.filename} is stale. Run npm run build:graphql-types and commit the result.`,
    );
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log("Generated GraphQL types are current.");
