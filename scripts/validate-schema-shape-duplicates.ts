// A published OBJECT vocabulary must have one owner (#10790).
//
// ## The gap this closes, and how it was found
//
// Three gates already say "one owner" about three different things:
//
//   validate-schema-vocabularies.ts  a string-literal ENUM restated in two
//                                    schema files (#9799)
//   validate-type-duplicates.ts      a hand-written TYPESCRIPT type that is
//                                    field-for-field a generated one (#10784)
//   this one                         a Zod OBJECT restated in two schema files
//
// The middle of those three was missing, and `auth` is what it cost. Both
// `subnet-detail.ts` and `agent-catalog.ts` modelled the registry's auth block;
// the copy was `.passthrough()`, omitted `body_envelope` and `token_url`, and
// served `body_envelope` on eight services while declaring nothing about it.
// The copy's own comment named #9799 as the fix -- and #9799 CLOSED, having
// single-sourced the enum vocabularies INSIDE that object (`scheme`,
// `location`, which both copies already imported) and left the object around
// them duplicated. Its gate looks for string-literal lists, so a re-copied
// object passes it clean.
//
// `revenue` was the same shape: an eleven-field `.strict()` canonical beside an
// eight-field `.passthrough()` copy, which served `source_url` and
// `circularity` undeclared.
//
// ## What counts as a duplicate
//
// The KEY SET, sorted -- not the types. Two schemas over the same vocabulary
// drift by one side gaining a field, which is exactly the case a type-sensitive
// comparison would stop reporting at the moment it started mattering. Reported
// only at four keys or more: three-key shapes like `{min,max,mean}` recur by
// coincidence rather than by lineage, and a gate that called those duplicates
// would be arguing with arithmetic.
//
// Read through the AST, over the SOURCE, because two `z.object({...})` literals
// in different files are different runtime values however identical their
// shapes -- there is nothing to compare at runtime but the keys they declare.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const SCHEMA_ROOT = "schemas-src";
/** Below this, a shared key set is coincidence rather than lineage. */
const MIN_KEYS = 4;

/** One `z.object({...})` literal, and the keys it declares. */
export interface ShapeSite {
  file: string;
  line: number;
  /** Sorted, comma-joined -- the identity two copies share. */
  keys: string;
  count: number;
}

export interface ShapeDuplicate {
  keys: string;
  sites: ShapeSite[];
}

/** Every `z.object({ … })` literal under the given files. */
export function findObjectShapes(files: readonly string[]): ShapeSite[] {
  const out: ShapeSite[] = [];
  for (const file of files) {
    const text = readFileSync(path.join(repoRoot, file), "utf8");
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "object" &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "z" &&
        node.arguments.length === 1 &&
        ts.isObjectLiteralExpression(node.arguments[0]!)
      ) {
        const keys = node.arguments[0]!.properties.flatMap((property) =>
          (ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property)) &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
            ? [property.name.text]
            : [],
        );
        if (keys.length >= MIN_KEYS) {
          out.push({
            file,
            line:
              source.getLineAndCharacterOfPosition(node.getStart(source)).line +
              1,
            keys: [...keys].sort().join(","),
            count: keys.length,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

/** Key sets declared in more than ONE FILE. */
export function findDuplicates(sites: readonly ShapeSite[]): ShapeDuplicate[] {
  const byKeys = new Map<string, ShapeSite[]>();
  for (const site of sites) {
    byKeys.set(site.keys, [...(byKeys.get(site.keys) ?? []), site]);
  }
  const out: ShapeDuplicate[] = [];
  for (const [keys, group] of byKeys) {
    // Two literals in ONE file are usually a schema and its history variant
    // sharing a point shape, declared side by side where a reader sees both.
    // The failure this gate exists for is the copy in another file, which no
    // reader of either sees.
    if (new Set(group.map((site) => site.file)).size > 1) {
      out.push({ keys, sites: group });
    }
  }
  return out.sort((a, b) => b.sites[0]!.count - a.sites[0]!.count);
}

function schemaFiles(): string[] {
  return ts.sys
    .readDirectory(path.join(repoRoot, SCHEMA_ROOT), [".ts"], ["node_modules"])
    .map((file) => path.relative(repoRoot, file).split(path.sep).join("/"))
    .filter((file) => !file.endsWith(".d.ts"));
}

/**
 * The count this gate holds the line at, and it only goes DOWN.
 *
 * A RATCHET, not a rule, and MEASURED rather than assumed.
 * `scripts/report-shape-duplicate-drift.ts` compares each duplicated
 * vocabulary field by field, and the answer decides which pile the pair lands
 * in:
 *
 *   IDENTICAL  a mechanical collapse. #10790 did all of them -- `auth`,
 *              `revenue`, the entity label whose two copies each told the
 *              other to "keep both in sync", the social-links block, and the
 *              GitHub release shape written out three times byte for byte.
 *   DIVERGENT  42 remain, and NOT ONE is mechanical. The two declarations
 *              disagree about at least one field, so collapsing means choosing
 *              which side is right -- a published-contract decision per field,
 *              not a cleanup.
 *
 * What that disagreement looks like, from the report:
 *
 *   limit         `limitSchema(1000, 20)` against `limitSchema(100, 20)` --
 *                 collapsing changes the page a caller may ask for.
 *   captured_at   `z.string()` against `z.iso.datetime()`.
 *   recent_events required on one side, `.optional()` on the other.
 *   netuid        the network-wide list's optional FILTER against the
 *                 subnet-scoped list's required SUBJECT. Same name, same key
 *                 set, different field -- and collapsing those two would be
 *                 actively wrong.
 *
 * So the mechanism lands with the measurement beside it, and the backlog is
 * worked with data rather than by hand. Run `npm run report:shape-duplicates`.
 */
const CEILING = 42;

function main(): void {
  const files = schemaFiles();
  const sites = findObjectShapes(files);
  const duplicates = findDuplicates(sites);
  const report =
    `schema-shape-duplicates: ${duplicates.length} object vocabular(ies) ` +
    `declared in more than one schema file, across ${sites.length} literal(s) ` +
    `of ${MIN_KEYS}+ keys in ${files.length} file(s) (ceiling ${CEILING}).`;
  if (duplicates.length > CEILING) {
    console.error(
      `${report}\n\nNEW duplicate(s) -- the ceiling is ${CEILING}:\n` +
        duplicates
          .map(
            (duplicate) =>
              `  {${duplicate.keys}}\n` +
              duplicate.sites
                .map((site) => `      ${site.file}:${site.line}`)
                .join("\n"),
          )
          .join("\n") +
        `\n\nExport the declaration from ONE file and import it in the other. A ` +
        `second copy drifts by one side gaining a field, and the narrower one ` +
        `then accepts what it does not describe -- which is how \`auth\` came to ` +
        `serve \`body_envelope\` on eight services while declaring nothing ` +
        `about it (#10790).`,
    );
    process.exit(1);
  }
  console.log(report);
  if (duplicates.length < CEILING) {
    console.log(
      `  ${CEILING - duplicates.length} below the ceiling -- lower CEILING to ` +
        `${duplicates.length} so it cannot come back.`,
    );
  }
}

/* v8 ignore next 3 -- the CLI entry, exercised by the pipeline not the suite. */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
