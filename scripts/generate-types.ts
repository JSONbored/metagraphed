import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.ts";
import {
  removeInlinedOpenApiSpec,
  writeInlinedOpenApiSpec,
} from "./openapi-inline-examples.ts";

const generatedOutputPath = path.join(repoRoot, "packages/contract/index.d.ts");
const publicOutputPath = path.join(repoRoot, "public/metagraph/types.d.ts");
const openapiTypescriptCli = path.join(
  repoRoot,
  "node_modules/openapi-typescript/bin/cli.js",
);

// Types are generated from the INLINED projection of the spec, not the
// published document: openapi-typescript cannot read the hoisted
// components.examples map and would drop every `@example` JSDoc block. See
// scripts/openapi-inline-examples.ts for the full reasoning — and note that
// validate-contract-drift.ts regenerates through the same module, so the two
// cannot disagree about what "current" means.
const { specPath, inlined } = await writeInlinedOpenApiSpec();

const result = spawnSync(process.execPath, [openapiTypescriptCli, specPath], {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: "pipe",
  // The generated .d.ts is ~1 MiB and growing with every new route; the default
  // 1 MiB stdout cap would SIGTERM the child (ENOBUFS) mid-stream. Match the
  // 32 MiB buffer the other build scripts already use so type-gen keeps working.
  maxBuffer: 32 * 1024 * 1024,
});

await removeInlinedOpenApiSpec(specPath);

if (result.status !== 0) {
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  process.exit(result.status || 1);
}

await fs.mkdir(path.dirname(generatedOutputPath), { recursive: true });
await fs.mkdir(path.dirname(publicOutputPath), { recursive: true });
await fs.writeFile(generatedOutputPath, result.stdout, "utf8");
await fs.writeFile(publicOutputPath, result.stdout, "utf8");

console.log(
  `Generated Metagraphed API TypeScript definitions (${inlined} worked example(s) inlined for JSDoc).`,
);
