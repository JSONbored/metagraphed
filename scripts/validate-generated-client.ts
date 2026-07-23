import { promises as fs } from "node:fs";
import path from "node:path";
import { generateClientSource } from "./generate-client.ts";
import { repoRoot } from "./lib.ts";

const outputPath = path.join(repoRoot, "generated/metagraphed-client.ts");
const expected = generateClientSource();

let current: string;
try {
  current = await fs.readFile(outputPath, "utf8");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    console.error("Generated API client helper is missing. Run npm run build.");
    process.exit(1);
  }
  throw error;
}

if (current !== expected) {
  console.error(
    "Generated API client helper is stale. Run npm run build and commit the result.",
  );
  process.exit(1);
}

console.log("Generated API client helper is current.");
