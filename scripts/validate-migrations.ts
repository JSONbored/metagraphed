import { promises as fs } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.ts";

// Guard the Postgres migration sequence: each file must be `NNNN_snake_case.sql`
// with a unique 4-digit prefix, ascending and gap-free. Two migrations once
// shared `0007` (0007_neurons from #1303 + 0007_latency_percentiles from #1331),
// which desynced name-keyed migration tracking. The prefix is the canonical
// ordering key, so a duplicate or a gap is a latent apply-drift bug, and this
// guard fails closed so it can never recur.
//
// WHY THE SEQUENCE NO LONGER STARTS AT 0001. This rule was written when the
// FILES were the sequence, under D1. #6477 retired the D1 binding and deleted
// all 81 migration files; #6486 kept the directory alive with a .gitkeep so
// this script would not ENOENT. But the live Postgres `schema_migrations`
// table still records 0001-0044 as applied (the box was adopted with
// apply-migrations.ts's own `--bootstrap-through 0044`), so the DATABASE is now
// the sequence and the files are its tail.
//
// Requiring the first file to be 0001 therefore left no legal move. `0001`
// passes this check and is then SILENTLY SKIPPED by apply-migrations.ts,
// because that version is already recorded -- CI green, PR merged, table never
// created, discovered later as the runtime error that script's own header
// documents from three separate incidents (#5348/#5353; a missing table 502'd
// the entire alerter epic). `0045` applies correctly but fails this check.
//
// So the floor is the watermark, not 1: the next migration is 0045, and the
// sequence stays gap-free from wherever it resumes.
/**
 * The highest version recorded on the live box by the D1-era bootstrap. A new
 * migration must sit ABOVE it, or apply-migrations.ts will treat it as already
 * applied and skip it without a word.
 */
export const RETIRED_D1_WATERMARK = 44;

/**
 * Every problem with a set of migration filenames, as messages.
 *
 * Pulled out of the top-level script so the rule is testable without a
 * directory of fixture files -- the same reason apply-migrations.ts exports
 * pendingMigrations rather than deciding inline.
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
  if (numbers.length > 0 && numbers[0] <= RETIRED_D1_WATERMARK) {
    errors.push(
      `migration prefix ${String(numbers[0]).padStart(4, "0")} (${seen.get(numbers[0])}) is at or below ` +
        `the retired D1 watermark ${String(RETIRED_D1_WATERMARK).padStart(4, "0")} — ` +
        `the live schema_migrations table already records it, so apply-migrations.ts would skip it silently. ` +
        `Number the next migration ${String(RETIRED_D1_WATERMARK + 1).padStart(4, "0")}.`,
    );
  }
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
  const migrationsRoot = path.join(repoRoot, "migrations");
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
