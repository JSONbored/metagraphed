// generated/featured-validators.ts must match registry/featured-validators.json.
//
// The registry file is the source of truth and the generated constant is what
// workers/data-api.ts actually serves from, so drift between them means the
// badge on the wire disagrees with the reviewed commercial record -- in either
// direction. A partner added to the registry and not regenerated is a badge
// that never appears; a hotkey left in the generated file after removal is a
// badge served for an arrangement that has ended, which is the worse of the two.
//
// Same shape as the repo's other generated-artifact gates: regenerate and
// commit, or CI fails.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { repoRoot } from "./lib.ts";
import {
  GENERATED_PATH,
  SOURCE_PATH,
  featuredHotkeysFrom,
  render,
} from "./generate-featured-validators.ts";

function main(): void {
  const raw = readFileSync(path.join(repoRoot, SOURCE_PATH), "utf8");
  const expected = render(featuredHotkeysFrom(raw));
  const actual = readFileSync(path.join(repoRoot, GENERATED_PATH), "utf8");

  if (expected !== actual) {
    process.stderr.write(
      `featured-validators drift: ${GENERATED_PATH} does not match ${SOURCE_PATH}.\n` +
        `  Regenerate and commit:\n` +
        `    node scripts/generate-featured-validators.ts\n`,
    );
    process.exit(1);
  }

  const count = featuredHotkeysFrom(raw).length;
  process.stdout.write(
    `featured-validators: ${GENERATED_PATH} matches ${SOURCE_PATH} (${count} featured hotkey(s)).\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
