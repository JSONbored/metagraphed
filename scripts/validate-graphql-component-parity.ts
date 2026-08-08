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
import type { GraphQLOutputType, ObjectTypeDefinitionNode, TypeNode } from "graphql";
import { emitTypes } from "../schemas-src/graphql/emit.ts";

type Json = Record<string, any>;

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

const openapi = JSON.parse(readFileSync(OPENAPI_PATH, "utf8")) as Json;

const literal = /export const SDL = \/\* GraphQL \*\/ `([\s\S]*?)`;\s*$/m.exec(
  readFileSync(SDL_PATH, "utf8"),
);
if (!literal) {
  console.error(`graphql-component-parity: no SDL template literal in ${SDL_PATH}`);
  process.exit(1);
}

const sdlTypes = new Map<string, ObjectTypeDefinitionNode>();
for (const def of parse(literal[1]).definitions) {
  if (def.kind === "ObjectTypeDefinition") sdlTypes.set(def.name.value, def);
}

const { types: generated } = emitTypes();

function sdlTypeName(node: TypeNode): string {
  let current = node;
  while (current.kind !== "NamedType") current = current.type;
  return current.name.value;
}

function generatedTypeName(type: GraphQLOutputType): string | null {
  let current: unknown = type;
  while (current instanceof GraphQLNonNull || current instanceof GraphQLList) current = current.ofType;
  return current instanceof GraphQLObjectType ? current.name : null;
}

/** The component a route's `data` property refs. */
function dataComponent(route: string): string | null {
  const schema = openapi.paths?.[route]?.get?.responses?.["200"]?.content?.["application/json"]?.schema;
  for (const part of schema?.allOf ?? []) {
    const ref = part?.properties?.data?.$ref;
    if (typeof ref === "string") return ref.replace("#/components/schemas/", "");
  }
  return null;
}

// ── seed from the Query bindings, then propagate through matching fields ────
const pairs: [string, string][] = [];
for (const field of sdlTypes.get("Query")?.fields ?? []) {
  const mirrors = /Mirrors GET (\/api\/v1\/[^\s.]+)/.exec(field.description?.value ?? "");
  if (!mirrors) continue;
  const component = dataComponent(mirrors[1].replace(/\.$/, ""));
  if (component) pairs.push([sdlTypeName(field.type), component]);
}

/** SDL type name -> every component it mirrors (a shared type mirrors many). */
const paired = new Map<string, Set<string>>();
const queue = [...pairs];
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

// ── compare each mirror against every component it mirrors ─────────────────
const violations: string[] = [];
const projections: string[] = [];
const matched = new Set<string>();
let comparedTypes = 0;
let comparedFields = 0;

for (const [sdlName, components] of paired) {
  const sdlType = sdlTypes.get(sdlName)!;
  const sdlFields = new Set((sdlType.fields ?? []).map((f) => f.name.value));
  for (const componentName of components) {
    const genFields = generated.get(componentName)!.getFields();
    const genNames = Object.keys(genFields);
    const addedPagination = [...sdlFields].filter((f) => PAGINATION_FIELDS.has(f) && !genNames.includes(f));
    if (addedPagination.length >= 2) {
      projections.push(`${sdlName} <- ${componentName}`);
      continue;
    }
    comparedTypes += 1;
    for (const name of genNames) {
      comparedFields += 1;
      if (sdlFields.has(name)) continue;
      const key = `${sdlName}.${name}`;
      if (DECLARED[key]) {
        matched.add(key);
        continue;
      }
      violations.push(`${key} -- ${componentName} publishes it, the SDL does not declare it`);
    }
  }
}

const stale = Object.keys(DECLARED).filter((key) => !matched.has(key));

console.log(
  `graphql-component-parity: ${comparedTypes} mirror type(s), ${comparedFields} field(s) compared, ` +
    `${projections.length} resolver-built projection(s) skipped.`,
);

if (violations.length) {
  console.error(`\n${violations.length} field(s) a component publishes that GraphQL does not expose:`);
  for (const line of violations.sort()) console.error(`  - ${line}`);
}
if (stale.length) {
  console.error(`\n${stale.length} stale DECLARED entr(y/ies) -- the omission is gone, delete the entry:`);
  for (const key of stale) console.error(`  - ${key}`);
}
if (violations.length || stale.length) process.exit(1);
console.log("graphql-component-parity: OK");
