// The hand-written argument checks in `src/graphql.ts` may only SHRINK (#10316).
//
// #10218 gave REST a dispatch-level parse and deleted the seven hand-rolled
// parsers it made dead. GraphQL got the same `validateRouteArgs` function and
// OPT-IN adoption, and opt-in decayed exactly the way opt-in does: 8 of 165
// resolvers called it, and the other checks were written by hand, one `if` at a
// time, because adding one is easier than finding the shared thing. Nothing
// counted them, so nobody knew the number was growing.
//
// The parse now runs for every bound Query field before its resolver
// (`parseArgumentsAtDispatch`), which is what made the deletions possible. This
// gate is what stops the next session from adding the 251st: the count is
// pinned, and a diff that raises it fails with the reason it should not.
//
// ── Why a COUNT and not a ban ──────────────────────────────────────────────
//
// The remaining throws are not all replaceable, and pretending otherwise would
// make this gate a thing people work around. Three kinds legitimately stay:
//
//   NOT-FOUND and unavailability -- `subnet 4096 does not exist` is a fact
//   about the data, not about the argument, and no schema can express it.
//
//   CROSS-ARGUMENT rules -- `counterparty must differ from ss58` relates two
//   values, which JSON Schema cannot state (#10219 tracks `.refine()` for the
//   ones that could move into the schema).
//
//   FIELDS WITH NO ROUTE -- the eight `QUERY_BINDINGS` entries with
//   `route: null` compose several routes or none, so there is no single
//   published schema to parse against.
//
// What must not come back is a check that restates a bound the contract already
// publishes. A ceiling is falling; the ratchet is how it stays fallen.
import { readFileSync } from "node:fs";

/**
 * The number of `BAD_USER_INPUT` throws `src/graphql.ts` may contain.
 *
 * MEASURED, not chosen. Lower it when you delete one -- that is the only edit
 * this constant should ever receive, and a diff that raises it has to explain
 * itself in review rather than sliding past.
 */
const CEILING = 245;

const SOURCE = "src/graphql.ts";

export function countHandWrittenChecks(source: string): number {
  return source.split("BAD_USER_INPUT").length - 1;
}

export function run(): { count: number; ceiling: number; ok: boolean } {
  const count = countHandWrittenChecks(readFileSync(SOURCE, "utf8"));
  return { count, ceiling: CEILING, ok: count <= CEILING };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { count, ceiling, ok } = run();
  if (!ok) {
    console.error(
      `${SOURCE} has ${count} BAD_USER_INPUT checks, above the ${ceiling} ceiling.\n` +
        "\n" +
        "A resolver argument that a route publishes a bound for is parsed at\n" +
        "dispatch (`parseArgumentsAtDispatch`) -- an enum, a pattern, a format,\n" +
        "a length, a numeric range. Writing the check by hand puts a second copy\n" +
        "of a published fact in a place the contract cannot see, which is the\n" +
        "drift #10060 exists to remove.\n" +
        "\n" +
        "If the check is genuinely not expressible in the schema (a missing\n" +
        "subnet, a rule relating two arguments, a field with no bound route),\n" +
        "raise this ceiling in the same commit and say which of the three it is.",
    );
    process.exit(1);
  }
  console.log(
    `GraphQL hand-written checks: ${count} of ${ceiling} allowed (the ceiling only falls).`,
  );
}
