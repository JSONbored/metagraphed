// Fail when a GraphQL field reads FEWER tiers than the REST route it mirrors.
//
// Each analytics route answers from a ladder: the Postgres tier, then the
// projection tier (#9146) a cron recomputes from the lakehouse, then a
// schema-stable empty card. The ladder is written out longhand at every call
// site, once in the REST handler and once in the GraphQL resolver, so a rung
// added to one can be missed by the other -- and nothing noticed, because both
// surfaces still answer 200 with a well-formed body.
//
// What that cost: when the projection tier landed, three GraphQL fields were
// left on the old two-rung ladder. They fell past the tier that HAS the data
// straight to the empty card, and answered with a confident zero and no
// degraded marker:
//
//   /api/v1/chain/transfers        REST transfer_count 2,883,743  GraphQL 0
//   /api/v1/chain/transfer-pairs   REST unique_pairs      76,433  GraphQL 0
//   /api/v1/chain/signers          REST signer_count          50  GraphQL 0
//
// Same window, same second. A schema gate cannot see this -- both shapes are
// valid, and zero is a legal Int. Only comparing the LADDERS does.
import { readFileSync, readdirSync } from "node:fs";
import { parse } from "graphql";
import type { ObjectTypeDefinitionNode } from "graphql";

const API_PATH = "workers/api.ts";
const HANDLER_DIR = "workers/request-handlers";
const GRAPHQL_PATH = "src/graphql.ts";
const SDL_PATH = "generated/graphql/schema.ts";

/**
 * Routes whose GraphQL field deliberately reads a shorter ladder, with the
 * reason. Must SHRINK: an entry that no longer names a live divergence fails,
 * so a fix cannot leave a stale exemption behind.
 */
const DECLARED: Record<string, string> = {};

const LOADER = /load[A-Za-z]+FromArtifact/g;

export interface TierSources {
  apiSource: string;
  handlerSources: string[];
  graphqlSource: string;
  sdlSource: string;
  declared?: Record<string, string>;
}

export interface TierReport {
  violations: string[];
  stale: string[];
  compared: number;
}

/** Read the four sources this gate compares. */
export function readTierSources(): TierSources {
  return {
    apiSource: readFileSync(API_PATH, "utf8"),
    handlerSources: readdirSync(HANDLER_DIR)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(`${HANDLER_DIR}/${name}`, "utf8")),
    graphqlSource: readFileSync(GRAPHQL_PATH, "utf8"),
    sdlSource: readFileSync(SDL_PATH, "utf8"),
  };
}

/**
 * Compare each REST route's tier ladder against its GraphQL mirror's.
 *
 * Takes the sources rather than reading them, so a test can drive it with a
 * MUTATED resolver and prove the gate actually fails.
 */
export function checkTierParity({
  apiSource,
  handlerSources,
  graphqlSource,
  sdlSource,
  declared = DECLARED,
}: TierSources): TierReport {
  /** route path -> REST handler function name, from the dispatch table. */
  const handlerByRoute = new Map<string, string>();
  for (const [, route, handler] of apiSource.matchAll(
    /^\s*"(\/api\/v1[^"]*)":\s*(handle[A-Za-z0-9_]*)\s*,?$/gm,
  )) {
    handlerByRoute.set(route, handler);
  }

  /**
   * The body of a top-level function, from its declaration to the next one.
   *
   * Crude on purpose: the question is only "which loader names appear inside
   * this function", and a loader call is always a plain identifier.
   */
  function functionBody(sources: string[], name: string): string | null {
    for (const source of sources) {
      const start = source.search(
        new RegExp(`^(export )?(async )?function ${name}\\b`, "m"),
      );
      if (start < 0) continue;
      const rest = source.slice(start + 1);
      const end = rest.search(/^(export )?(async )?function \w/m);
      return end < 0 ? rest : rest.slice(0, end);
    }
    return null;
  }

  /** The body of a resolver method on the GraphQL rootValue object. */
  function resolverBody(name: string): string | null {
    const start = graphqlSource.search(
      new RegExp(`^  (async )?${name}\\(`, "m"),
    );
    if (start < 0) return null;
    const rest = graphqlSource.slice(start + 1);
    const end = rest.search(/^ {2}(async )?[a-z_][A-Za-z0-9_]*\(/m);
    return end < 0 ? rest : rest.slice(0, end);
  }

  const loadersIn = (source: string): Set<string> =>
    new Set(source.match(LOADER) ?? []);

  // route -> GraphQL field, from the SDL's own Mirrors annotations.
  const sdl = /export const SDL = \/\* GraphQL \*\/ `([\s\S]*?)`;\s*$/m.exec(
    sdlSource,
  );
  if (!sdl)
    throw new Error(`graphql-tier-parity: no SDL literal in ${SDL_PATH}`);
  const query = parse(sdl[1]).definitions.find(
    (d): d is ObjectTypeDefinitionNode =>
      d.kind === "ObjectTypeDefinition" && d.name.value === "Query",
  );
  const fieldByRoute = new Map<string, string>();
  for (const field of query?.fields ?? []) {
    const mirrors = /Mirrors GET (\/api\/v1\/[^\s.]+)/.exec(
      field.description?.value ?? "",
    );
    if (mirrors)
      fieldByRoute.set(mirrors[1].replace(/\.$/, ""), field.name.value);
  }

  const violations: string[] = [];
  const matched = new Set<string>();
  let compared = 0;

  for (const [route, handlerName] of handlerByRoute) {
    const field = fieldByRoute.get(route);
    if (!field) continue;
    const handler = functionBody(handlerSources, handlerName);
    const resolver = resolverBody(field);
    if (!handler || !resolver) continue;
    const restLoaders = loadersIn(handler);
    if (restLoaders.size === 0) continue;
    compared += 1;
    const gqlLoaders = loadersIn(resolver);
    const missing = [...restLoaders].filter((name) => !gqlLoaders.has(name));
    if (!missing.length) continue;
    if (declared[route]) {
      matched.add(route);
      continue;
    }
    violations.push(
      `${field} (${route}) skips ${missing.join(", ")} -- ${handlerName} reads it`,
    );
  }

  return {
    violations,
    stale: Object.keys(declared).filter((route) => !matched.has(route)),
    compared,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = checkTierParity(readTierSources());
  const { violations, stale, compared } = report;

  console.log(
    `graphql-tier-parity: ${compared} route(s) with a projection tier compared against their GraphQL mirror.`,
  );
  if (violations.length) {
    console.error(
      `\n${violations.length} GraphQL field(s) reading a shorter ladder than their route:`,
    );
    for (const line of violations.sort()) console.error(`  - ${line}`);
    console.error(
      "\nA skipped rung is a confident zero: the field answers 200 with a " +
        "well-formed empty body while REST answers with the data.",
    );
  }
  if (stale.length) {
    console.error(
      `\n${stale.length} stale DECLARED entr(y/ies) -- the divergence is gone, delete the entry:`,
    );
    for (const route of stale) console.error(`  - ${route}`);
  }
  // THE REACH, ASSERTED -- not merely printed.
  //
  // This gate counted its comparisons and reported them, then exited on
  // violations alone. Zero comparisons therefore printed "0 route(s)
  // compared" and PASSED. Its three sibling parity gates all failed when the
  // same input went blank; this one did not, which is how it was found
  // (#13251 broke the shared `Mirrors GET` read, and route-parity,
  // published-names and component-parity each failed while this stayed
  // green). A gate that cannot tell "nothing diverges" from "I compared
  // nothing" is not reporting on the schema, and the symptom is silence.
  //
  // The floor follows route-parity's `comparedPairs < 155` precedent.
  // Measured at 16 routes with a projection tier today, and each unit is one
  // route, so 12 tolerates four leaving -- more than any single retirement
  // plausibly removes -- while still refusing the collapse that a broken
  // description read, an unparsed SDL or an unreadable handler source
  // produces. Not tighter, because ordinary retirement must not churn it;
  // not looser, because a floor only a total failure can breach is a comment.
  if (compared < 12) {
    console.error(
      `\nOnly ${compared} route(s) compared, under a floor of 12 -- this gate ` +
        "is not reaching the schema, so its silence means nothing.\n" +
        "If routes or projection tiers were legitimately retired, lower the " +
        "floor IN THE SAME CHANGE and name them. Otherwise suspect the " +
        "`Mirrors GET` read (scripts/lib/graphql-mirrors.ts), the SDL parse, " +
        "or the handler sources -- any of those going blank lands here.",
    );
  }
  if (violations.length || stale.length || compared < 12) process.exit(1);
  console.log("graphql-tier-parity: OK");
}
