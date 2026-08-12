// A producer that writes null into a NON-NULL field fails CI (#10786).
//
// A RULE, NOT A RATCHET, because the count reached zero. The idiom is
// `validate-type-duplicates`' and `validate-untyped-db-reads`': a count while
// there is a backlog, a flat "none" once it is cleared, so the thing that was
// fixed cannot come back one `?? null` at a time.
//
// WHY THIS CANNOT BE LEFT TO THE PROBE. `conformance:graphql-nullability` asks
// production and gets an honest answer about the HAPPY PATH -- production is
// not degraded when you ask it. Every finding this gate exists for lives on a
// cold-tier or zeroed-card arm, which is exactly where the cost is highest:
// graphql-js enforces non-null at execution, so one null nulls the whole
// surrounding object and attaches an error, turning a degraded-but-readable
// card into nothing at all.
//
// WHAT IT COMPARES: the schema the Zod components build (what the #10214
// cutover installs, and what REST and MCP already serve) against the
// TypeScript checker's view of what each resolver writes. Both sides are
// derived; there is no list here to keep up to date.
//
// UNDECIDED reached zero too (#10867), so it is also a rule now: a spread the
// walk cannot type must carry a `DECLARED_PASSTHROUGHS` entry naming where
// its guarantee actually lives (the artifact builder tsc-checks against the
// same Zod component; the executor enforces the published nullability per
// request) -- and an entry with no matching spread fails as stale, so the
// list can only describe what exists. An `any`-typed write or a field the
// schema does not build still reports without failing: each has a different
// fix, and the count of both is zero on the tree this shipped against.

import { pathToFileURL } from "node:url";
import {
  findOverPromises,
  generatedQueryType,
} from "./report-nullable-overpromises.ts";
import { createRepoProgram } from "./report-type-duplicates.ts";

function main(): void {
  const report = findOverPromises(createRepoProgram(), generatedQueryType());
  if (report.findings.length) {
    console.error(
      `nullable-overpromises: ${report.findings.length} producer site(s) write ` +
        `null into a field the components declare NON-NULL. graphql-js nulls ` +
        `the whole surrounding object on each, worst when the tier is already ` +
        `sick:\n` +
        report.findings
          .map(
            (finding) =>
              `  ${finding.file}:${finding.line} ${finding.path} -- decide ` +
              `which side is wrong: the Zod (the producer genuinely cannot ` +
              `fill it), the producer (a defensive fallback left from an ` +
              `untyped Row), or the projection (only this VIEW cannot fill it).`,
          )
          .join("\n"),
    );
    process.exit(1);
  }
  const undeclaredSpreads = report.undecided.filter(
    (entry) => entry.reason === "spread",
  );
  if (undeclaredSpreads.length) {
    console.error(
      `nullable-overpromises: ${undeclaredSpreads.length} spread(s) the walk ` +
        `cannot type and no DECLARED_PASSTHROUGHS entry covers. Type the ` +
        `source, or declare the passthrough with the evidence for where its ` +
        `non-null guarantee lives (#10867):\n` +
        undeclaredSpreads
          .map((entry) => `  ${entry.file}:${entry.line} ${entry.path}`)
          .join("\n"),
    );
    process.exit(1);
  }
  if (report.stalePassthroughs.length) {
    console.error(
      `nullable-overpromises: ${report.stalePassthroughs.length} declared ` +
        `passthrough(s) with no matching spread -- the excuse outlived what ` +
        `it excused; delete the entr(ies): ` +
        report.stalePassthroughs.join(", "),
    );
    process.exit(1);
  }
  console.log(
    `nullable-overpromises: 0 over-promise(s) across ${report.examined} ` +
      `property write(s) in ${report.fields} root field(s), against the field ` +
      `each one's component declares; ${report.passthroughs.length} declared ` +
      `passthrough(s), ${report.undecided.length} undecided.`,
  );
}

/* v8 ignore next 3 -- the CLI entry, exercised by the pipeline not the suite. */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
