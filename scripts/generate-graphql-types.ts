import { generate } from "@graphql-codegen/cli";
import { promises as fs } from "node:fs";
import path from "node:path";
import codegenConfig from "../codegen.ts";
import { repoRoot } from "./lib.ts";

// Runs @graphql-codegen/cli's programmatic API against codegen.ts
// (types-epic D, #7862). `generate(config, false)` returns the generated
// output in-memory instead of writing it -- used directly here (single
// source of truth for "what should generated/graphql/types.ts contain"),
// and reused by validate-graphql-types-drift.ts's stale-check so the two
// scripts can never compute a different "expected" content.
export async function generateGraphqlTypes(
  options: { silent?: boolean } = {},
): Promise<{ filename: string; content: string }[]> {
  return generate(
    { ...codegenConfig, cwd: repoRoot, silent: options.silent ?? false },
    false,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outputs = await generateGraphqlTypes();
  for (const output of outputs) {
    await fs.mkdir(path.dirname(output.filename), { recursive: true });
    await fs.writeFile(output.filename, output.content, "utf8");
  }
  console.log("Generated GraphQL resolver/argument types.");
}
