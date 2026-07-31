import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot } from "./lib.ts";

// Drift gate for apps/ui/content/docs/api-reference/** (#8917).
//
// Those pages are generated entirely from public/metagraph/openapi.json by
// apps/ui/scripts/generate-openapi-docs.ts, so the thing that invalidates them
// is a CONTRACT change -- a new route, a changed schema -- which lands in a
// backend PR that need never touch apps/ui at all. Until now the only check was
// inside the `ui` CI job ("Build API reference docs (drift check)"), which runs
// on a different path filter and nothing in the root `npm run check` covered.
// A contract PR therefore could not discover the staleness locally and only
// found out from a red `ui` job (observed on #8892, which added
// /api/v1/chain/emission-pipeline).
//
// Generates into a TEMP directory via the generator's own
// OPENAPI_DOCS_OUTPUT override rather than regenerating in place and diffing
// the way the CI step does -- same never-mutate-the-tree convention as
// validate-graphql-types-drift.ts, so running this can't leave a dirty
// working tree behind on failure.
const COMMITTED_DIR = path.join(repoRoot, "apps/ui/content/docs/api-reference");
const UI_DIR = path.join(repoRoot, "apps/ui");

// The generator preserves one hand-written page it does not own; it is not
// generated output, so it must not count as drift in either direction.
const HAND_WRITTEN = new Set(["index.mdx"]);

async function readTree(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      const relative = path.relative(root, absolute);
      if (HAND_WRITTEN.has(relative)) continue;
      files.set(relative, await fs.readFile(absolute, "utf8"));
    }
  }
  await walk(root);
  return files;
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-docs-drift-"));
try {
  try {
    execFileSync("node", ["scripts/generate-openapi-docs.ts"], {
      cwd: UI_DIR,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, OPENAPI_DOCS_OUTPUT: tempDir },
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    console.error(
      "Failed to run apps/ui/scripts/generate-openapi-docs.ts. The apps/ui " +
        "workspace must be installed (root `npm ci` covers it).\n" +
        `${e.stdout ?? ""}${e.stderr ?? ""}`,
    );
    process.exit(1);
  }

  const [expected, committed] = await Promise.all([
    readTree(tempDir),
    readTree(COMMITTED_DIR),
  ]);

  const errors: string[] = [];
  for (const [relative, content] of expected) {
    const current = committed.get(relative);
    if (current === undefined) {
      errors.push(`missing: ${relative}`);
    } else if (current !== content) {
      errors.push(`stale:   ${relative}`);
    }
  }
  for (const relative of committed.keys()) {
    if (!expected.has(relative)) errors.push(`extra:   ${relative}`);
  }

  if (errors.length > 0) {
    console.error(
      `apps/ui/content/docs/api-reference is out of date with the OpenAPI contract (${errors.length} file(s)):`,
    );
    for (const error of errors.slice(0, 40)) console.error(`- ${error}`);
    if (errors.length > 40) {
      console.error(`  …and ${errors.length - 40} more.`);
    }
    console.error(
      "\nRegenerate and commit:\n" +
        "  cd apps/ui && node scripts/generate-openapi-docs.ts",
    );
    process.exit(1);
  }

  console.log(
    `API reference docs are current (${expected.size} generated page(s)).`,
  );
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
