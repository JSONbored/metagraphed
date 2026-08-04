import { promises as fs } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.ts";

// Guard the D1 migration sequence: each file must be `NNNN_snake_case.sql`
// with a unique 4-digit prefix, ascending and gap-free. Two migrations once
// shared `0007` (0007_neurons from #1303 + 0007_latency_percentiles from #1331),
// which desynced name-keyed migration tracking. The prefix is the canonical
// ordering key, so a duplicate or a gap is a latent apply-drift bug, and this
// guard fails closed so it can never recur.
//
// WHY THE SEQUENCE STARTS AT 0001 AGAIN. This guard used to enforce a floor of 0044,
// because the live Postgres `schema_migrations` table recorded 0001-0044 as applied and
// a file numbered below that was SILENTLY SKIPPED by the Postgres migration runner --
// CI green, PR
// merged, table never created, discovered later as a runtime error (#5348/#5353; a
// missing table 502'd an entire epic).
//
// Postgres is gone (#9426) and that table went with it. migrations/d1 is applied by
// wrangler, which consults no version table, so there is no watermark to sit above and
// the sequence legitimately begins at 0001.
//
// The guarantee that survives is the one that always mattered: prefixes unique,
// ascending and gap-free. It matters MORE here, because D1 migrations are applied BY
// HAND -- there is no apply step that would notice a duplicate on the way past.

/**
 * Every problem with a set of migration filenames, as messages.
 *
 * Pulled out of the top-level script so the rule is testable without a
 * directory of fixture files.
 */
export function migrationSequenceErrors(files: readonly string[]): string[] {
  const errors: string[] = [];
  const seen = new Map<number, string>(); // prefix number -> filename
  const numbers: number[] = [];

  for (const file of [...files].sort()) {
    const match = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/.exec(file);
    if (!match) {
      errors.push(
        `${file}: must be named NNNN_snake_case.sql (4-digit prefix)`,
      );
      continue;
    }
    const num = Number(match[1]);
    if (seen.has(num)) {
      errors.push(
        `duplicate migration prefix ${match[1]}: ${seen.get(num)} and ${file}`,
      );
      continue;
    }
    seen.set(num, file);
    numbers.push(num);
  }

  numbers.sort((a, b) => a - b);
  for (let i = 1; i < numbers.length; i += 1) {
    const expected = numbers[i - 1] + 1;
    if (numbers[i] !== expected) {
      errors.push(
        `non-sequential migration prefix: expected ${String(expected).padStart(4, "0")} ` +
          `but found ${String(numbers[i]).padStart(4, "0")} (${seen.get(numbers[i])}) — ` +
          `prefixes must be gap-free`,
      );
      break;
    }
  }
  return errors;
}

// Only run when invoked directly, not when imported for the helper above.
if (import.meta.url === `file://${process.argv[1]}`) {
  // migrations/d1, not migrations/. Postgres is gone (#9426) and its migrations went
  // with it, but this guarantee matters MORE on D1: those migrations are applied BY
  // HAND, so a duplicate prefix is not caught by an apply step that would have
  // noticed. The rule and the failure mode are identical -- only the directory moved.
  const migrationsRoot = path.join(repoRoot, "migrations", "d1");
  const files = (await fs.readdir(migrationsRoot)).filter((name) =>
    name.endsWith(".sql"),
  );
  const errors = migrationSequenceErrors(files);

  if (errors.length > 0) {
    console.error(
      `Migration validation failed with ${errors.length} issue(s):`,
    );
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(
    `Validated ${files.length} migration file(s) — prefixes unique and sequential.`,
  );
}
