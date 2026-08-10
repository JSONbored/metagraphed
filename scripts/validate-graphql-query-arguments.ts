// The Query root's arguments must be exactly what the routes publish (#10214).
//
// `validate-graphql-route-parity` already checks that no SDL argument is
// unpublished and no published parameter is unreachable, but it compares
// COMPATIBILITY -- `String` against `{type:"integer"}` is a declared
// divergence and the pair is suppressed. The generator needs the exact
// spelling, so this compares the SDL's argument list against
// `deriveQueryArguments()` name for name and type for type. When the two agree
// on all 167 route-backed fields, the generator can emit the Query root from
// the routes and nothing has to be retyped by hand.
//
// The remaining difference is the 20 fields whose route has a `/{network}/`
// twin and which take no `network` argument -- testnet is reachable over REST
// and not over GraphQL (#10394). They are declared below, and the list only
// shrinks: closing one and leaving its entry fails.
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { parse, print } from "graphql";
import type { ObjectTypeDefinitionNode } from "graphql";
import { QUERY_BINDINGS } from "../schemas-src/graphql/published-names.ts";
import { DECLARED_ARGUMENT_TYPES } from "../schemas-src/graphql/argument-divergences.ts";
import {
  deriveQueryArguments,
  type OpenApiParameters,
  type QueryArgument,
} from "../schemas-src/graphql/query-arguments.ts";
import { extractSdl } from "./validate-graphql-component-parity.ts";

const SDL_PATH = "src/graphql-sdl.ts";
const OPENAPI_PATH = "public/metagraph/openapi.json";

/**
 * Query fields whose route has a `/{network}/` twin and which publish no
 * `network` argument (#10394).
 *
 * Each is a capability REST has and GraphQL does not: `GET /api/v1/test/blocks`
 * answers testnet block 7749726 while `blocks(network: test)` is an unknown
 * argument. Closing one means adding the argument AND network-scoping the
 * resolver's tier read, which is #10394's work, not the generator's.
 *
 * THE LIST ONLY SHRINKS -- an entry whose field now takes `network` fails.
 */
export const DECLARED_MISSING_NETWORK: readonly string[] = [
  "block",
  "block_events",
  "block_extrinsics",
  "blocks",
  "blocks_summary",
  "chain_activity",
  "chain_alpha_volume",
  "chain_calls",
  "chain_deregistrations",
  "chain_fees",
  "chain_registrations",
  "chain_signers",
  "chain_stake_flow",
  "chain_stake_moves",
  "chain_stake_transfers",
  "chain_transfer_pairs",
  "chain_transfers",
  "coverage",
  "economics",
  "extrinsics",
];

export interface ArgumentReport {
  /** Fields whose argument list the routes reproduce exactly. */
  exact: number;
  /** Fields skipped: no route, or a route openapi.json does not describe. */
  skipped: number;
  violations: string[];
  /** Declared entries that no longer describe a live difference. */
  stale: string[];
}

/**
 * Compare every Query field's declared arguments against the derived ones.
 *
 * A pure function over the SDL text and the OpenAPI document so a test can
 * drive it with a mutated schema -- a gate only ever run against a passing
 * tree proves nothing.
 */
export function checkQueryArguments(
  sdl: string,
  openapi: OpenApiParameters,
  missingNetwork: readonly string[] = DECLARED_MISSING_NETWORK,
): ArgumentReport {
  const types = new Map<string, ObjectTypeDefinitionNode>();
  for (const def of parse(sdl).definitions) {
    if (def.kind === "ObjectTypeDefinition") types.set(def.name.value, def);
  }

  /** The SDL's own argument list for a Query field. */
  const declaredArguments = new Map<string, QueryArgument[]>();
  for (const field of types.get("Query")?.fields ?? []) {
    declaredArguments.set(
      field.name.value,
      (field.arguments ?? []).map((argument) => ({
        name: argument.name.value,
        type: print(argument.type),
      })),
    );
  }

  /** A return type with no `JSON` member can be projected by a selection set. */
  const returnsProjectable = (returns: string): boolean => {
    const named = types.get(returns.replace(/[![\]]/g, ""));
    if (!named) return false;
    return !(named.fields ?? []).some((field) =>
      print(field.type).includes("JSON"),
    );
  };

  const violations: string[] = [];
  const usedNetwork = new Set<string>();
  const usedDeclared = new Set<string>();
  let exact = 0;
  let skipped = 0;

  for (const binding of QUERY_BINDINGS) {
    const declared = declaredArguments.get(binding.field);
    if (!declared || !binding.route || !openapi.paths?.[binding.route]) {
      skipped += 1;
      continue;
    }
    const twin = binding.route.replace("/api/v1/", "/api/v1/{network}/");
    const derived = deriveQueryArguments(
      binding.field,
      binding.route,
      openapi,
      {
        hasNetworkTwin: Boolean(openapi.paths?.[twin]),
        returnsProjectable: returnsProjectable(binding.returns),
      },
    );
    for (const argument of derived) {
      if (DECLARED_ARGUMENT_TYPES[`${binding.field}.${argument.name}`]) {
        usedDeclared.add(`${binding.field}.${argument.name}`);
      }
    }

    const declaredByName = new Map(declared.map((a) => [a.name, a.type]));
    const derivedByName = new Map(derived.map((a) => [a.name, a.type]));
    const problems: string[] = [];
    for (const [name, type] of derivedByName) {
      const found = declaredByName.get(name);
      if (found === type) continue;
      if (found === undefined) {
        // The one difference with a home of its own.
        if (name === "network" && missingNetwork.includes(binding.field)) {
          usedNetwork.add(binding.field);
          continue;
        }
        problems.push(`${name}: the route publishes it, the SDL does not`);
        continue;
      }
      problems.push(
        `${name}: the SDL declares ${found}, the route gives ${type}`,
      );
    }
    for (const [name, type] of declaredByName) {
      if (derivedByName.has(name)) continue;
      problems.push(
        `${name}: ${type} in the SDL, and nothing the route publishes derives to it`,
      );
    }
    if (problems.length === 0) {
      exact += 1;
      continue;
    }
    for (const problem of problems) {
      violations.push(`Query.${binding.field}.${problem}`);
    }
  }

  return {
    exact,
    skipped,
    violations,
    stale: [
      ...missingNetwork.filter((field) => !usedNetwork.has(field)),
      ...Object.keys(DECLARED_ARGUMENT_TYPES).filter(
        (key) => !usedDeclared.has(key),
      ),
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sdl = extractSdl(readFileSync(SDL_PATH, "utf8"));
  if (!sdl) {
    console.error(
      `graphql-query-arguments: no SDL template literal in ${SDL_PATH}`,
    );
    process.exit(1);
  }
  const report = checkQueryArguments(
    sdl,
    JSON.parse(readFileSync(OPENAPI_PATH, "utf8")) as OpenApiParameters,
  );
  console.log(
    `graphql-query-arguments: ${report.exact} field(s) reproduce their route's ` +
      `parameters exactly, ${report.skipped} skipped, ` +
      `${DECLARED_MISSING_NETWORK.length} missing \`network\` (#10394).`,
  );
  if (report.violations.length) {
    console.error(
      `\n${report.violations.length} argument(s) the routes do not derive:`,
    );
    for (const line of report.violations.sort()) console.error(`  - ${line}`);
    console.error(
      "\nFix the SDL to match the route, or declare the spelling in " +
        "DECLARED_ARGUMENT_TYPES with the reason.",
    );
  }
  if (report.stale.length) {
    console.error(
      `\n${report.stale.length} stale declaration(s) -- the difference is gone, delete the entry:`,
    );
    for (const key of report.stale) console.error(`  - ${key}`);
  }
  if (report.violations.length || report.stale.length) process.exit(1);
  console.log("graphql-query-arguments: OK");
}
