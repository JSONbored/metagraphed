// node:sqlite standing in for Postgres, for the suites that assert what LANDED.
//
// ## Why this exists on top of tests/helpers/pg-mock.ts
//
// The pg double answers from a `DatabaseSync` so a route test can keep asserting
// rows rather than statement text -- "an older capture is a no-op", "a netuid
// absent from the batch is pruned", "the tally stamps completed_at on the last
// request" are all facts about a row after a real engine ran a real upsert, and
// no fake that returns canned rows can hold them.
//
// The double translates the ONE difference it can see -- `$1` back to `?` -- and
// that was enough while every statement came from a handler written for SQLite.
// The write path is not: src/neon-write.ts and src/pass-completeness.ts EMIT
// Postgres, deliberately, and three of the things they emit are not SQLite at
// all. Each one fails loudly at `prepare`, which is why this translates rather
// than hoping:
//
//   1. `$1::bigint` / `src.netuid::int` -- the `::` cast operator. SQLite calls
//      it "unrecognized token: :". It carries no meaning for SQLite (which is
//      dynamically typed), so it is dropped rather than rewritten to CAST().
//   2. `FROM (VALUES (?, ?), (?, ?)) AS src (a, b)` -- a column-aliased VALUES
//      relation, which is what buildPgUpsert's FILTERED form uses so its
//      predicate can name `src.hotkey`. SQLite has no column list on a table
//      alias, so this becomes the `SELECT ? AS a, ? AS b UNION ALL SELECT ?, ?`
//      form, which is the same relation with the same column names.
//   3. A JS `true`/`false` bind. Postgres has a BOOLEAN type and the sync
//      handlers coerce to real booleans for it; node:sqlite refuses the value
//      outright ("Provided value cannot be bound"). 1/0 is what the column
//      holds on either store.
//
// WHAT IT DELIBERATELY DOES NOT DO. It is not a dialect layer -- nothing here
// makes an incompatible query WORK, it makes a compatible query PARSE. A
// statement using something SQLite genuinely lacks still fails, which is the
// behaviour a test wants: tests/neon-sql-portability.test.ts is what guards the
// read path's dialect, and a translation shim that quietly papered over a real
// incompatibility would take that guarantee away from every suite using it.
import type { DatabaseSync } from "node:sqlite";

/** `$1::bigint` -> `$1`, `src.netuid::int` -> `src.netuid`. Multi-word target
 * types (`double precision`) are matched too, and only as whole words, so a
 * cast is never confused with a schema-qualified name. */
export function stripPgCasts(text: string): string {
  return text.replace(/::\s*[a-z_]+(?:\s+precision)?(?:\s*\[\])?/gi, "");
}

/**
 * `(VALUES (?, ?), (?, ?)) AS src (a, b)`
 *   -> `(SELECT ? AS a, ? AS b UNION ALL SELECT ?, ?) AS src`
 *
 * The alias keeps its name, so the predicate the filtered upsert carries --
 * `EXISTS (... WHERE np.hotkey = src.hotkey ...)` -- is untouched.
 */
export function rewriteAliasedValues(text: string): string {
  return text.replace(
    /\(\s*VALUES\s+((?:\([^()]*\)\s*,\s*)*\([^()]*\))\s*\)\s+AS\s+(\w+)\s*\(([^()]*)\)/gi,
    (_match, groups: string, alias: string, columns: string) => {
      const names = columns.split(",").map((c) => c.trim());
      const selects = [...groups.matchAll(/\(([^()]*)\)/g)].map((g, row) =>
        g[1]!
          .split(",")
          .map((value, i) =>
            row === 0 ? `${value.trim()} AS ${names[i]}` : value.trim(),
          )
          .join(", "),
      );
      return `(SELECT ${selects.join(" UNION ALL SELECT ")}) AS ${alias}`;
    },
  );
}

/** Postgres' BOOLEAN as the integer SQLite stores. */
function sqliteBind(value: unknown): unknown {
  if (value === true) return 1;
  if (value === false) return 0;
  return value;
}

/**
 * Wrap a real database so `pg.control.db = sqliteBackedPg(db)` accepts the
 * Postgres the write path emits.
 *
 * Cast to `DatabaseSync` because that is the field's declared type on the
 * controller; only `prepare(text).all(...)/.run(...)` is ever called on it.
 */
export function sqliteBackedPg(db: DatabaseSync): DatabaseSync {
  return {
    prepare(text: string) {
      const statement = db.prepare(rewriteAliasedValues(stripPgCasts(text)));
      return {
        all: (...values: unknown[]) =>
          statement.all(...(values.map(sqliteBind) as never[])),
        run: (...values: unknown[]) =>
          statement.run(...(values.map(sqliteBind) as never[])),
      };
    },
  } as unknown as DatabaseSync;
}
