import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_ROUTES, PUBLIC_ARTIFACTS } from "../src/contracts.mjs";
import { repoRoot } from "./lib.ts";

// --- Cadence prose guard (ADR 0007) -------------------------------------------
// The data publish is event-driven (on human-input registry merges) + a daily
// floor — NOT the retired six-hour cron — and the operational prober is
// 15-minute — NOT 2-minute.
// Fail the build if that stale cadence language reappears in served-facing docs
// or in scripts/*.mjs|ts / README.md comments and string literals, so they
// can't silently drift back to describing a system that no longer exists.
// Excluded: docs/adr/** (immutable historical records that describe the
// six-hour era as period context) and the legitimate "6-hour buckets" of RPC
// usage analytics (a bucket size, not a publish cadence — the patterns below
// require a cadence noun like cron/publish/schedule, never "buckets").
export const STALE_CADENCE_PATTERNS: { re: RegExp; label: string }[] = [
  {
    re: /~?\s*6\s*-?\s*h(?:our)?s?\s+(?:cron|publish|schedule|cadence|refresh|build)/i,
    label:
      "stale six-hour publish cadence (the publish is event-driven + a daily floor — ADR 0007)",
  },
  {
    re: /\bevery\s+6\s*-?\s*h(?:ours?)?\b/i,
    label:
      "stale 'every six hours' cadence (the publish is event-driven + a daily floor — ADR 0007)",
  },
  {
    re: /\b2\s*-?\s*minute\s+(?:cron|prober|probe)/i,
    label:
      "stale two-minute prober cadence (the prober is 15-minute — ADR 0002)",
  },
];

/** Return stale-cadence hits for one file's text (line-oriented). Exported for tests. */
export function findStaleCadenceHits(
  relativePath: string,
  text: string,
): string[] {
  const hits: string[] = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const { re, label } of STALE_CADENCE_PATTERNS) {
      if (re.test(line)) {
        hits.push(`${relativePath}:${index + 1}: ${label} — "${line.trim()}"`);
      }
    }
  });
  return hits;
}

// Recursively collect *.md files under `dir`, skipping any directory in
// `excludeDirs` (absolute paths).
export async function collectMarkdown(
  dir: string,
  excludeDirs: string[] = [],
): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!excludeDirs.includes(full)) {
        out.push(...(await collectMarkdown(full, excludeDirs)));
      }
    } else if (entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

/** Absolute paths the cadence guard scans: docs (excl. adr), scripts/*.mjs|ts, README.md. */
export async function collectCadenceScanFiles(
  root: string = repoRoot,
): Promise<string[]> {
  const docsDir = path.join(root, "docs");
  const scriptsDir = path.join(root, "scripts");
  const files = await collectMarkdown(docsDir, [path.join(docsDir, "adr")]);
  for (const entry of await fs.readdir(scriptsDir, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      (entry.name.endsWith(".mjs") || entry.name.endsWith(".ts"))
    ) {
      files.push(path.join(scriptsDir, entry.name));
    }
  }
  files.push(path.join(root, "README.md"));
  return files;
}

async function main(): Promise<void> {
  const readme = await fs.readFile(path.join(repoRoot, "README.md"), "utf8");
  const backendContracts = await fs.readFile(
    path.join(repoRoot, "docs/backend-artifact-contracts.md"),
    "utf8",
  );
  const errors: string[] = [];

  function check(condition: unknown, message: string): void {
    if (!condition) {
      errors.push(message);
    }
  }

  function README_HAS(value: string): boolean {
    return readme.includes(value);
  }

  for (const artifact of PUBLIC_ARTIFACTS) {
    check(
      backendContracts.includes(artifact.path),
      `docs/backend-artifact-contracts.md missing artifact ${artifact.path}`,
    );
  }

  for (const route of API_ROUTES) {
    check(
      backendContracts.includes(route.path),
      `docs/backend-artifact-contracts.md missing route ${route.path}`,
    );
  }

  // The README is intentionally minimal + quickstart-first; the exhaustive route
  // and artifact coverage is enforced in docs/backend-artifact-contracts.md (the
  // checks above). Here we only guard that the key live-resource pointers a
  // reader needs stay present in the README.
  for (const requiredReadmeText of [
    "metagraph.sh",
    "api.metagraph.sh/mcp",
    "@jsonbored/metagraphed",
    "pip install metagraphed",
    "/metagraph/openapi.json",
    "docs/api-stability.md",
  ]) {
    check(
      README_HAS(requiredReadmeText),
      `README.md missing ${requiredReadmeText}`,
    );
  }

  for (const file of await collectCadenceScanFiles(repoRoot)) {
    const rel = path.relative(repoRoot, file).split(path.sep).join("/");
    const text = await fs.readFile(file, "utf8");
    for (const hit of findStaleCadenceHits(rel, text)) {
      errors.push(hit);
    }
  }

  if (errors.length > 0) {
    console.error(
      `Documentation validation failed with ${errors.length} issue(s):`,
    );
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log("Documentation contract validation passed.");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
