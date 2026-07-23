import { promises as fs } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.ts";

// Guard the D1 migration sequence: each file must be `NNNN_snake_case.sql` with a
// unique, gap-free 4-digit prefix. Two migrations once shared `0007`
// (0007_neurons from #1303 + 0007_latency_percentiles from #1331), which desynced
// wrangler's name-keyed migration tracking. Migrations are applied file-by-file
// via `wrangler d1 execute --file`, so the prefix is the canonical ordering key —
// a duplicate or a gap is a latent apply-drift bug. This guard fails closed so it
// can never recur.
const migrationsRoot = path.join(repoRoot, "migrations");
const files = (await fs.readdir(migrationsRoot))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const errors: string[] = [];

const seen = new Map<number, string>(); // prefix number -> filename
const numbers: number[] = [];
for (const file of files) {
  const match = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/.exec(file);
  if (!match) {
    errors.push(`${file}: must be named NNNN_snake_case.sql (4-digit prefix)`);
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
for (let i = 0; i < numbers.length; i += 1) {
  const expected = i + 1;
  if (numbers[i] !== expected) {
    errors.push(
      `non-sequential migration prefix: expected ${String(expected).padStart(4, "0")} ` +
        `but found ${String(numbers[i]).padStart(4, "0")} (${seen.get(numbers[i])}) — ` +
        `prefixes must be gap-free starting at 0001`,
    );
    break;
  }
}

if (errors.length > 0) {
  console.error(`Migration validation failed with ${errors.length} issue(s):`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Validated ${files.length} migration file(s) — prefixes unique and sequential.`,
);
