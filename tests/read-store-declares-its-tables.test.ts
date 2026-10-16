// A ported reader must declare every table its SQL names.
//
// THE FAILURE THIS EXISTS TO STOP, which no unit test of readStore can reach.
// readStore is all-or-nothing on purpose: it goes to Neon only when Neon owns
// EVERY table it was handed. That rule is only as good as the list. A reader
// that names three tables in its SQL and declares two gets sent to Neon on the
// strength of the two -- and then runs a statement against a store where the
// third does not exist. On a LEFT JOIN that is not an error; it is rows with
// every column of the missing side null, which reads exactly like a block the
// lane never wrote.
//
// The list is also the thing most likely to drift. It sits at the top of the
// module while the SQL that has to agree with it sits hundreds of lines down,
// and adding a table to a query is the natural change that forgets it.
//
// So this reads the SQL back out of each ported module and checks it against
// what that module actually hands readStore. Nothing is listed here that the
// modules do not already state themselves -- a list in this file would be one
// more copy to forget.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, test } from "vitest";

/** Ported in #10148. Each still owns its own table declaration; this only
 *  checks that the declaration covers the SQL. */
const PORTED = [
  "src/chain-detail-hot-tier.ts",
  "src/blocks-cold-tier.ts",
  "src/nominator-positions-hot-tier.ts",
  "src/nominator-positions-cold-tier.ts",
  "src/account-summary-card.ts",
  "src/account-feeds-cold-tier.ts",
];

/** The module's STRING LITERALS, with comments removed first.
 *
 * Both halves are load-bearing. These modules are heavily commented and the
 * prose is full of English "from the" and "join a", so a scan over raw source
 * reports `the`, `a` and `whichever` as tables. And even comment-free source
 * has identifiers and prose in JSDoc; SQL only ever lives in a string. */
function sqlLiterals(source: string): string {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
  return [...withoutComments.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`]*)`/g)]
    .map((m) => m[1] ?? m[2] ?? "")
    .join("\n");
}

/** Tables named after FROM or JOIN, ignoring an alias.
 *
 * A `WITH x AS (...)` name is subtracted: a CTE is a name bound inside the
 * statement, not a table any store has to own. account-feeds-cold-tier's
 * lakehouse summary query is the live example -- it selects `FROM scan`, and
 * `scan` exists only for the length of that statement. */
function tablesInSql(source: string): Set<string> {
  const sql = sqlLiterals(source);
  const ctes = new Set(
    [...sql.matchAll(/\bWITH\s+([a-z_][a-z0-9_]*)\s+AS\s*\(/gi)].map(([, n]) =>
      n!.toLowerCase(),
    ),
  );
  const found = new Set<string>();
  for (const [, name] of sql.matchAll(
    // `chain.` excluded in the pattern: the lakehouse is a different engine
    // (R2 SQL) and is not readStore's business.
    /\b(?:FROM|JOIN)\s+(?!chain\.)([a-z_][a-z0-9_]*)/gi,
  )) {
    const table = name!.toLowerCase();
    if (!ctes.has(table)) found.add(table);
  }
  return found;
}

/** Resolve literal owners without executing imported modules. */
function declaredConstant(
  source: string,
  ident: string,
  file: string,
  load: (file: string) => string,
  exported = false,
): string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const variables = ast.statements.filter(ts.isVariableStatement);
  const locals = variables.flatMap((stmt) => {
    const declarations = stmt.declarationList.declarations;
    const matching = declarations.filter((decl) => {
      return ts.isIdentifier(decl.name) && decl.name.text === ident;
    });
    return matching.map((decl) => ({ stmt, decl }));
  });
  const importStatements = ast.statements.filter(ts.isImportDeclaration);
  const imports = importStatements.flatMap((stmt) => {
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return [];
    const specs = bindings.elements;
    const matching = specs.filter((spec) => spec.name.text === ident);
    return matching.map((spec) => ({ stmt, spec }));
  });
  assert.equal(
    locals.length + imports.length,
    1,
    `${ident} is passed to readStore but has no unique declaration in ${file}`,
  );
  const local = locals[0];
  if (local) {
    assert.ok(local.stmt.declarationList.flags & ts.NodeFlags.Const);
    if (exported) {
      const exportKind = ts.SyntaxKind.ExportKeyword;
      const modifiers = local.stmt.modifiers;
      const isExported = modifiers?.some((m) => m.kind === exportKind);
      assert.ok(isExported, `${ident} is not exported by ${file}`);
    }
    const value = local.decl.initializer;
    assert.ok(
      value &&
        ts.isAsExpression(value) &&
        value.type.getText(ast) === "const" &&
        ts.isArrayLiteralExpression(value.expression),
      `${ident} is not a literal const table tuple in ${file}`,
    );
    const tables = value.expression.elements.map((table) => {
      assert.ok(ts.isStringLiteral(table), `${ident} has a nonliteral table`);
      assert.match(table.text, /^[a-z_][a-z0-9_]*$/i);
      return table.text.toLowerCase();
    });
    assert.ok(tables.length > 0, `${ident} is empty`);
    const unique = new Set(tables);
    assert.equal(unique.size, tables.length, `${ident} repeats a table`);
    return tables;
  }
  // One direct named relative import is enough for shared owners. Re-exports,
  // type-only imports and executable/spread values fail closed.
  assert.ok(!exported, `${ident} is not a directly exported tuple in ${file}`);
  const { stmt, spec } = imports[0]!;
  assert.ok(
    !stmt.importClause?.isTypeOnly && !spec.isTypeOnly,
    "ownership imports must carry values",
  );
  assert.ok(ts.isStringLiteral(stmt.moduleSpecifier));
  assert.match(
    stmt.moduleSpecifier.text,
    /^\.{1,2}\//,
    "ownership imports must be relative",
  );
  const target = path.resolve(path.dirname(file), stmt.moduleSpecifier.text);
  return declaredConstant(
    load(target),
    spec.propertyName?.text ?? spec.name.text,
    target,
    load,
    true,
  );
}

/** Every table named by the shared reader or an explicit D1 ownership check. */
function tablesDeclared(
  source: string,
  file = "source.ts",
  load = (name: string) => readFileSync(name, "utf8"),
): Set<string> {
  const declared = new Set<string>();
  // Inline array: readStore(env, ["neurons"])
  for (const [, list] of source.matchAll(
    /(?:readStore|selectedD1Store)\([^,]+,\s*\[([^\]]*)\]/g,
  )) {
    for (const [, name] of list.matchAll(/"([a-z_][a-z0-9_]*)"/gi))
      declared.add(name.toLowerCase());
  }
  // Named constant: read its local tuple or the named relative import's export.
  for (const [, ident] of source.matchAll(
    /(?:readStore|selectedD1Store)\([^,]+,\s*([A-Z][A-Z0-9_]*)\s*\)/g,
  )) {
    for (const name of declaredConstant(source, ident!, file, load))
      declared.add(name);
  }
  return declared;
}

describe("every ported reader declares the tables it reads", () => {
  test("native and shared owners both declare tables without accepting bare binding reads", () => {
    assert.deepEqual(
      [
        ...tablesDeclared(
          'selectedD1Store(env, ["nominator_positions"]); readStore(env, ["neurons"])',
        ),
      ].sort(),
      ["neurons", "nominator_positions"],
    );
    assert.deepEqual(
      [
        ...tablesDeclared(
          'const TABLES = ["neurons"] as const; selectedD1Store(env, TABLES)',
        ),
      ],
      ["neurons"],
    );
    assert.deepEqual(
      [...tablesDeclared('env.D1_STATE.prepare("SELECT * FROM neurons")')],
      [],
    );
  });
  test("named relative owners resolve aliases and still expose missing SQL tables", () => {
    const file = path.resolve("fixtures/readers/positions.ts");
    const target = path.resolve("fixtures/owners.ts");
    const source =
      'import { TABLES as POSITION_TABLES } from "../owners.ts"; ' +
      "selectedD1Store(env, POSITION_TABLES); " +
      'const sql = "SELECT * FROM nominator_positions JOIN neurons USING (hotkey)";';
    const load = (name: string) => {
      assert.equal(name, target);
      return 'export const TABLES = ["nominator_positions"] as const;';
    };
    const declared = tablesDeclared(source, file, load);
    assert.deepEqual([...declared], ["nominator_positions"]);
    assert.deepEqual(
      [...tablesInSql(source)].filter((table) => !declared.has(table)),
      ["neurons"],
    );
    const complete = tablesDeclared(source, file, (name) => {
      assert.equal(name, target);
      return 'export const TABLES = ["nominator_positions", "neurons"] as const;';
    });
    assert.deepEqual(
      [...tablesInSql(source)].filter((table) => !complete.has(table)),
      [],
    );
  });
  test("unknown, unexported and dynamic imported owners fail closed", () => {
    const file = path.resolve("fixtures/reader.ts");
    const source =
      'import { TABLES } from "./owners.ts"; readStore(env, TABLES)';
    for (const owner of [
      'export const OTHER_TABLES = ["neurons"] as const;',
      'const TABLES = ["neurons"] as const;',
      'export const TABLES = ["neurons", ...OTHER_TABLES] as const;',
      'export const TABLES = ["neurons", dynamicTable] as const;',
      "export const TABLES = getTables();",
      'export { TABLES } from "./another-owner.ts";',
    ]) {
      const load = () => owner;
      assert.throws(() => tablesDeclared(source, file, load));
    }
    assert.throws(() => tablesDeclared("readStore(env, MISSING_TABLES)"));
    const missingModule = () => {
      throw new Error("missing owner module");
    };
    assert.throws(() => {
      tablesDeclared(source, file, missingModule);
    });
    assert.throws(() => {
      tablesDeclared(source.replace('"./owners.ts"', '"owners"'), file);
    }, /ownership imports must be relative/);
    assert.throws(() => {
      tablesDeclared(source.replace("import {", "import type {"), file);
    }, /ownership imports must carry values/);
  });
  for (const file of PORTED) {
    test(file, () => {
      const source = readFileSync(file, "utf8");
      const declared = tablesDeclared(source, file);
      // A module in this list that calls readStore nowhere means the port was
      // reverted, or the file was renamed and this list went stale -- both of
      // which would otherwise show up as a vacuous pass.
      assert.ok(
        declared.size > 0,
        `${file} is listed as ported but hands readStore no tables`,
      );
      const used = tablesInSql(source);
      assert.ok(
        used.size > 0,
        `${file} has no FROM/JOIN -- the scanner matched nothing, so this test proves nothing`,
      );
      const undeclared = [...used].filter((t) => !declared.has(t));
      assert.deepEqual(
        undeclared,
        [],
        `${file} reads ${undeclared.join(", ")} but does not hand it to readStore; ` +
          `readStore would send this module to Neon on the strength of the tables it DID declare`,
      );
    });
  }

  test("no ported reader still reaches for the store binding", () => {
    // The port is a swap, so a leftover binding read is a second store choice
    // in a module that already made one -- and the two would disagree exactly
    // when it matters, which is once Neon owns the tables.
    const offenders = PORTED.filter((file) =>
      readFileSync(file, "utf8").includes("METAGRAPH_HEALTH_DB"),
    );
    assert.deepEqual(offenders, []);
  });
});
