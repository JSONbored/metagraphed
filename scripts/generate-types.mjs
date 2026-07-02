import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot } from "./lib.mjs";

const generatedOutputPath = path.join(
  repoRoot,
  "generated/metagraphed-api.d.ts",
);
const publicOutputPath = path.join(repoRoot, "public/metagraph/types.d.ts");
const openapiTypescriptCli = path.join(
  repoRoot,
  "node_modules/openapi-typescript/bin/cli.js",
);

async function generateTypes() {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "metagraphed-types-"),
  );
  const tempOutputPath = path.join(tempDir, "types.d.ts");
  try {
    const result = spawnSync(
      process.execPath,
      [
        openapiTypescriptCli,
        "public/metagraph/openapi.json",
        "--output",
        tempOutputPath,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: "pipe",
      },
    );

    if (result.status !== 0) {
      process.stdout.write(result.stdout || "");
      process.stderr.write(result.stderr || "");
      process.exit(result.status || 1);
    }
    return await fs.readFile(tempOutputPath, "utf8");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

const generatedTypes = await generateTypes();

await fs.mkdir(path.dirname(generatedOutputPath), { recursive: true });
await fs.mkdir(path.dirname(publicOutputPath), { recursive: true });
await fs.writeFile(generatedOutputPath, generatedTypes, "utf8");
await fs.writeFile(publicOutputPath, generatedTypes, "utf8");

console.log("Generated Metagraphed API TypeScript definitions.");
