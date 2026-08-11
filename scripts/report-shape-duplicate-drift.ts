// What the duplicated object vocabularies actually DISAGREE about (#10790).
//
// `validate-schema-shape-duplicates.ts` reports that two schema files declare
// the same KEY SET. That is the right thing to gate on -- two copies of one
// vocabulary drift by one side gaining a field, and a type-sensitive comparison
// would stop reporting the pair at exactly the moment it started mattering.
//
// It is the wrong thing to MIGRATE on. Collapsing a copy into its canonical
// declaration replaces one type with another, and where the two disagree that
// is a published-contract change, not a cleanup. So this report answers the
// question the gate deliberately does not: for each duplicated vocabulary, are
// the two declarations field-for-field the same, and if not, where do they
// differ?
//
// The output partitions the backlog into the two piles that need different
// work:
//
//   IDENTICAL   a mechanical collapse -- export one, import it in the other,
//               delete the copy. Nothing published changes.
//   DIVERGENT   a decision. One side is right about each differing field, and
//               the answer is whatever the PRODUCER writes -- which is why
//               these are listed field by field rather than counted.
//
// Compared over the SOURCE, like the gate: two `z.object({...})` literals in
// different files are different runtime values however identical they look,
// and the declaration text is what a reader has to reconcile.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import {
  findDuplicates,
  findObjectShapes,
  type ShapeSite,
} from "./validate-schema-shape-duplicates.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const SCHEMA_ROOT = "schemas-src";

/** One field's declared type, as written. */
type FieldTypes = Map<string, string>;

export interface DuplicateDrift {
  keys: string;
  sites: ShapeSite[];
  /** Field -> the distinct spellings across the sites, when more than one. */
  divergent: Map<string, string[]>;
}

/**
 * Normalize a declaration so formatting is not mistaken for disagreement.
 *
 * Whitespace collapses, and `.describe(...)`/`.meta({...})` are dropped: prose
 * differing between two copies is worth fixing but is not a contract change,
 * and leaving it in would bury the type differences that are.
 */
function normalize(text: string): string {
  return text
    .replace(/\.describe\(\s*(["'`])(?:\\.|(?!\1)[\s\S])*\1\s*,?\s*\)/g, "")
    .replace(/\.meta\(\{[\s\S]*?\}\)/g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, "")
    .replace(/,$/, "");
}

/** Each declared key mapped to its normalized type expression. */
function fieldTypesAt(file: string, line: number): FieldTypes {
  const text = readFileSync(path.join(repoRoot, file), "utf8");
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const out: FieldTypes = new Map();
  const visit = (node: ts.Node): void => {
    // The SAME match the gate makes -- a `z.object({...})` call whose start is
    // the reported line -- so the two always read the same literal. Matching
    // "any object literal spanning this line" instead picks the enclosing
    // parent, whose keys are not these keys, and every comparison then agrees
    // about nothing.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "object" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "z" &&
      node.arguments.length === 1 &&
      ts.isObjectLiteralExpression(node.arguments[0]!) &&
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 ===
        line
    ) {
      for (const property of node.arguments[0]!.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        ) {
          out.set(
            property.name.text,
            normalize(property.initializer.getText(source)),
          );
        } else if (ts.isShorthandPropertyAssignment(property)) {
          out.set(property.name.text, property.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** Per duplicate, the fields whose declarations are not all the same. */
export function findDrift(
  duplicates: readonly { keys: string; sites: ShapeSite[] }[],
): DuplicateDrift[] {
  return duplicates.map((duplicate) => {
    const perSite = duplicate.sites.map((site) =>
      fieldTypesAt(site.file, site.line),
    );
    const divergent = new Map<string, string[]>();
    // The extractor takes the outermost literal spanning the reported line. If
    // that is a PARENT rather than the site itself, every key reads `<absent>`
    // on both sides and the comparison reports "identical" by comparing
    // nothing -- the failure this whole report exists to avoid. So the keys it
    // found must be the keys the gate found, or the pair is a tool bug and
    // says so instead of a clean bill of health.
    for (const [index, types] of perSite.entries()) {
      const found = [...types.keys()].sort().join(",");
      if (found !== duplicate.keys) {
        divergent.set(
          `<EXTRACTION FAILED at ${duplicate.sites[index]!.file}:${duplicate.sites[index]!.line}>`,
          [`expected {${duplicate.keys}}`, `read {${found}}`],
        );
      }
    }
    for (const key of duplicate.keys.split(",")) {
      const spellings = [
        ...new Set(perSite.map((types) => types.get(key) ?? "<absent>")),
      ];
      if (spellings.length > 1) divergent.set(key, spellings);
    }
    return { keys: duplicate.keys, sites: duplicate.sites, divergent };
  });
}

function schemaFiles(): string[] {
  return ts.sys
    .readDirectory(path.join(repoRoot, SCHEMA_ROOT), [".ts"], ["node_modules"])
    .map((file) => path.relative(repoRoot, file).split(path.sep).join("/"))
    .filter((file) => !file.endsWith(".d.ts"));
}

function main(): void {
  const drift = findDrift(findDuplicates(findObjectShapes(schemaFiles())));
  const identical = drift.filter((entry) => entry.divergent.size === 0);
  const divergent = drift.filter((entry) => entry.divergent.size > 0);

  console.log(
    `shape-duplicate-drift: ${drift.length} duplicated vocabular(ies) -- ` +
      `${identical.length} field-for-field IDENTICAL (mechanical collapse), ` +
      `${divergent.length} DIVERGENT (a decision per differing field).\n`,
  );

  if (identical.length) {
    console.log("IDENTICAL -- export one, import it, delete the copy:");
    for (const entry of identical) {
      console.log(`  {${entry.keys}}`);
      for (const site of entry.sites) {
        console.log(`      ${site.file}:${site.line}`);
      }
    }
    console.log("");
  }

  for (const entry of divergent) {
    console.log(`DIVERGENT {${entry.keys}}`);
    for (const site of entry.sites) {
      console.log(`      ${site.file}:${site.line}`);
    }
    for (const [field, spellings] of entry.divergent) {
      console.log(`    ${field}:`);
      for (const spelling of spellings) {
        console.log(`        ${spelling.slice(0, 160)}`);
      }
    }
    console.log("");
  }
}

/* v8 ignore next 3 -- the CLI entry, exercised by the pipeline not the suite. */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
