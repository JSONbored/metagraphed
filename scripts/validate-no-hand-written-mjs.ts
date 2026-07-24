import { execFileSync } from "node:child_process";
import { repoRoot } from "./lib.ts";

// Permanent lock on the TypeScript migration (#7510/#7521): every hand-written
// module under the covered directories must be `.ts`. The migration converted
// all 800+ `.mjs` files (Phases 2-6); this gate fails closed so a new `.mjs`
// or `.js` can't quietly reintroduce untyped code — the drift this repo lived
// with for its first ~7000 issues.
//
// Checks GIT-TRACKED files only (`git ls-files`), not the filesystem: vendored
// node_modules trees (e.g. deploy/wss-lb/node_modules) legitimately contain
// `.mjs`, and only a tracked file can regress the repo.
//
// The allowlist below is the documented escape hatch for a genuine future
// exception (a file some tool physically requires to be JS). Add the exact
// repo-relative path WITH a comment explaining why — never widen the covered
// dirs or disable the check instead. It is intentionally empty today: root
// tooling configs (eslint.config.mjs, vitest.config.mjs) sit outside the
// covered directories and don't need entries.
const COVERED_DIRS = [
  "src/",
  "workers/",
  "scripts/",
  "tests/",
  "deploy/wss-lb/",
];
const ALLOWLIST = new Set<string>([]);

const tracked = execFileSync("git", ["ls-files", "-z", "--", ...COVERED_DIRS], {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean);

const offenders = tracked.filter(
  (file) =>
    (file.endsWith(".mjs") || file.endsWith(".js")) && !ALLOWLIST.has(file),
);

if (offenders.length > 0) {
  console.error(
    `validate:no-hand-written-mjs failed — ${offenders.length} hand-written ` +
      `.mjs/.js file(s) under ${COVERED_DIRS.join(", ")}:`,
  );
  for (const file of offenders) {
    console.error(`- ${file}`);
  }
  console.error(
    "\nNew modules in these directories must be .ts (metagraphed#7521). " +
      "If a tool physically requires JS, add the exact path to ALLOWLIST in " +
      "scripts/validate-no-hand-written-mjs.ts with a comment explaining why.",
  );
  process.exit(1);
}

console.log(
  `validate:no-hand-written-mjs passed — no hand-written .mjs/.js under ` +
    `${COVERED_DIRS.join(", ")} (${tracked.length} tracked files checked).`,
);
