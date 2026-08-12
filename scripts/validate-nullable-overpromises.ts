// A producer that writes null into a NON-NULL field fails CI (#10786).
//
// A RULE, NOT A RATCHET, because the count reached zero. The idiom is
// `validate-type-duplicates`' and `validate-untyped-db-reads`': a count while
// there is a backlog, a flat "none" once it is cleared, so the thing that was
// fixed cannot come back one `?? null` at a time.
//
// WHY THIS CANNOT BE LEFT TO A PROBE. `conformance:graphql-nullability` (the
// production sweep, retired once #10214 put the enforcement in the executor)
// asked production and got an honest answer about the HAPPY PATH -- production
// is not degraded when you ask it. Every finding this gate exists for lives on
// a cold-tier or zeroed-card arm, which is exactly where the cost is highest:
// graphql-js enforces non-null at execution, so one null nulls the whole
// surrounding object and attaches an error, turning a degraded-but-readable
// card into nothing at all.
//
// WHAT IT COMPARES: the schema the Zod components build (what the #10214
// cutover installs, and what REST and MCP already serve) against the
// TypeScript checker's view of what each resolver writes. Both sides are
// derived; there is no list here to keep up to date.
//
// WHAT IT DOES NOT FAIL ON, deliberately: a property the walk cannot decide --
// a spread of an untyped bag, or an expression the checker types as `any`.
// Those are unvalidated at the serving boundary, which is a real defect with
// its own issue (#10789) and a different fix. Counting them here would make
// this gate fail for a reason it cannot tell you how to resolve. They are
// REPORTED on every run so the blind spot stays visible rather than becoming
// the quiet zero this gate exists to prevent.

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
  console.log(
    `nullable-overpromises: 0 over-promise(s) across ${report.examined} ` +
      `property write(s) in ${report.fields} root field(s), against the field ` +
      `each one's component declares; ${report.undecided.length} property ` +
      `write(s) undecided (unvalidated at the boundary, #10789).`,
  );
}

/* v8 ignore next 3 -- the CLI entry, exercised by the pipeline not the suite. */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
