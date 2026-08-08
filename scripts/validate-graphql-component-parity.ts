// Fail when a GraphQL type that mirrors a Zod component omits a field that
// component publishes (#10214).
//
// WHAT THIS CATCHES THAT validate:graphql-route-parity DOES NOT. That gate
// walks the fields the SDL *declares* and checks each against the route, so it
// catches a field whose TYPE drifted. It cannot see a field the SDL never
// declared at all -- a one-directional check over a hand-written mirror. The
// SDL is 5,146 lines nothing generates, so "the route grew a field and the SDL
// did not" was invisible by construction.
//
// What that cost, measured when this gate was written: 36 mirror types omitted
// 88 fields their component publishes. Among them the caveats that make a
// number safe to read -- `AccountPositions.degraded`, so GraphQL served
// `position_count: 0` with no way to learn the positions were unpriceable;
// `NominatorList.concentration_complete` behind `nominator_gini`;
// `RuntimeVersionHistory.coverage_complete`; `DeregistrationDerivation.
// is_lower_bound`. That is the confident-zeros failure (#9803) reached through
// a door REST and MCP had already closed.
//
// HOW THE PAIRS ARE FOUND -- derived, not declared. Each Query field carries a
// `Mirrors GET /api/v1/...` annotation; the route's OpenAPI response names the
// component its `data` refs. That seeds SDL-type <-> component pairs, which
// then propagate through same-named fields: if `SelfHealth` pairs with
// `SelfHealthArtifact` and both have a `components` field, their element types
// pair too. So the mapping between the two name systems is COMPUTED, and a new
// type is covered the moment it is reachable -- there is no map to update.
import { readFileSync } from "node:fs";
import { parse } from "graphql";
import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from "graphql";
import type {
  GraphQLOutputType,
  ObjectTypeDefinitionNode,
  TypeNode,
} from "graphql";
import { emitTypes } from "../schemas-src/graphql/emit.ts";

/** Only the sliver of the OpenAPI document this gate reads. */
export interface OpenApiDocument {
  paths?: Record<
    string,
    {
      get?: {
        responses?: Record<
          string,
          {
            content?: Record<
              string,
              {
                schema?: {
                  allOf?: { properties?: { data?: { $ref?: string } } }[];
                };
              }
            >;
          }
        >;
      };
    }
  >;
}

const SDL_PATH = "src/graphql-sdl.ts";
const OPENAPI_PATH = "public/metagraph/openapi.json";

/**
 * Fields a resolver introduces when it paginates a component into a list view.
 *
 * A type carrying two or more of these that its component does NOT have is a
 * projection the resolver builds, not a mirror -- `EndpointList {items, total,
 * next_cursor}` over `EndpointsArtifact {endpoints, summary, ...}`. Comparing
 * those field-for-field would compare a view to its source.
 */
const PAGINATION_FIELDS = new Set([
  "items",
  "total",
  "returned",
  "limit",
  "cursor",
  "next_cursor",
  "sort",
  "order",
  "offset",
]);

/**
 * Component fields a mirror type may omit, each with the reason.
 *
 * The list must SHRINK: an entry that no longer names a live omission fails
 * this script, so a fix cannot leave a stale exemption behind -- the same
 * idiom the MCP input-parity and tier-cascade gates use.
 */
const DECLARED: Record<string, string> = {};

export interface ParityReport {
  violations: string[];
  stale: string[];
  comparedTypes: number;
  comparedFields: number;
  projections: string[];
}

/** Pull the SDL out of the TypeScript template literal that holds it. */
export function extractSdl(source: string): string | null {
  const match = /export const SDL = \/\* GraphQL \*\/ `([\s\S]*?)`;\s*$/m.exec(
    source,
  );
  return match ? match[1] : null;
}

function sdlTypeName(node: TypeNode): string {
  let current = node;
  while (current.kind !== "NamedType") current = current.type;
  return current.name.value;
}

function generatedTypeName(type: GraphQLOutputType): string | null {
  let current: unknown = type;
  while (current instanceof GraphQLNonNull || current instanceof GraphQLList)
    current = current.ofType;
  return current instanceof GraphQLObjectType ? current.name : null;
}

/**
 * Compare a GraphQL SDL against the Zod components its types mirror.
 *
 * Takes the SDL text and the OpenAPI document rather than reading them, so a
 * test can drive it with a MUTATED schema and prove the gate actually fails.
 * A gate only ever run against a passing tree proves nothing.
 */
export function checkComponentParity(
  sdl: string,
  openapi: OpenApiDocument,
  declared: Record<string, string> = DECLARED,
): ParityReport {
  const sdlTypes = new Map<string, ObjectTypeDefinitionNode>();
  for (const def of parse(sdl).definitions) {
    if (def.kind === "ObjectTypeDefinition") sdlTypes.set(def.name.value, def);
  }
  const { types: generated } = emitTypes();

  /** The component a route's `data` property refs. */
  const dataComponent = (route: string): string | null => {
    const schema =
      openapi.paths?.[route]?.get?.responses?.["200"]?.content?.[
        "application/json"
      ]?.schema;
    for (const part of schema?.allOf ?? []) {
      const ref = part?.properties?.data?.$ref;
      if (typeof ref === "string")
        return ref.replace("#/components/schemas/", "");
    }
    return null;
  };

  // ── seed from the Query bindings, then propagate through matching fields ──
  const queue: [string, string][] = [];
  for (const field of sdlTypes.get("Query")?.fields ?? []) {
    const mirrors = /Mirrors GET (\/api\/v1\/[^\s.]+)/.exec(
      field.description?.value ?? "",
    );
    if (!mirrors) continue;
    const component = dataComponent(mirrors[1].replace(/\.$/, ""));
    if (component) queue.push([sdlTypeName(field.type), component]);
  }

  /** SDL type name -> every component it mirrors (a shared type mirrors many). */
  const paired = new Map<string, Set<string>>();
  while (queue.length) {
    const [sdlName, componentName] = queue.shift()!;
    const sdlType = sdlTypes.get(sdlName);
    const genType = generated.get(componentName);
    if (!sdlType || !genType) continue;
    const seen = paired.get(sdlName);
    if (seen?.has(componentName)) continue;
    if (seen) seen.add(componentName);
    else paired.set(sdlName, new Set([componentName]));
    const genFields = genType.getFields();
    for (const field of sdlType.fields ?? []) {
      const child = genFields[field.name.value];
      if (!child) continue;
      const childSdl = sdlTypeName(field.type);
      const childGen = generatedTypeName(child.type);
      if (childGen && sdlTypes.has(childSdl) && generated.has(childGen)) {
        queue.push([childSdl, childGen]);
      }
    }
  }

  // ── compare each mirror against every component it mirrors ───────────────
  const violations: string[] = [];
  const projections: string[] = [];
  const matched = new Set<string>();
  let comparedTypes = 0;
  let comparedFields = 0;

  for (const [sdlName, components] of paired) {
    const sdlFields = new Set(
      (sdlTypes.get(sdlName)!.fields ?? []).map((f) => f.name.value),
    );
    for (const componentName of components) {
      const genNames = Object.keys(generated.get(componentName)!.getFields());
      const addedPagination = [...sdlFields].filter(
        (f) => PAGINATION_FIELDS.has(f) && !genNames.includes(f),
      );
      if (addedPagination.length >= 2) {
        projections.push(`${sdlName} <- ${componentName}`);
        continue;
      }
      comparedTypes += 1;
      for (const name of genNames) {
        comparedFields += 1;
        if (sdlFields.has(name)) continue;
        const key = `${sdlName}.${name}`;
        if (declared[key]) {
          matched.add(key);
          continue;
        }
        violations.push(
          `${key} -- ${componentName} publishes it, the SDL does not declare it`,
        );
      }
    }
  }

  return {
    violations,
    stale: Object.keys(declared).filter((key) => !matched.has(key)),
    comparedTypes,
    comparedFields,
    projections,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sdl = extractSdl(readFileSync(SDL_PATH, "utf8"));
  if (!sdl) {
    console.error(
      `graphql-component-parity: no SDL template literal in ${SDL_PATH}`,
    );
    process.exit(1);
  }
  const report = checkComponentParity(
    sdl,
    JSON.parse(readFileSync(OPENAPI_PATH, "utf8")) as OpenApiDocument,
  );
  console.log(
    `graphql-component-parity: ${report.comparedTypes} mirror type(s), ` +
      `${report.comparedFields} field(s) compared, ` +
      `${report.projections.length} resolver-built projection(s) skipped.`,
  );
  if (report.violations.length) {
    console.error(
      `\n${report.violations.length} field(s) a component publishes that GraphQL does not expose:`,
    );
    for (const line of report.violations.sort()) console.error(`  - ${line}`);
  }
  if (report.stale.length) {
    console.error(
      `\n${report.stale.length} stale DECLARED entr(y/ies) -- the omission is gone, delete the entry:`,
    );
    for (const key of report.stale) console.error(`  - ${key}`);
  }
  if (report.violations.length || report.stale.length) process.exit(1);
  console.log("graphql-component-parity: OK");
}
