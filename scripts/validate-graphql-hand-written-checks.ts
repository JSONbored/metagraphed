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
//   values, which JSON Schema cannot state. MEASURED for `.refine()`
//   migration in the #10780 aftermath and the movable set is EMPTY: every
//   known cross-argument rule relates a PATH parameter to a QUERY parameter,
//   and the route query schema cannot see the path by construction -- while
//   no query-to-query pair exists (an inverted from/to range answers empty,
//   which is a valid answer, not a rejection). A schema-native home for the
//   path+query rules arrives only with a canonical per-operation input that
//   unifies both, the operations-registry evolution -- not a `.refine()`
//   sprinkled where it cannot reach.
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
 *
 * RAISED ONCE, 245 -> 246 (#9981), and this is the explanation the rule asks
 * for. `pageDocumentCollection` surfaces `applyQueryFilters`' verdict for the
 * four document-shaped collection routes, which is the third case listed above:
 * these resolvers do not go through the REST router, so nothing has parsed the
 * collection's sort/filter vocabulary by the time they run -- the same reason
 * `loadEndpointsPage` and every other collection resolver throws here.
 *
 * It is ONE throw serving FOUR fields. Writing it per field, as the existing
 * collection resolvers do, would have cost four.
 *
 * LOWERED, 246 -> 219 (#10928). Twenty-eight of the throws in this file were
 * ONE check, written out character-identical at every subnet-scoped field:
 * `netuid` is a PATH parameter, so `resolveRouteArgs` -- which resolves a
 * field's arguments against the route's QUERY schema -- never sees it, and
 * nothing parses it before a resolver runs. The check was real and needed;
 * twenty-eight copies of it were not. It now lives once, as
 * `assertNetuidArgument` in src/graphql-limits.ts (plus an optional variant
 * for the two fields where an absent netuid means "do not filter", which is a
 * different contract from 0).
 *
 * That is the direction this constant is supposed to move. The branch that
 * lowered it had itself added a subnet-scoped field, and the first instinct was
 * to raise the ceiling by one and write a justification -- which is how a
 * ratchet becomes a rubber stamp. Extracting the duplicate paid for the new
 * field twenty-seven times over.
 */
// 219 -> 185 (#10993): 41 guards deleted after an empirical audit proved each
// unreachable -- parseArgumentsAtDispatch rejects against the bound route's
// published schema before any resolver runs, so every deleted guard wore an
// error message no caller had ever received. What remains is the LIVE set:
// path-parameter format guards (dispatch validates query parameters only),
// cross-field semantics the schema cannot express, and saved_query (the one
// route:null binding). tests/graphql.test.ts pins the dispatch-level
// rejection for a representative of every deleted class.
// 185 -> 179: four more sort guards proven dispatch-covered and deleted in
// the annotated-consts sweep (probe log on the PR), same method as #10993.
const CEILING = 179;

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
