// How far is the generated schema from the published one? (#10214)
//
// Everything the generator reads is now declared or derived: the component
// types come from Zod (`emitTypes`), the published names from
// `PUBLISHED_TYPE_NAMES`, each Query field's return type and description from
// `QUERY_BINDINGS`, and its arguments from the route it mirrors
// (`deriveQueryArguments`). What is left is to assemble them and see what still
// differs from `src/graphql-sdl.ts`.
//
// A REPORT, not a gate, and deliberately so. The remaining differences are
// things to FIX, and a gate that failed on them would just be red until they
// are all closed. What a report gives instead is one number per class that can
// be watched down to zero, at which point the cutover is a no-op rather than a
// leap.
//
// EVERY NUMBER IT PRINTS IS DERIVED, including the count of what is left. It
// used to name its own remainder in prose -- "24 fields the SDL under-types as
// JSON, 4 types whose shape lives only in resolver code (#10409)" -- and both
// halves rotted: the under-typings are 50 (the scalar-identity check reached
// projections and paginated views in #10409, counting debt that had never been
// counted), and `RESOLVER_BUILT_TYPES` is EMPTY, because those four now have
// schemas in `schemas-src/graphql/graphql-only.ts`. A report that is the
// answer to "how far is the cutover" cannot carry a hand-written number that
// disagrees with the checker it points at, so it asks the checker.
//
// SEMANTIC, not byte-for-byte. Argument ORDER is not significant in GraphQL and
// the derived order is the route's, so comparing text would report ~31 fields
// as different that are identical to any client.
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { parse, print } from "graphql";
import type { FieldDefinitionNode, ObjectTypeDefinitionNode } from "graphql";
import { emitTypes } from "../schemas-src/graphql/emit.ts";
import {
  ALIASED_TYPE_NAMES,
  PROJECTED_TYPES,
  PUBLISHED_TYPE_NAMES,
  QUERY_BINDINGS,
  RESOLVER_BUILT_TYPES,
} from "../schemas-src/graphql/published-names.ts";
import {
  deriveQueryArguments,
  type OpenApiParameters,
} from "../schemas-src/graphql/query-arguments.ts";
import {
  checkComponentParity,
  extractSdl,
  type OpenApiDocument,
} from "./validate-graphql-component-parity.ts";

const SDL_PATH = "src/graphql-sdl.ts";
const OPENAPI_PATH = "public/metagraph/openapi.json";

export interface EquivalenceReport {
  /** Types the published SDL declares. */
  publishedTypes: number;
  /** Of those, how many the generator can already emit under that name. */
  generatedTypes: number;
  /** Published types with no generator source -- #10409 and the un-named. */
  missingTypes: string[];
  /** Query fields whose return type the registry reproduces exactly. */
  queryFieldsExact: number;
  /** Query fields whose derived arguments match the published ones exactly. */
  queryArgumentsExact: number;
  /** Every remaining difference, one line each. */
  differences: string[];
}

/** `Foo`, `[Foo!]!` -> `Foo`. */
function bare(type: string): string {
  return type.replace(/[![\]]/g, "");
}

export function reportEquivalence(
  sdl: string,
  openapi: OpenApiParameters,
): EquivalenceReport {
  const sdlTypes = new Map<string, ObjectTypeDefinitionNode>();
  for (const def of parse(sdl).definitions) {
    if (def.kind === "ObjectTypeDefinition") sdlTypes.set(def.name.value, def);
  }
  const { types: emitted } = emitTypes();

  /** Published name -> the component(s) the emitter would build it from. */
  const generatedByName = new Map<string, string>();
  for (const component of emitted.keys()) {
    const published = PUBLISHED_TYPE_NAMES[component] ?? component;
    if (!generatedByName.has(published))
      generatedByName.set(published, component);
    const alias = ALIASED_TYPE_NAMES[component];
    if (alias && !generatedByName.has(alias))
      generatedByName.set(alias, component);
  }

  const differences: string[] = [];
  const missingTypes: string[] = [];
  let generatedTypes = 0;
  for (const name of sdlTypes.keys()) {
    if (name === "Query" || name === "Subscription") continue;
    if (generatedByName.has(name)) {
      generatedTypes += 1;
      continue;
    }
    // A projection or a resolver-built type: declared, but not something the
    // component emitter produces under this name.
    if (PROJECTED_TYPES[name] || RESOLVER_BUILT_TYPES.includes(name)) {
      generatedTypes += 1;
      continue;
    }
    missingTypes.push(name);
  }

  // ── the Query root ───────────────────────────────────────────────────────
  const publishedQuery = new Map<string, FieldDefinitionNode>(
    (sdlTypes.get("Query")?.fields ?? []).map((field) => [
      field.name.value,
      field,
    ]),
  );
  const returnsProjectable = (returns: string): boolean => {
    const named = sdlTypes.get(bare(returns));
    if (!named) return false;
    return !(named.fields ?? []).some((field) =>
      print(field.type).includes("JSON"),
    );
  };

  let queryFieldsExact = 0;
  let queryArgumentsExact = 0;
  for (const binding of QUERY_BINDINGS) {
    const field = publishedQuery.get(binding.field);
    if (!field) {
      differences.push(
        `Query.${binding.field} -- QUERY_BINDINGS declares it, the SDL does not`,
      );
      continue;
    }
    if (print(field.type) === binding.returns) queryFieldsExact += 1;
    else
      differences.push(
        `Query.${binding.field} returns ${print(field.type)}, the registry says ${binding.returns}`,
      );

    if (!binding.route || !openapi.paths?.[binding.route]) continue;
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
    const published = (field.arguments ?? []).map((argument) => ({
      name: argument.name.value,
      type: print(argument.type),
    }));
    const key = (list: { name: string; type: string }[]) =>
      list
        .map((a) => `${a.name}:${a.type}`)
        .sort()
        .join(" ");
    if (key(published) === key(derived)) queryArgumentsExact += 1;
  }

  return {
    // The two ROOTS are excluded: `Query` is assembled from QUERY_BINDINGS
    // rather than emitted as a component, and `Subscription` is #10409.
    publishedTypes: sdlTypes.size - (sdlTypes.has("Subscription") ? 2 : 1),
    generatedTypes,
    missingTypes: missingTypes.sort(),
    queryFieldsExact,
    queryArgumentsExact,
    differences,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sdl = extractSdl(readFileSync(SDL_PATH, "utf8"));
  if (!sdl) {
    console.error(`sdl-equivalence: no SDL template literal in ${SDL_PATH}`);
    process.exit(1);
  }
  const openapi = JSON.parse(readFileSync(OPENAPI_PATH, "utf8")) as unknown;
  const report = reportEquivalence(sdl, openapi as OpenApiParameters);
  console.log(
    `sdl-equivalence: ${report.generatedTypes} of ${report.publishedTypes} published object ` +
      `type(s) have a generator source (the Query/Subscription roots excluded); ` +
      `${report.queryFieldsExact} of ${QUERY_BINDINGS.length} Query return types and ` +
      `${report.queryArgumentsExact} argument list(s) reproduce exactly.`,
  );
  if (!report.missingTypes.length && !report.differences.length) {
    // Asked, not restated. `undertyped` is the same number
    // `validate:graphql-component-parity` prints, so the two can never
    // disagree the way the prose here used to.
    const { undertyped } = checkComponentParity(
      sdl,
      openapi as OpenApiDocument,
    );
    console.log(
      "\nEvery published type, every Query return type and every derivable\n" +
        "argument list has a source. What remains before the SDL can be\n" +
        "GENERATED rather than compared is not coverage but content: " +
        `${undertyped} field(s)\n` +
        "the SDL publishes as opaque `JSON` where the component has a shape.\n" +
        "Closing one means publishing a named type; the count is the distance.",
    );
  }
  if (report.missingTypes.length) {
    console.log(
      `\n${report.missingTypes.length} published type(s) nothing generates yet:`,
    );
    for (const name of report.missingTypes) console.log(`  - ${name}`);
  }
  if (report.differences.length) {
    console.log(`\n${report.differences.length} difference(s):`);
    for (const line of report.differences.sort()) console.log(`  - ${line}`);
  }
}
