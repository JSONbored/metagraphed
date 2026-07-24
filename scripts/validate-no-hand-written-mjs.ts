import { execFileSync } from "node:child_process";
import { repoRoot } from "./lib.ts";

// Permanent lock on the TypeScript migration (#7510/#7521): every hand-written
// module in this repo must be `.ts`. The migration converted all 800+ `.mjs`
// files (Phases 2-6), and the post-epic sweep converted the stragglers the
// epic scoped out (root tool configs, apps/ui e2e/scripts, workspace eslint
// configs) — this gate fails closed, REPO-WIDE, so a new `.mjs`/`.js`/`.cjs`
// can't quietly reintroduce untyped code anywhere.
//
// Checks GIT-TRACKED files only (`git ls-files`), not the filesystem: vendored
// node_modules trees (e.g. deploy/wss-lb/node_modules) legitimately contain
// `.mjs`, and only a tracked file can regress the repo.
//
// The allowlist below is the documented escape hatch. Two kinds of entries
// belong in it: committed BUILD OUTPUT that is compiled JS by definition
// (the workspace dist/ files below — their .ts sources are the hand-written
// truth), and any future file a tool physically requires to be JS. Add the
// exact repo-relative path WITH a comment explaining why — never disable the
// check instead. Note `.d.ts` files are deliberately NOT flagged: they are
// TypeScript (declaration form) — the generated worker-configuration/contract
// declarations and the ambient workers/env-extra.d.ts merge are all correct
// uses, not migration debt.
const ALLOWLIST = new Set<string>([
  // Committed tsup/build output of the published workspace packages —
  // compiled-JS artifacts whose sources are packages/*/src/*.ts.
  "packages/client/dist/index.cjs",
  "packages/client/dist/index.js",
  "packages/ui-kit/dist/index.cjs",
  "packages/ui-kit/dist/index.js",
]);

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean);

const offenders = tracked.filter(
  (file) =>
    (file.endsWith(".mjs") || file.endsWith(".js") || file.endsWith(".cjs")) &&
    !ALLOWLIST.has(file),
);

if (offenders.length > 0) {
  console.error(
    `validate:no-hand-written-mjs failed — ${offenders.length} hand-written ` +
      `.mjs/.js/.cjs file(s) in the repo:`,
  );
  for (const file of offenders) {
    console.error(`- ${file}`);
  }
  console.error(
    "\nNew modules must be .ts (metagraphed#7521). If a tool physically " +
      "requires JS, add the exact path to ALLOWLIST in " +
      "scripts/validate-no-hand-written-mjs.ts with a comment explaining why.",
  );
  process.exit(1);
}

console.log(
  `validate:no-hand-written-mjs passed — no hand-written .mjs/.js/.cjs ` +
    `anywhere in the repo (${tracked.length} tracked files checked).`,
);
