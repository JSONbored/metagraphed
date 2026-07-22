import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.mjs";

const generatedOutputPath = path.join(repoRoot, "packages/contract/index.d.ts");
const publicOutputPath = path.join(repoRoot, "public/metagraph/types.d.ts");
const openapiTypescriptCli = path.join(
  repoRoot,
  "node_modules/openapi-typescript/bin/cli.js",
);
const result = spawnSync(
  process.execPath,
  [openapiTypescriptCli, "public/metagraph/openapi.json"],
  {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    // The generated .d.ts is ~1 MiB and growing with every new route; the default
    // 1 MiB stdout cap would SIGTERM the child (ENOBUFS) mid-stream. Match the
    // 32 MiB buffer the other build scripts already use so type-gen keeps working.
    maxBuffer: 32 * 1024 * 1024,
  },
);

if (result.status !== 0) {
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  process.exit(result.status || 1);
}

await fs.mkdir(path.dirname(generatedOutputPath), { recursive: true });
await fs.mkdir(path.dirname(publicOutputPath), { recursive: true });
await fs.writeFile(generatedOutputPath, result.stdout, "utf8");
await fs.writeFile(publicOutputPath, result.stdout, "utf8");

console.log("Generated Metagraphed API TypeScript definitions.");
