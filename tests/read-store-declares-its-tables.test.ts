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

/** Every table name appearing in a readStore(...) call in the module. */
function tablesDeclared(source: string): Set<string> {
  const declared = new Set<string>();
  // Inline array: readStore(env, ["neurons"])
  for (const [, list] of source.matchAll(/readStore\([^,]+,\s*\[([^\]]*)\]/g)) {
    for (const [, name] of list.matchAll(/"([a-z_][a-z0-9_]*)"/gi))
      declared.add(name.toLowerCase());
  }
  // Named constant: readStore(env, BLOCKS_SEAM_TABLES) -> read the constant.
  for (const [, ident] of source.matchAll(
    /readStore\([^,]+,\s*([A-Z][A-Z0-9_]*)\s*\)/g,
  )) {
    const decl = source.match(
      new RegExp(`${ident}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`),
    );
    assert.ok(decl, `${ident} is passed to readStore but never declared`);
    for (const [, name] of decl[1]!.matchAll(/"([a-z_][a-z0-9_]*)"/gi))
      declared.add(name.toLowerCase());
  }
  return declared;
}

describe("every ported reader declares the tables it reads", () => {
  for (const file of PORTED) {
    test(file, () => {
      const source = readFileSync(file, "utf8");
      const declared = tablesDeclared(source);
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

  test("no ported reader still reaches for the D1 binding", () => {
    // The port is a swap, so a leftover binding read is a second store choice
    // in a module that already made one -- and the two would disagree exactly
    // when it matters, which is once Neon owns the tables.
    const offenders = PORTED.filter((file) =>
      readFileSync(file, "utf8").includes("METAGRAPH_HEALTH_DB"),
    );
    assert.deepEqual(offenders, []);
  });
});
