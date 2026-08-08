// The gate's own detection, tested both ways.
//
// A validator like this fails in two directions and only one of them is loud.
// If it stops catching the real thing it goes quietly green forever (the
// #8988 lesson from tests/validate-module-state-resets.test.ts); if it flags
// benign binds it gets an allowlist bolted on, and the allowlist becomes the
// blanket exemption. So the benign cases below are pinned as hard as the
// offending ones -- particularly the `{}` case, which is what an untyped
// `Record<string, unknown>` row's property widens to and which, when treated as
// an object bind, buried the four real hits under 46 false ones.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, test } from "vitest";
import { findRiskyBinds } from "../scripts/validate-pg-json-binds.ts";

const PRELUDE = `
type Runner = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  unsafe(text: string, values?: unknown[]): Promise<unknown>;
};
declare const sql: Runner;
// workers/data-api.ts binds the same runner to this name twice.
declare const historySql: Runner;
// ...and nothing stops it being bound to a name with no "sql" in it at all.
declare const store: Runner;
// A tagged template that is NOT a SQL runner must be ignored entirely.
declare function html(strings: TemplateStringsArray, ...values: unknown[]): string;
interface Condition { metric: string; operator: string; threshold: number }
declare const tableFilter: string[] | null;
declare const condition: Condition | null;
declare const label: string | null;
declare const count: number;
declare const flag: boolean;
declare const when: Date;
declare const row: Record<string, unknown>;
declare const keys: string[];
declare const cutoffs: number[];
`;

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

/** `body` compiled as a real program, run through the gate's detection. */
function scan(body: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-json-binds-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "fixture.ts");
  fs.writeFileSync(file, PRELUDE + body);
  const program = ts.createProgram([file], {
    target: ts.ScriptTarget.ES2022,
    strict: true,
    skipLibCheck: true,
  });
  return findRiskyBinds(program, () => true);
}

describe("findRiskyBinds — catches the reinterpreted binds", () => {
  test("an array bind in a tagged template", () => {
    const hits = scan("await sql`UPDATE t SET table_filter = ${tableFilter}`;");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].expression, "tableFilter");
    assert.match(hits[0].type, /string\[\]/);
  });

  // Not broken today -- node-postgres happens to JSON.stringify a plain object
  // -- but it is the same coincidence landing the right way, and the gate is
  // what stops that being load-bearing.
  test("a structured object bind in a tagged template", () => {
    const hits = scan("await sql`UPDATE t SET condition = ${condition}`;");
    assert.equal(hits.length, 1);
    assert.match(hits[0].type, /Condition/);
  });

  test("an array element in sql.unsafe's params array", () => {
    const hits = scan(
      'await sql.unsafe("UPDATE t SET f = $1", [tableFilter]);',
    );
    assert.equal(hits.length, 1);
    assert.equal(hits[0].expression, "tableFilter");
  });

  // A runner is a VALUE, so it can be bound to any identifier. Matching the
  // name `sql` alone walked straight past workers/data-api.ts's two
  // `historySql` templates -- which carry no interpolations today, which is
  // precisely how a gate stays green while its blind spot grows.
  test("a runner bound to a name ending in Sql", () => {
    const hits = scan("await historySql`UPDATE t SET f = ${tableFilter}`;");
    assert.deepEqual(
      hits.map((h) => h.expression),
      ["tableFilter"],
    );
  });

  // The structural test earns its keep here: no name-based rule would catch
  // this one, and nothing stops someone writing it.
  test("a runner bound to a name with no `sql` in it", () => {
    const hits = scan("await store`UPDATE t SET f = ${tableFilter}`;");
    assert.deepEqual(
      hits.map((h) => h.expression),
      ["tableFilter"],
    );
  });

  test("every risky bind in one statement, not just the first", () => {
    const hits = scan(
      "await sql`INSERT INTO t (a, b, c) VALUES (${tableFilter}, ${label}, ${condition})`;",
    );
    assert.deepEqual(
      hits.map((h) => h.expression),
      ["tableFilter", "condition"],
    );
  });
});

describe("findRiskyBinds — leaves the correct binds alone", () => {
  test("the JSON text a JSON TEXT column actually wants", () => {
    assert.deepEqual(
      scan("await sql`UPDATE t SET f = ${JSON.stringify(tableFilter)}`;"),
      [],
    );
  });

  // Widening from `sql` to "any runner" must not widen to "any tagged
  // template" -- an array in an html`` tag is not a SQL bind.
  test("a tagged template that is not a SQL runner", () => {
    assert.deepEqual(scan("html`<p>${tableFilter}</p>`;"), []);
  });

  test("scalars and Date", () => {
    assert.deepEqual(
      scan(
        "await sql`UPDATE t SET a = ${label}, b = ${count}, c = ${flag}, d = ${when}`;",
      ),
      [],
    );
  });

  // The false-positive class that made the first draft useless: `{}` is
  // TypeScript's "any non-nullish value", not evidence of an object bind.
  test("a property read off an untyped row (widens to `{}`)", () => {
    assert.deepEqual(
      scan(
        "await sql`UPDATE t SET a = ${row.status ?? null}, b = ${row.netuid}`;",
      ),
      [],
    );
  });

  // src/neon-write.ts's pruneKeysInNeon: the array IS the intended parameter.
  test("a statement that casts its parameters to array types", () => {
    assert.deepEqual(
      scan(
        'await sql.unsafe("DELETE FROM t USING UNNEST($1::text[], $2::bigint[]) AS c(k, at) WHERE t.k = c.k", [keys, cutoffs]);',
      ),
      [],
    );
  });

  // The exemption is read off the STATEMENT, so it evaporates with the cast
  // rather than outliving it as a file-shaped allowlist would.
  test("the same arrays WITHOUT an array cast are still flagged", () => {
    const hits = scan(
      'await sql.unsafe("DELETE FROM t WHERE k = $1 AND at < $2", [keys, cutoffs]);',
    );
    assert.deepEqual(
      hits.map((h) => h.expression),
      ["keys", "cutoffs"],
    );
  });
});
