// A published schema may not accept what it does not describe (#10790).
//
// 343 `.passthrough()` against 575 `.strict()` -- 37% of the contract took
// fields it never declared. `SubnetUptime.observed_at` is the worked example
// (#10761): `formatUptime` emitted it on every card, both transports fed it,
// REST read it back into the response meta, and `UptimeArtifactSchema` never
// declared it. Nothing noticed, for months.
//
// The benign reading is drift. The other reading is the same mechanism: a
// producer that starts emitting an internal field ships it to clients, past a
// response tripwire that validates the declared fields and waves the rest
// through. `safeParse` over `.passthrough()` is a leak guard that does not
// guard -- it costs the CPU and guarantees nothing about what leaves.
//
// ## Why the ban is on the SPELLING, not on openness
//
// Some objects are genuinely open, and saying so is correct. The per-adapter
// metric map is whatever that adapter tracks; the response `meta` carries
// route-specific keys by design. What was wrong is that `.passthrough()` said
// both of those AND "nobody thought about it" in the same four words, so the
// two could not be told apart -- and 330 of the 334 sites turned out to be the
// second kind.
//
// So openness must be spelled `.catchall(...)`, which reads as a decision, and
// `scripts/validate-schema-opacity.ts` already requires an open site to carry a
// written reason and an allowlist entry. This gate bans the spelling that
// carried no decision with it.
//
// A RULE, NOT A RATCHET, because the count reached zero -- the
// `validate-type-duplicates` idiom. `scripts/report-undeclared-fields.ts` is
// the measurement that made the flip safe and stays runnable: it walks all
// 2,363 built artifacts against their components and reports what the payloads
// carry that the schemas do not.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const SCHEMA_ROOT = "schemas-src";

export interface PassthroughSite {
  file: string;
  line: number;
}

/**
 * Every `.passthrough()` CALL under `schemas-src/`.
 *
 * Read through the AST rather than by grepping the text: fifteen of the
 * mentions in this tree are prose in comments explaining why a site was
 * flipped, and a regex gate that failed on its own documentation would be
 * fixed by deleting the documentation.
 */
export function findPassthroughCalls(
  files: readonly string[],
): PassthroughSite[] {
  const out: PassthroughSite[] = [];
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
        node.expression.name.text === "passthrough"
      ) {
        out.push({
          file,
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

function schemaFiles(): string[] {
  return ts.sys
    .readDirectory(path.join(repoRoot, SCHEMA_ROOT), [".ts"], ["node_modules"])
    .map((file) => path.relative(repoRoot, file).split(path.sep).join("/"))
    .filter((file) => !file.endsWith(".d.ts"));
}

function main(): void {
  const files = schemaFiles();
  const sites = findPassthroughCalls(files);
  if (sites.length) {
    console.error(
      `no-passthrough: ${sites.length} schema(s) accept fields they do not describe:\n` +
        sites.map((site) => `  ${site.file}:${site.line}`).join("\n") +
        `\n\nDeclare the field, or -- if the object is genuinely open -- say so ` +
        `with \`.catchall(z.unknown())\` and an entry in ` +
        `scripts/validate-schema-opacity.ts. Run ` +
        `\`npm run report:undeclared-fields\` to see what the built artifacts ` +
        `actually carry there.`,
    );
    process.exit(1);
  }
  console.log(
    `no-passthrough: 0 site(s) across ${files.length} schema file(s); every ` +
      `open object declares itself with \`.catchall\` and a reason.`,
  );
}

/* v8 ignore next 3 -- the CLI entry, exercised by the pipeline not the suite. */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
