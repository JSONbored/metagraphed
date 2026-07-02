import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.mjs";

const outputPaths = [
  path.join(repoRoot, "generated/metagraphed-api.d.ts"),
  path.join(repoRoot, "public/metagraph/types.d.ts"),
];
const result = spawnSync(
  process.execPath,
  [
    path.join(repoRoot, "node_modules/openapi-typescript/bin/cli.js"),
    "public/metagraph/openapi.json",
  ],
  {
    cwd: repoRoot,
    encoding: "utf8",
  },
);

if (result.status !== 0) {
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  process.exit(result.status || 1);
}

for (const outputPath of outputPaths) {
  let current;
  try {
    current = await fs.readFile(outputPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      console.error(
        "Generated API types are missing. Run npm run types:generate.",
      );
      process.exit(1);
    }
    throw error;
  }

  if (current !== result.stdout) {
    console.error(
      "Generated API types are stale. Run npm run types:generate and commit the result.",
    );
    process.exit(1);
  }
}

console.log("Generated API types are current.");
