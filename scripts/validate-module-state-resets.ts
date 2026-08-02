#!/usr/bin/env node
// Fails when a Worker/src module declares module-level MUTABLE state without
// registering a reset with src/module-state-registry.ts.
//
// Why this is a gate and not a convention: with `isolate: false`
// (metagraphed#8922) every test file in a worker shares one module registry, so
// module-level mutable state becomes a cross-file channel. A module added later
// with an unregistered memo reintroduces exactly the intermittent, order-
// dependent redness the registry was built to remove — and it would show up as
// an unrelated test failing in an unrelated file, days later.
//
// The mutable set is COMPUTED, never hand-listed, so it cannot rot:
//   - `let X = ...` at column 0 is mutable when X is assigned again anywhere
//     after its declaration.
//   - `const X = new Map/Set/WeakMap/WeakSet(...)` at column 0 is mutable when
//     the file calls X.set/.add/.delete/.clear anywhere.
// Immutable module-level lookup tables (the ~25 frozen `new Set([...])`
// constants) are therefore not flagged, and need no reset.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ROOTS = ["src", "workers"];
const REGISTRY_MODULE = "src/module-state-registry.ts";

const LET_DECL = /^let ([A-Za-z_$][\w$]*)/gm;
// #8988: the type-argument list is OPTIONAL. This used to require `new Set(`
// immediately, so every GENERICALLY-TYPED module-level collection was
// invisible to the gate -- in a TypeScript codebase, i.e. the common case. A
// `const x = new Set<string>()` with `.add()` calls passed a validator whose
// entire purpose is to catch exactly that.
//
// The type argument is matched by balanced-depth scanning rather than a
// character class: `new Map<string, Map<string, string>>(` is real code here
// (workers/storage.ts's runManifestMemo), and `<[^>]*>` stops at the first
// `>` and misses it -- a half-fix that would have left the nested case
// exactly as blind as before.
const COLLECTION_DECL =
  /^const ([A-Za-z_$][\w$]*)(?:\s*:[^=]+)?\s*=\s*new (?:Map|Set|WeakMap|WeakSet)\s*(<[^<>]*(?:<[^<>]*>[^<>]*)*>)?\s*\(/gm;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name))
      out.push(full);
  }
  return out;
}

/**
 * The module-level mutable state declared in `source`.
 *
 * #8988: exported so the gate's own detection is testable. It was not, and the
 * consequence was a regex that silently missed every generically-typed
 * collection -- in a TypeScript codebase, the common case -- for as long as
 * nobody happened to look. A validator nobody can test is a validator nobody
 * knows the coverage of.
 */
export function mutableStateIn(source: string): string[] {
  const mutable: string[] = [];

  for (const match of source.matchAll(LET_DECL)) {
    const name = match[1];
    const after = source.slice(match.index + match[0].length);
    // Reassignment: `name =` / `name +=` / `name++`, but not `name ==`/`===`.
    const reassigned = new RegExp(
      `\\b${name}\\s*(?:=(?!=)|\\+=|-=|\\+\\+|--)`,
    ).test(after);
    if (reassigned) mutable.push(name);
  }

  for (const match of source.matchAll(COLLECTION_DECL)) {
    const name = match[1];
    const mutated = new RegExp(
      `\\b${name}\\.(?:set|add|delete|clear)\\s*\\(`,
    ).test(source);
    if (mutated) mutable.push(name);
  }

  return [...new Set(mutable)];
}

const offenders: Array<{ file: string; state: string[] }> = [];

for (const root of ROOTS) {
  const abs = path.join(repoRoot, root);
  if (!fs.existsSync(abs)) continue;
  for (const file of walk(abs)) {
    const rel = path.relative(repoRoot, file).replace(/\\/g, "/");
    if (rel === REGISTRY_MODULE) continue;
    const source = fs.readFileSync(file, "utf8");
    const state = mutableStateIn(source);
    if (state.length === 0) continue;
    if (source.includes("registerModuleStateReset(")) continue;
    offenders.push({ file: rel, state });
  }
}

if (offenders.length > 0) {
  console.error(
    `validate-module-state-resets: ${offenders.length} module(s) declare module-level mutable state without a reset.\n`,
  );
  for (const { file, state } of offenders) {
    console.error(`  ${file}`);
    console.error(`    mutable module state: ${state.join(", ")}`);
  }
  console.error(
    `\nEach must call registerModuleStateReset("<repo-relative path>", () => { ... })` +
      `\nfrom ${REGISTRY_MODULE}, restoring the state to its post-load baseline.` +
      `\nWithout it, the state leaks across test files under \`isolate: false\`.`,
  );
  process.exit(1);
}

console.log(
  JSON.stringify(
    { name: "validate-module-state-resets", status: "passed" },
    null,
    2,
  ),
);
