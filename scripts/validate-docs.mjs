import { promises as fs } from "node:fs";
import path from "node:path";
import { API_ROUTES, PUBLIC_ARTIFACTS } from "../src/contracts.mjs";
import { repoRoot } from "./lib.mjs";

const readme = await fs.readFile(path.join(repoRoot, "README.md"), "utf8");
const backendContracts = await fs.readFile(
  path.join(repoRoot, "docs/backend-artifact-contracts.md"),
  "utf8",
);
const errors = [];

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

// --- Cadence prose guard (ADR 0007) -------------------------------------------
// The data publish is event-driven (on human-input registry merges) + a daily
// floor — NOT a 6h cron — and the operational prober is 15-minute — NOT 2-minute.
// Fail the build if that stale cadence language reappears in served-facing docs so
// they can't silently drift back to describing a system that no longer exists.
// Excluded: docs/adr/** (immutable historical records that describe the 6h era as
// period context) and the legitimate "6-hour buckets" of RPC usage analytics
// (a bucket size, not a publish cadence — the patterns below require a cadence
// noun like cron/publish/schedule, never "buckets").
const STALE_CADENCE_PATTERNS = [
  {
    re: /~?\s*6\s*-?\s*h(?:our)?s?\s+(?:cron|publish|schedule|cadence|refresh|build)/i,
    label:
      "stale 6h publish cadence (the publish is event-driven + a daily floor — ADR 0007)",
  },
  {
    re: /\bevery\s+6\s*-?\s*h(?:ours?)?\b/i,
    label:
      "stale 'every 6h' cadence (the publish is event-driven + a daily floor — ADR 0007)",
  },
  {
    re: /\b2\s*-?\s*minute\s+(?:cron|prober|probe)/i,
    label: "stale 2-minute prober cadence (the prober is 15-minute — ADR 0002)",
  },
];
const docsDir = path.join(repoRoot, "docs");
for (const file of await collectMarkdown(docsDir, [
  path.join(docsDir, "adr"),
])) {
  const rel = path.relative(repoRoot, file);
  const lines = (await fs.readFile(file, "utf8")).split("\n");
  lines.forEach((line, index) => {
    for (const { re, label } of STALE_CADENCE_PATTERNS) {
      check(!re.test(line), `${rel}:${index + 1}: ${label} — "${line.trim()}"`);
    }
  });
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

function README_HAS(value) {
  return readme.includes(value);
}

function check(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

// Recursively collect *.md files under `dir`, skipping any directory in
// `excludeDirs` (absolute paths).
async function collectMarkdown(dir, excludeDirs = []) {
  const out = [];
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
