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
import ts from "typescript";
import { parse, print } from "graphql";
import type { ObjectTypeDefinitionNode } from "graphql";
import { QUERY_BINDINGS } from "../schemas-src/graphql/published-names.ts";
import {
  ARGUMENT_CODECS,
  DECLARED_MISSING_NETWORK,
} from "../schemas-src/graphql/argument-divergences.ts";
import {
  FIELD_ARGUMENT_ROUTES,
  SUBSCRIPTION_BINDINGS,
} from "../schemas-src/graphql/published-names.ts";

export { DECLARED_MISSING_NETWORK };

/**
 * Re-read the fact every `DECLARED_MISSING_NETWORK` entry cites (#10870).
 *
 * Each entry's reason is a claim about a RESOLVER -- "it destructures `{ ref }`
 * and nothing else, so publishing `network` would let a caller ask for testnet
 * and silently receive mainnet" -- and a reason nothing re-reads expires
 * silently: #10863 caught three expired `fields` justifications whose cited
 * JSON member had left the projection, and this list is one resolver edit away
 * from the same fate. So the claim is checked on every run, over the AST
 * rather than by regex (a source-regex gate goes blind the moment a formatter
 * rewraps what it matched).
 *
 * The rule per entry: the named `rootValue` resolver's first parameter must be
 * an object destructuring that does NOT bind `network`. A resolver that starts
 * binding it has outgrown the entry -- delete it and publish the argument. One
 * that stops destructuring (an identifier parameter can read anything) makes
 * the cited fact unverifiable, which is the same failure: rewrite the reason
 * into something this check can read, or forward the argument.
 */
export function expiredMissingNetworkReasons(
  resolverSource: string,
  missingNetwork: readonly string[] = DECLARED_MISSING_NETWORK,
): string[] {
  const source = ts.createSourceFile(
    "src/graphql.ts",
    resolverSource,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  let root: ts.ObjectLiteralExpression | null = null;
  const findRoot = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "rootValue" &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      root = node.initializer;
      return;
    }
    ts.forEachChild(node, findRoot);
  };
  findRoot(source);
  if (!root) {
    // No rootValue at all: every entry's cited fact is unverifiable.
    return [...missingNetwork];
  }
  const expired: string[] = [];
  for (const field of missingNetwork) {
    const member = (root as ts.ObjectLiteralExpression).properties.find(
      (property) =>
        property.name !== undefined &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === field,
    );
    const fn =
      member && ts.isMethodDeclaration(member)
        ? member
        : member &&
            ts.isPropertyAssignment(member) &&
            (ts.isArrowFunction(member.initializer) ||
              ts.isFunctionExpression(member.initializer))
          ? member.initializer
          : null;
    if (!fn) {
      expired.push(field);
      continue;
    }
    const first = fn.parameters[0];
    // No parameter reads nothing; a destructure is checkable binding by
    // binding; an identifier parameter can reach anything, so the cited
    // "reads no network" is no longer a fact this gate can verify.
    if (!first) continue;
    if (!ts.isObjectBindingPattern(first.name)) {
      expired.push(field);
      continue;
    }
    const bindsNetwork = first.name.elements.some(
      (element) =>
        ts.isBindingElement(element) &&
        ((ts.isIdentifier(element.name) && element.name.text === "network") ||
          (element.propertyName !== undefined &&
            ts.isIdentifier(element.propertyName) &&
            element.propertyName.text === "network")),
    );
    if (bindsNetwork) expired.push(field);
  }
  return expired;
}
import {
  deriveQueryArguments,
  fieldsArgumentApplies,
  type OpenApiParameters,
  type QueryArgument,
} from "../schemas-src/graphql/query-arguments.ts";
import { extractSdl } from "./validate-graphql-component-parity.ts";

const SDL_PATH = "generated/graphql/schema.ts";
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
 * THE LIST ONLY SHRINKS -- an entry whose field now takes `network` fails --
 * and it is EMPTY as of #10394: all twenty forward the argument to their tier
 * read AND to the cold-tier fallback below it, so the ladder cannot answer
 * mainnet under a testnet label. A new entry here is a field that mirrors a
 * route with a `/{network}/` twin and cannot reach it.
 */

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
  // EVERY type, not just Query: a root field is keyed by its own name and a
  // nested one by `Type.field`, which is how `FIELD_ARGUMENT_ROUTES` names it.
  // Reading only Query's fields left the Subscription root and the two nested
  // filtered lists with nothing to compare against, so their declarations read
  // as stale and their arguments as absent (#10772).
  const declaredArguments = new Map<string, QueryArgument[]>();
  for (const [typeName, type] of types) {
    for (const field of type.fields ?? []) {
      const args = (field.arguments ?? []).map((argument) => ({
        name: argument.name.value,
        type: print(argument.type),
      }));
      const key =
        typeName === "Query" || typeName === "Subscription"
          ? field.name.value
          : `${typeName}.${field.name.value}`;
      declaredArguments.set(key, args);
    }
  }

  /**
   * A selection set already projects any named object type, so `fields` is
   * published only on an opaque `JSON` return. The rule lives with the
   * derivation (`fieldsArgumentApplies`) so this gate cannot encode it
   * differently from the generator it checks (#10214).
   */
  const returnsProjectable = (returns: string): boolean =>
    !fieldsArgumentApplies(returns);

  const violations: string[] = [];
  const usedNetwork = new Set<string>();
  const usedDeclared = new Set<string>();
  let exact = 0;
  let skipped = 0;

  // BOTH roots plus the nested fields that take arguments. Walking
  // QUERY_BINDINGS alone left the Subscription root and `Subnet.surfaces` /
  // `Subnet.endpoints` outside every argument check there is -- which is how
  // the generated schema came to publish them bare (#10772).
  const surface = [
    ...QUERY_BINDINGS,
    ...SUBSCRIPTION_BINDINGS,
    ...Object.entries(FIELD_ARGUMENT_ROUTES).map(([field, route]) => ({
      field,
      route,
      returns: "",
      description: "",
    })),
  ];
  for (const binding of surface) {
    const declared = declaredArguments.get(binding.field);
    // A field with no route still publishes what it DECLARES, so it is only
    // skipped when the SDL has nothing to compare against.
    if (!declared) {
      skipped += 1;
      continue;
    }
    const twin = binding.route?.replace("/api/v1/", "/api/v1/{network}/");
    const derived = deriveQueryArguments(
      binding.field,
      binding.route,
      openapi,
      {
        hasNetworkTwin: Boolean(twin && openapi.paths?.[twin]),
        returnsProjectable: binding.returns
          ? returnsProjectable(binding.returns)
          : true,
        // A key with a dot is a NESTED field; its parent supplies the path.
        nested: binding.field.includes("."),
      },
      // Empty, so a live `DECLARED_MISSING_NETWORK` entry still shows up as a
      // difference here and cannot read as stale.
      [],
    );
    for (const argument of derived) {
      if (ARGUMENT_CODECS[`${binding.field}.${argument.name}`]) {
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
      ...Object.keys(ARGUMENT_CODECS).filter((key) => !usedDeclared.has(key)),
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
  const expired = expiredMissingNetworkReasons(
    readFileSync("src/graphql.ts", "utf8"),
  );
  console.log(
    `graphql-query-arguments: ${report.exact} field(s) reproduce their route's ` +
      `parameters exactly, ${report.skipped} skipped, ` +
      `${DECLARED_MISSING_NETWORK.length} missing \`network\` ` +
      `(reason re-checked, #10870).`,
  );
  if (expired.length) {
    console.error(
      `\n${expired.length} DECLARED_MISSING_NETWORK reason(s) no longer hold: ` +
        `the resolver the entry cites now binds \`network\`, or stopped ` +
        `destructuring so the cited fact cannot be read. Publish the argument ` +
        `and delete the entry, or restore a checkable reason:`,
    );
    for (const field of expired) console.error(`  - ${field}`);
  }
  if (report.violations.length) {
    console.error(
      `\n${report.violations.length} argument(s) the routes do not derive:`,
    );
    for (const line of report.violations.sort()) console.error(`  - ${line}`);
    console.error(
      "\nFix the SDL to match the route, or declare the spelling in " +
        "ARGUMENT_CODECS with the reason.",
    );
  }
  if (report.stale.length) {
    console.error(
      `\n${report.stale.length} stale declaration(s) -- the difference is gone, delete the entry:`,
    );
    for (const key of report.stale) console.error(`  - ${key}`);
  }
  if (report.violations.length || report.stale.length || expired.length) {
    process.exit(1);
  }
  console.log("graphql-query-arguments: OK");
}
