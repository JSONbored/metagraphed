// A module nothing can reach is dead, and nothing was looking for one (#10221).
//
// Every consolidation this month replaced a hand-maintained thing with a
// derived one, and the cleanups that followed were driven by
// `eslint no-unused-vars` -- which finds an unused IMPORT and nothing else. A
// whole file that no longer has a caller is invisible to it, which is how
// `scripts/sync-registry-to-postgres.ts` and `scripts/backfill-registry-
// postgres.ts` outlived the Postgres box they wrote to by three weeks.
//
// TWO POPULATIONS, TWO DEFINITIONS OF REACHABLE, because a script and a module
// are entered differently:
//
//   scripts/*.ts   an ENTRY POINT. Reachable if a package.json script, a
//                  workflow, a Dockerfile, a doc, or another module names it.
//                  Nothing imports `scripts/build.ts` and it is the build.
//
//   src|workers|schemas-src  a LIBRARY module. Reachable only if something
//                  imports it, transitively from an entry point.
//
// Deliberately NOT a check on unused exports. `knip --include exports` reports
// 1,135 on this tree, the large majority of them types exported so a caller can
// name them, and a gate whose first run needs 1,135 hand decisions is a gate
// nobody turns on. Files are the half that is unambiguous: a file with no
// reachable reference is dead however its exports are used internally.
import { promises as fs } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.ts";
import { SCAN_ROOTS } from "./validate-schema-shape-duplicates.ts";

/**
 * Files that are genuinely unreferenced and stay.
 *
 * The list must SHRINK: an entry naming a file that is now referenced (or gone)
 * fails this script, so a fix cannot leave a stale exemption behind -- the same
 * idiom the MCP input-parity, tier-cascade and vocabulary gates use.
 */
const DECLARED: Record<string, string> = {};

/** Directories whose `.ts` files are library modules, reached by import only.
 * The same three trees the shape gate scans, and imported from it so the two
 * gates cannot watch different worlds (#10987 follow-up). */
const LIBRARY_DIRS = SCAN_ROOTS;

/** Where a script may be named from, beyond an import. */
const INVOCATION_ROOTS = [
  "package.json",
  ".github",
  "docs",
  "deploy",
  ".devcontainer",
  "README.md",
];

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(path.join(repoRoot, dir), {
      withFileTypes: true,
    });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      // `.tmp` is a scratch directory; `node_modules` is not ours.
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      await walk(rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/** Every file whose text could name a module, read once. */
async function corpus(): Promise<{ file: string; text: string }[]> {
  const files: string[] = [];
  for (const dir of [...LIBRARY_DIRS, "scripts", "tests"]) {
    files.push(...(await walk(dir)));
  }
  for (const root of INVOCATION_ROOTS) {
    const full = path.join(repoRoot, root);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) files.push(...(await walk(root)));
    else files.push(root);
  }
  const out: { file: string; text: string }[] = [];
  for (const file of files) {
    if (/\.(png|jpe?g|gif|webp|ico|woff2?|zip|gz)$/.test(file)) continue;
    out.push({
      file,
      text: await fs.readFile(path.join(repoRoot, file), "utf8"),
    });
  }
  return out;
}

const all = await corpus();
const byFile = new Map(all.map((entry) => [entry.file, entry.text]));

/**
 * Every module some .ts file imports, resolved to a repo-relative path.
 *
 * RESOLVED SPECIFIERS, not a text search. A text search counts a path written
 * in a COMMENT as a reference -- this file's own doc comment names
 * `schemas-src/routes/sudo.ts` as an example, and that alone was enough to
 * clear the orphan it was describing. An import is the only thing that makes a
 * library module reachable, so an import is the only thing that counts.
 */
const imported = new Set<string>();
for (const { file, text } of all) {
  if (!file.endsWith(".ts")) continue;
  const dir = path.dirname(file);
  for (const match of text.matchAll(
    /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g,
  )) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue;
    imported.add(path.normalize(path.join(dir, specifier)));
  }
}

/**
 * Where a script is NAMED, which is how a script is entered.
 *
 * A script is not imported -- nothing imports `scripts/build.ts` and it is the
 * build. It is named: by a package.json script, by a workflow step, or by
 * `scripts/build.ts` spawning it as a child process.
 *
 * The distinction that matters is prose vs invocation. `publish-cloudflare.yml`
 * mentions `refresh-og-image` in a COMMENT explaining what the build does, and
 * counting that would clear every script the build stopped calling. So inside a
 * `.ts` file only a QUOTED path counts -- a spawn target is a string literal, a
 * comment is not.
 */
function invoked(target: string): boolean {
  const base = path.basename(target);
  const quoted = [`"${target}"`, `'${target}'`, `\`${target}\``];
  for (const { file, text } of all) {
    if (file === target) continue;
    if (file.endsWith(".ts")) {
      if (quoted.some((needle) => text.includes(needle))) return true;
      continue;
    }
    if (text.includes(target) || text.includes(base)) return true;
  }
  return false;
}

const unreferenced: string[] = [];
for (const file of byFile.keys()) {
  if (!file.endsWith(".ts")) continue;
  if (file.endsWith(".d.ts")) continue;
  if (file.startsWith("tests/")) continue;
  // A test file is an entry point wherever it lives: vitest's include finds it
  // by name, not by import. `src/unkey-client.test.ts` is the one outside
  // tests/ and its 11 cases do run.
  if (file.endsWith(".test.ts")) continue;
  if (file.includes("/.tmp/")) continue;
  const isScript = file.startsWith("scripts/");
  const isLibrary = LIBRARY_DIRS.some((dir) => file.startsWith(`${dir}/`));
  if (!isScript && !isLibrary) continue;
  if (imported.has(path.normalize(file))) continue;
  if (isScript && invoked(file)) continue;
  unreferenced.push(file);
}

const errors: string[] = [];
const undeclared = unreferenced.filter((file) => !DECLARED[file]).sort();
if (undeclared.length > 0) {
  errors.push(
    `${undeclared.length} module(s) nothing can reach -- delete them, or declare each with the reason it stays:\n` +
      undeclared.map((file) => `    ${file}`).join("\n"),
  );
}
const stale = Object.keys(DECLARED)
  .filter((file) => !unreferenced.includes(file))
  .sort();
if (stale.length > 0) {
  errors.push(
    `${stale.length} declared entr(y/ies) name a module that is now referenced (or gone) -- delete them:\n` +
      stale.map((file) => `    ${file}`).join("\n"),
  );
}

if (errors.length > 0) {
  console.error(
    `Unreferenced-module validation failed with ${errors.length} issue(s):`,
  );
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const scanned = [...byFile.keys()].filter(
  (file) =>
    file.endsWith(".ts") &&
    !file.endsWith(".d.ts") &&
    (file.startsWith("scripts/") ||
      LIBRARY_DIRS.some((dir) => file.startsWith(`${dir}/`))),
).length;
console.log(
  `Unreferenced-module validation passed: ${scanned} module(s) scanned, ` +
    `${Object.keys(DECLARED).length} declared exception(s).`,
);
