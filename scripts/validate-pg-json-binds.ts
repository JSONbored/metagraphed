#!/usr/bin/env node
// Fails when a SQL bind hands node-postgres a value it will REINTERPRET.
//
// WHY THIS IS A GATE AND NOT A CONVENTION. The DELETED `createD1Sql` (#10179)
// coerced every object/array bind through JSON.stringify, so a `string[]`
// reached the store as JSON text and the matching `parseJsonColumn` read it
// straight back. `createPgSql` deliberately does NOT coerce -- it hands the
// value to node-postgres, which applies its OWN rules:
//
//   ["a","b"]            -> {"a","b"}        a Postgres ARRAY LITERAL, not JSON
//   {metric:"x"}         -> {"metric":"x"}   JSON, but only by coincidence
//
// Nothing replaced that coercion when the runner changed, so an array bind into
// a JSON TEXT column silently writes a value its own reader cannot parse.
// `parseJsonColumn` catches the throw and returns null, so nothing errors -- the
// column just reads back empty forever.
//
// That is not hypothetical: it happened to `chain_alert_triggers.table_filter`,
// where a trigger scoped to one table read back as unscoped and therefore fired
// on EVERY table. An over-delivery with no error and no silence, which is the
// hardest shape of bug to notice. Both suites covering that write path proved
// the round trip against D1 -- the runner production had already stopped using
// -- so they stayed green throughout.
//
// `jsonColumn` in workers/data-api.ts is the fix for the two columns that bug
// reached. This gate is the part that generalises: it is what makes the NEXT
// array bound into a JSON TEXT column fail at PR time instead of silently.
//
// The check is TYPE-DIRECTED rather than textual, because the bug is invisible
// in the source: `${v.tableFilter}` and `${v.name}` look identical, and only the
// static type says one is a `string[]`.
//
// THE ONE LEGITIMATE ARRAY BIND is a statement that declares it takes an array
// -- `UNNEST($1::text[], $2::bigint[])` in src/neon-write.ts's pruneKeysInNeon,
// where the array IS the intended parameter. Those are exempted by reading the
// STATEMENT (does it cast a parameter to an array type?), never by listing a
// file: a name-based allowlist would go stale into a blanket exemption, while a
// statement that stops casting stops being exempt on its own.
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ROOTS = ["src/", "workers/"];

export interface RiskyBind {
  file: string;
  line: number;
  expression: string;
  type: string;
}

/** A statement that casts a parameter to an array type, or feeds one to UNNEST,
 * is asking for a real array -- the one shape node-postgres should serialise
 * itself. Read off the statement so the exemption cannot outlive the cast. */
function declaresArrayParameter(text: string): boolean {
  return /::\s*\w+\s*\[\]/.test(text) || /\bUNNEST\s*\(/i.test(text);
}

export function findRiskyBinds(
  program: ts.Program,
  isTargetFile: (rel: string) => boolean,
): RiskyBind[] {
  const checker = program.getTypeChecker();

  const SCALAR =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void |
    ts.TypeFlags.Never |
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown |
    ts.TypeFlags.TypeParameter;

  const partsOf = (type: ts.Type): ts.Type[] =>
    type.isUnion() ? type.types.flatMap(partsOf) : [type];

  function isRisky(type: ts.Type): boolean {
    if (type.flags & SCALAR) return false;
    if (checker.isArrayType(type) || checker.isTupleType(type)) return true;
    const name = type.getSymbol()?.getName();
    if (name && ["Date", "Buffer", "Uint8Array"].includes(name)) return false;
    if ((type.flags & ts.TypeFlags.Object) === 0) return false;
    if (type.getCallSignatures().length > 0) return false;
    // `{}` is TypeScript's "any non-nullish value" -- what an untyped
    // `Record<string, unknown>` row's property widens to. It is NOT evidence of
    // an object bind, and flagging it would bury the real hits under hundreds
    // of scalar columns read off untyped rows. A genuine structured bind has
    // declared properties or an index signature.
    return (
      type.getProperties().length > 0 ||
      checker.getIndexInfosOfType(type).length > 0
    );
  }

  const found: RiskyBind[] = [];

  const consider = (
    sf: ts.SourceFile,
    rel: string,
    expr: ts.Node,
    statementText: string,
    forced?: ts.Type,
  ) => {
    if (declaresArrayParameter(statementText)) return;
    const type = forced ?? checker.getTypeAtLocation(expr);
    if (!partsOf(type).some(isRisky)) return;
    const { line } = sf.getLineAndCharacterOfPosition(expr.getStart());
    found.push({
      file: rel,
      line: line + 1,
      expression: expr.getText().replace(/\s+/g, " ").slice(0, 80),
      type: checker.typeToString(type).slice(0, 80),
    });
  };

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const rel = path.relative(repoRoot, sf.fileName).replace(/\\/g, "/");
    if (!isTargetFile(rel)) continue;

    const visit = (node: ts.Node) => {
      // sql`INSERT ... ${value}`
      if (
        ts.isTaggedTemplateExpression(node) &&
        /(^|\.)sql$/i.test(node.tag.getText()) &&
        ts.isTemplateExpression(node.template)
      ) {
        const text = node.template.getText();
        for (const span of node.template.templateSpans) {
          consider(sf, rel, span.expression, text);
        }
      }
      // sql.unsafe(text, values) / client.query(text, values): the params
      // array's ELEMENTS are the binds.
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        /^(unsafe|query)$/.test(node.expression.name.text) &&
        node.arguments.length >= 2
      ) {
        const statementText = node.arguments[0].getText();
        const params = node.arguments[1];
        if (ts.isArrayLiteralExpression(params)) {
          for (const element of params.elements) {
            if (ts.isSpreadElement(element)) continue;
            consider(sf, rel, element, statementText);
          }
        } else {
          // A params array passed as a variable: check its ELEMENT type, since
          // the array itself is always an array.
          const t = checker.getTypeAtLocation(params);
          const element = checker.getTypeArguments(t as ts.TypeReference)?.[0];
          if (element) consider(sf, rel, params, statementText, element);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return found;
}

function main() {
  const configPath = ts.findConfigFile(
    repoRoot,
    ts.sys.fileExists,
    "tsconfig.json",
  );
  if (!configPath) {
    console.error("validate-pg-json-binds: no tsconfig.json at the repo root.");
    process.exit(1);
  }
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    path.dirname(configPath),
  );
  const program = ts.createProgram(parsed.fileNames, parsed.options);

  const offenders = findRiskyBinds(
    program,
    (rel) => ROOTS.some((r) => rel.startsWith(r)) && !/\.test\.ts$/.test(rel),
  );

  if (offenders.length > 0) {
    console.error(
      `validate-pg-json-binds: ${offenders.length} SQL bind(s) hand node-postgres a value it will reinterpret.\n`,
    );
    for (const o of offenders) {
      console.error(`  ${o.file}:${o.line}`);
      console.error(`    ${o.expression}`);
      console.error(`    type: ${o.type}`);
    }
    console.error(
      `\nAn ARRAY bind becomes a Postgres array literal ({"a","b"}), which is not JSON,` +
        `\nso the column's own JSON.parse reader degrades it to null on every later read.` +
        `\nAn OBJECT bind only survives because node-postgres happens to JSON.stringify it.` +
        `\n\nBind the JSON text explicitly (workers/data-api.ts's \`jsonColumn\`, or` +
        `\nJSON.stringify at the call site). If the statement genuinely takes an array,` +
        `\ncast the parameter -- \`$1::text[]\` or UNNEST(...) -- and it is exempt.`,
    );
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      { name: "validate-pg-json-binds", status: "passed" },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main();
}
