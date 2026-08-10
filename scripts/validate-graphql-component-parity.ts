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
import { PROJECTED_TYPES } from "../schemas-src/graphql/published-names.ts";

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
  /** Declared projections checked -- see `PROJECTED_TYPES` (#10214). */
  projectedTypes: number;
  projectedFields: number;
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

/**
 * Does the SDL promise this field is always present?
 *
 * A LIST is unwrapped first: `[Thing!]!` and `[Thing!]` differ in whether the
 * LIST can be null, which is what a caller sees, and that is the promise being
 * compared. The item's own nullability is the list's business.
 */
function sdlIsNonNull(node: TypeNode): boolean {
  return node.kind === "NonNullType";
}

function generatedIsNonNull(type: GraphQLOutputType): boolean {
  return type instanceof GraphQLNonNull;
}

/** The scalar a field names, or null when it names an object/list/enum. */
function sdlScalarName(node: TypeNode): string | null {
  let current = node;
  while (current.kind !== "NamedType") {
    if (current.kind === "ListType") return null;
    current = current.type;
  }
  return SCALARS.has(current.name.value) ? current.name.value : null;
}

function generatedScalarName(type: GraphQLOutputType): string | null {
  let current: unknown = type;
  while (current instanceof GraphQLNonNull) current = current.ofType;
  if (current instanceof GraphQLList) return null;
  const name = (current as { name?: string })?.name;
  return name && SCALARS.has(name) ? name : null;
}

const SCALARS = new Set(["Int", "Float", "String", "Boolean", "ID"]);

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
  let projectedTypes = 0;
  let projectedFields = 0;

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
      // The SDL field nodes, for the two things a name comparison cannot see.
      const sdlNodes = new Map(
        (sdlTypes.get(sdlName)!.fields ?? []).map((f) => [f.name.value, f]),
      );
      const genFieldMap = generated.get(componentName)!.getFields();
      for (const name of genNames) {
        const sdlNode = sdlNodes.get(name);
        const genField = genFieldMap[name];
        if (sdlNode && genField) {
          // A field the SDL promises is always present, against a component
          // that says it may be absent. graphql-js cannot hold the null: it
          // raises and PROPAGATES, so one nullable value nulls the whole
          // surrounding list. `SelfHealthLane.detail` did exactly that on
          // every `self_health` request, and this gate compared only names
          // (#10215).
          if (
            sdlIsNonNull(sdlNode.type) &&
            !generatedIsNonNull(genField.type) &&
            !declared[`${sdlName}.${name}`]
          ) {
            violations.push(
              `${sdlName}.${name} -- the SDL declares it non-null, ` +
                `${componentName} says it is nullable`,
            );
          }
          // NARROWING only. `Int` where the component emits `Float` loses
          // values -- and GraphQL's Int is 32-bit, so an epoch-millisecond
          // value declared Int errors on EVERY real value, which is what
          // `EndpointIncidentWindow.started_at` did on every request since the
          // surface shipped.
          //
          // The other direction is a WIDENING and is left alone: a Float
          // accepts every integer, and 26 fields declare it deliberately for a
          // computed value (`mean_ms`, `stability_score`, the percentiles)
          // whose component happens to hold whole numbers today. Failing those
          // would be 26 entries of noise around the one shape that breaks.
          const sdlScalar = sdlScalarName(sdlNode.type);
          const genScalar = generatedScalarName(genField.type);
          if (
            sdlScalar === "Int" &&
            genScalar === "Float" &&
            !declared[`${sdlName}.${name}`]
          ) {
            violations.push(
              `${sdlName}.${name} -- the SDL declares ${sdlScalar}, ` +
                `${componentName} emits ${genScalar}`,
            );
          }
        }
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

  // ── the declared projections ─────────────────────────────────────────────
  //
  // A projection PICKS a subset of its component, so the mirror rule "every
  // component field must appear" is not its rule. Every rule about the fields
  // it does publish still is -- and until #10214 nothing applied them, because
  // the traversal above only reaches a type through a `Mirrors GET` annotation
  // and a resolver-built type has none. All fifteen were reached by zero
  // gates.
  for (const [sdlName, projection] of Object.entries(PROJECTED_TYPES)) {
    const sdlType = sdlTypes.get(sdlName);
    const genType = generated.get(projection.component);
    if (!sdlType) {
      violations.push(
        `${sdlName} -- PROJECTED_TYPES declares it, the SDL has no such type`,
      );
      continue;
    }
    if (!genType) {
      violations.push(
        `${sdlName} -- projects ${projection.component}, which no component emits`,
      );
      continue;
    }
    projectedTypes += 1;
    const genFields = genType.getFields();
    const added = new Set(projection.added);
    const usedAdded = new Set<string>();
    for (const field of sdlType.fields ?? []) {
      const name = field.name.value;
      const genField = genFields[name];
      if (!genField) {
        if (added.has(name)) usedAdded.add(name);
        else
          violations.push(
            `${sdlName}.${name} -- neither ${projection.component} nor the ` +
              `declared \`added\` list supplies it`,
          );
        continue;
      }
      projectedFields += 1;
      // Same two checks the mirrors get. A projection publishing a non-null
      // over a nullable component field is the response-shaped outage: one
      // null and graphql-js nulls the whole surrounding object.
      if (sdlIsNonNull(field.type) && !generatedIsNonNull(genField.type)) {
        violations.push(
          `${sdlName}.${name} -- the SDL declares it non-null, ` +
            `${projection.component} says it is nullable`,
        );
      }
      if (
        sdlScalarName(field.type) === "Int" &&
        generatedScalarName(genField.type) === "Float"
      ) {
        violations.push(
          `${sdlName}.${name} -- the SDL declares Int, ` +
            `${projection.component} emits Float`,
        );
      }
    }
    for (const name of added) {
      if (!usedAdded.has(name)) {
        violations.push(
          `${sdlName}.${name} -- declared as resolver-added, but the SDL ` +
            `no longer publishes it (or ${projection.component} now supplies it)`,
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
    projectedTypes,
    projectedFields,
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
      `${report.projectedTypes} declared projection(s) (${report.projectedFields} field(s)), ` +
      `${report.projections.length} pagination view(s) skipped.`,
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
