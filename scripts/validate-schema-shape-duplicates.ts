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

// The schema tree AND the serving tree (#10995). This gate watched only
// schemas-src/ while an MCP composer or a handler could re-model a shape by
// hand in src/ and stay green forever -- the same blindness #10987 fixed for
// the enum-vocabulary gate. ts.sys.readDirectory recurses, so "src" covers
// src/graphql/ and "workers" covers workers/request-handlers/.
const SCAN_ROOTS = ["schemas-src", "src", "workers"];
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

/**
 * How many of this literal's fields are DERIVED rather than declared.
 *
 * A derivation reads its constraint from somewhere else -- `Other.shape.field`,
 * or a spread of a shared block -- so it adds no second opinion about what the
 * field is. Only hand-written values count toward the duplicate threshold.
 */
function derivedKeyCount(literal: ts.ObjectLiteralExpression): number {
  let derived = 0;
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    let expression: ts.Expression = property.initializer;
    // Peel the `.optional()` / `.nullable()` / `.describe(...)` a derivation
    // may carry: narrowing a borrowed field is still borrowing it.
    while (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression)
    ) {
      expression = expression.expression.expression;
    }
    if (
      ts.isPropertyAccessExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === "shape"
    ) {
      derived += 1;
    }
  }
  return derived;
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
        // A field DERIVED from another schema is not a second declaration of
        // it. `netuid: RouteQuery_x.shape.netuid` restates a name, not a
        // vocabulary -- the constraint still has exactly one home, and a
        // rename there is still a compile error here. Counting those the same
        // as a hand-written `netuid: z.int().min(0)` reported the #10064 idiom
        // -- MCP inputs built field by field off their route's schema -- as
        // the very duplication it exists to prevent.
        const declared = keys.length - derivedKeyCount(node.arguments[0]!);
        if (keys.length >= MIN_KEYS && declared >= MIN_KEYS) {
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
  return SCAN_ROOTS.flatMap((root) =>
    ts.sys
      .readDirectory(path.join(repoRoot, root), [".ts"], ["node_modules"])
      .map((file) => path.relative(repoRoot, file).split(path.sep).join("/"))
      .filter((file) => !file.endsWith(".d.ts")),
  );
}

/**
 * The count this gate holds the line at, and it only goes DOWN.
 *
 * **42 to 1.** Every duplicated object vocabulary in `schemas-src/` has been
 * collapsed, and `scripts/report-shape-duplicate-drift.ts` is what made that
 * safe: it compares each pair field by field, so a mechanical collapse was
 * never confused with a contract change. Some became a shared const, some a
 * FACTORY where the shape was one vocabulary and the measure was not
 * (`distributionStatsSchema`, `subnetHistoryArtifactSchema`,
 * `subnetEntryListSchema`), and four were the #10064 derivation idiom that this
 * gate used to misread as duplication until it learned that
 * `Route.shape.field` is a borrowing rather than a second opinion.
 *
 * ONE REMAINS, and it is not duplication:
 *
 *   {limit, since, tag, until}
 *     schemas-src/route-queries.ts       FEED_QUERY_SCHEMAS.common
 *     schemas-src/mcp-tools/feed.ts      GetFeedOutput.filters
 *
 * The first is what a caller may SEND -- `since` accepts a bare date, `limit`
 * carries the route's ceiling. The second is what the response ECHOES BACK:
 * the filters as applied, `since` already resolved to an instant. Same four
 * names, opposite directions, different value spaces. Collapsing them would
 * either make the echo reject a value the handler legitimately produced or
 * make the input accept anything the echo can carry -- which is the input/
 * output conflation #10790 was explicitly told to keep separate.
 *
 * So the pair is pinned BY NAME -- not held behind a bare count. A count of 1
 * would stay 1 if the feed pair resolved and a NEW duplicate appeared the same
 * week, and the gate would pass while its own prose lied (#10995, the same
 * hides-what-it-names fix as #10990's allowlist). An entry names the exact
 * key set and the exact files allowed to share it; a new file joining fails,
 * a file leaving makes the entry stale, and stale entries fail too.
 */
const COINCIDENT_BY_DESIGN: Record<string, string[]> = {
  "limit,since,tag,until": [
    "schemas-src/mcp-tools/feed.ts",
    "schemas-src/route-queries.ts",
  ],
  // STORAGE and WIRE, not a copy (#11008). `schemas-src/lakehouse.ts` is
  // GENERATED from the Iceberg catalog and declares what the WAREHOUSE holds;
  // the file beside each entry declares what we SERVE. A table and the route
  // over it share a key set by construction -- that is the route doing its
  // job, not a second declaration -- and the types say so: `observed_at` is
  // epoch millis as stored and an ISO string as served; `amount_tao` is a
  // double as stored and opaque on the MCP surface. Collapsing either would
  // erase the formatting seam between the warehouse and the wire.
  //
  // Declared as PAIRS rather than by excluding the generated file, so a third
  // declaration of the same vocabulary still fails.
  "author,block_hash,block_number,event_count,extrinsic_count,observed_at,parent_hash,spec_version":
    ["schemas-src/lakehouse.ts", "schemas-src/routes/blocks.ts"],
  "alpha_amount,amount_tao,block_number,coldkey,event_index,event_kind,extrinsic_index,hotkey,netuid,observed_at,uid":
    ["schemas-src/lakehouse.ts", "schemas-src/mcp-tools/shared.ts"],
};

function main(): void {
  const files = schemaFiles();
  const sites = findObjectShapes(files);
  const duplicates = findDuplicates(sites);
  // A pinned entry excuses exactly the files it names; anything else is new.
  const unlisted = duplicates
    .map((duplicate) => {
      const pinned = COINCIDENT_BY_DESIGN[duplicate.keys];
      if (!pinned) return duplicate;
      const sites = duplicate.sites.filter(
        (site) => !pinned.includes(site.file),
      );
      return { ...duplicate, sites };
    })
    .filter((duplicate) => duplicate.sites.length > 0);
  const stale = Object.entries(COINCIDENT_BY_DESIGN).flatMap(
    ([keys, pinned]) => {
      const match = duplicates.find((duplicate) => duplicate.keys === keys);
      if (!match)
        return [
          `  {${keys}} — no longer duplicated anywhere; delete the entry`,
        ];
      return pinned
        .filter((file) => !match.sites.some((site) => site.file === file))
        .map((file) => `  {${keys}} — ${file} no longer declares it`);
    },
  );
  const report =
    `schema-shape-duplicates: ${duplicates.length} object vocabular(ies) ` +
    `declared in more than one schema file, across ${sites.length} literal(s) ` +
    `of ${MIN_KEYS}+ keys in ${files.length} file(s) ` +
    `(${Object.keys(COINCIDENT_BY_DESIGN).length} pinned by design).`;
  if (stale.length > 0) {
    console.error(
      `${report}\n\nStale pinned entr(y/ies) — they over-excuse, shrink them:\n` +
        stale.join("\n"),
    );
    process.exit(1);
  }
  if (unlisted.length > 0) {
    console.error(
      `${report}\n\nNEW duplicate(s):\n` +
        unlisted
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
}

/* v8 ignore next 3 -- the CLI entry, exercised by the pipeline not the suite. */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
