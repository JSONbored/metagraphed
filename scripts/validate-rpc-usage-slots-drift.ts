// generated/rpc-usage-slots.json must match src/rpc-usage-capture.ts (#11078).
//
// The generated file is vendored into metagraphed-infra and read by the
// AE -> Iceberg exporter. Drift here is the worst kind available in this
// codebase: Analytics Engine rows carry no column names, so a slot that
// disagrees does not error, it writes the wrong column into the archive and
// nothing downstream can tell.
//
// Same shape as the repo's other generated-artifact gates: regenerate and
// commit, or CI fails.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { repoRoot } from "./lib.ts";
import { GENERATED_PATH, render } from "./generate-rpc-usage-slots.ts";

function main(): void {
  const expected = render();
  const actual = readFileSync(path.join(repoRoot, GENERATED_PATH), "utf8");
  if (expected !== actual) {
    process.stderr.write(
      `rpc-usage-slots drift: ${GENERATED_PATH} does not match src/rpc-usage-capture.ts.\n` +
        `  Regenerate and commit:\n` +
        `    node scripts/generate-rpc-usage-slots.ts\n` +
        `  Then re-vendor it in metagraphed-infra, or its exporter keeps the old map.\n`,
    );
    process.exit(1);
  }
  const slots = JSON.parse(actual) as {
    blobs: unknown[];
    doubles: unknown[];
  };
  process.stdout.write(
    `rpc-usage-slots: ${GENERATED_PATH} matches src/rpc-usage-capture.ts ` +
      `(${slots.blobs.length + slots.doubles.length} slots).\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
