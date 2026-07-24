import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import kanelPkg from "kanel";
import {
  startScratchPostgres,
  stopScratchPostgres,
} from "./db-types-scratch-container.ts";
import { repoRoot } from "./lib.ts";

// Drift gate for generated/db/ (types-epic C, #7861). Unlike the GraphQL
// codegen drift check, Kanel's processDatabase() only writes to disk (no
// in-memory return mode) -- so this regenerates into a TEMP directory and
// diffs the resulting file tree against the committed generated/db/,
// exactly as the issue specifies, rather than the generate(config, false)
// pattern validate-graphql-types-drift.ts uses.
async function collectFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        files.set(
          path.relative(root, fullPath),
          await fs.readFile(fullPath, "utf8"),
        );
      }
    }
  }
  await walk(root);
  return files;
}

const { processDatabase } = kanelPkg;
const committedRoot = path.join(repoRoot, "generated/db");
const tempRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "metagraphed-db-types-drift-"),
);

const db = await startScratchPostgres();
try {
  // Kanel has no config-level silent/quiet option; it unconditionally logs
  // "Clearing old files..." + a per-file listing straight to stdout (a
  // console.log override doesn't catch it -- Kanel's own module captured its
  // own reference at import time). Suppress at the stdout-write level so a
  // passing drift check prints nothing, matching every other validate:*
  // script's silent-unless-error convention.
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    await processDatabase({
      connection: db.connectionString,
      schemas: ["public"],
      outputPath: tempRoot,
      preDeleteOutputFolder: true,
    });
  } finally {
    process.stdout.write = originalWrite;
  }
} finally {
  stopScratchPostgres(db.containerName);
}

const expected = await collectFiles(tempRoot);
const current = await collectFiles(committedRoot);
await fs.rm(tempRoot, { recursive: true, force: true });

const errors: string[] = [];
const allPaths = new Set([...expected.keys(), ...current.keys()]);
for (const relativePath of allPaths) {
  const expectedContent = expected.get(relativePath);
  const currentContent = current.get(relativePath);
  if (expectedContent === undefined) {
    errors.push(`generated/db/${relativePath} is stale (no longer generated).`);
  } else if (currentContent === undefined) {
    errors.push(`generated/db/${relativePath} is missing.`);
  } else if (expectedContent !== currentContent) {
    errors.push(`generated/db/${relativePath} is stale.`);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  console.error(
    "\ngenerated/db/ is stale. Run npm run build:db-types and commit the result.",
  );
  process.exit(1);
}

console.log("Generated Postgres row types are current.");
