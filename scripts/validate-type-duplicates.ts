// A hand-written type that IS a generated one fails CI (#10784).
//
// A RULE, NOT A RATCHET, because the census reached zero. The idiom is
// `validate-untyped-db-reads`': a count while there is a backlog, a flat "none"
// once the backlog is cleared, so the thing that was fixed cannot come back one
// declaration at a time.
//
// Two failures, and they are different mistakes:
//
//   a structural duplicate  -> a declaration field-for-field identical to a
//                              generated type, with nothing connecting the two.
//                              `ResolvedIdentifier` was this: a `kind` added to
//                              the published enum would have compiled fine here
//                              and answered a value the schema does not admit.
//
//   an aliased-and-widened  -> `type Foo = GeneratedFoo & { extra }`, which
//      generated type          re-introduces the parallel shape with extra
//                              steps. A field a producer genuinely adds belongs
//                              in the schema, where the other two surfaces can
//                              see it.
//
// What it does NOT fail on, deliberately: a hand-written type with no generated
// counterpart. Options bags, accumulators and closure shapes are legitimately
// local, and deleting one to move a number is how a census stops describing the
// tree. 949 of them remain and that is the correct answer, not a backlog.

import { pathToFileURL } from "node:url";
import { createRepoProgram, runCensus } from "./report-type-duplicates.ts";

function main(): void {
  const report = runCensus(createRepoProgram());
  const problems = [
    ...report.duplicates.map(
      (finding) =>
        `  ${finding.hand.file}:${finding.hand.line} ${finding.hand.name} is ` +
        `field-for-field ${finding.generated.name} (${finding.generated.file}). ` +
        `Alias the generated type instead of restating its shape.`,
    ),
    ...report.widened.map(
      (finding) =>
        `  ${finding.file}:${finding.line} ${finding.name} aliases ` +
        `${finding.base} and widens it. A field the producer genuinely adds ` +
        `belongs in the schema, not beside it.`,
    ),
  ];
  if (problems.length) {
    console.error(
      `type-duplicates: ${problems.length} hand-written type(s) duplicating a generated one:\n` +
        problems.join("\n"),
    );
    process.exit(1);
  }
  console.log(
    `type-duplicates: 0 structural duplicate(s) and 0 widened alias(es) across ` +
      `${report.handWritten} hand-written declaration(s) in src/ + workers/, ` +
      `against ${report.generated} generated one(s).`,
  );
}

/* v8 ignore next 3 -- the CLI entry, exercised by the pipeline not the suite. */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
