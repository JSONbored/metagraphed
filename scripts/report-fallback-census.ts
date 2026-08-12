// The census of producer-side fallbacks feeding contract fields (#10868).
//
// A `?? 0` / `?? null` / `|| []` at a construction site is a default the
// contract does not state, applied where no reader can see it. It is the
// mechanism behind the `?? null`-against-non-null class #10786 closed, and it
// survives wherever a fallback still lives producer-side: the compiler now
// proves the VALUE cannot violate the contract, but the DEFAULT itself stays
// undocumented behaviour a client cannot learn from the schema.
//
// This is the MEASUREMENT half of that issue -- flipping schemas or deleting
// coalesces blind is how the breakage becomes indistinguishable from the leak
// being hunted. The walk is `findOverPromises`' own (every contract-field
// write, through conditionals, fallback chains, `.map` callbacks and the card
// builders), so the census and the nullability gate cannot disagree about
// which writes exist.
//
// Reading the output:
//
//   `?? null` on a NULLABLE field    the degraded-arm marker -- legitimate,
//                                    and the schema already says so
//   `?? <value>` on any field        a default the schema does not state:
//                                    either it belongs there (`.default()` /
//                                    `.meta({default})`) or the input is
//                                    typed non-optional now and the coalesce
//                                    is dead
//   `|| <literal>`                   the truthiness trap on top -- `0` and
//                                    `""` take the fallback too, which is a
//                                    bug class of its own when the field is
//                                    numeric or a string
import { pathToFileURL } from "node:url";
import {
  findOverPromises,
  generatedQueryType,
} from "./report-nullable-overpromises.ts";
import { createRepoProgram } from "./report-type-duplicates.ts";

function main(): void {
  const report = findOverPromises(createRepoProgram(), generatedQueryType());
  const { fallbacks } = report;

  const nullOnNullable = fallbacks.filter(
    (site) => site.fallback === "null" && site.fieldNullable,
  );
  const valued = fallbacks.filter((site) => site.fallback !== "null");
  const truthy = fallbacks.filter((site) => site.operator === "||");

  console.log(
    `fallback-census: ${fallbacks.length} literal fallback(s) inside ` +
      `${report.examined} contract-field write(s) across ${report.fields} ` +
      `root field(s).`,
  );
  console.log(
    `\n  ${nullOnNullable.length} × \`?? null\` on a NULLABLE field ` +
      `(degraded-arm markers, the schema already agrees)` +
      `\n  ${valued.length} × a VALUE default the schema does not state` +
      `\n  ${truthy.length} × \`||\` (0/"" take the fallback too)`,
  );

  const byFallback = new Map<string, number>();
  for (const site of valued) {
    byFallback.set(site.fallback, (byFallback.get(site.fallback) ?? 0) + 1);
  }
  if (byFallback.size) {
    console.log("\nVALUE DEFAULTS by fallback:");
    for (const [text, n] of [...byFallback].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${text}`);
    }
    console.log("\nVALUE-DEFAULT SITES:");
    for (const site of valued) {
      console.log(
        `  ${site.file}:${site.line} ${site.path} ${site.operator} ${site.fallback}`,
      );
    }
  }
  if (truthy.length) {
    console.log("\n`||` SITES (truthiness on top of the default):");
    for (const site of truthy) {
      console.log(
        `  ${site.file}:${site.line} ${site.path} || ${site.fallback}`,
      );
    }
  }
}

/* v8 ignore next 3 -- the CLI entry, exercised by the pipeline not the suite. */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
