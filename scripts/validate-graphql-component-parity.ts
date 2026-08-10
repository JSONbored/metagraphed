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
// WHAT ELSE IT COMPARES, once a pair is found: the field must be present, its
// nullability must not over-promise, and -- since #10377's blind spot -- its
// TYPE must be the same type. That last one was missing, and it is what let
// the enum->JSON class hide: `String` against `JSON` read as agreement, so an
// emitter change that retyped 348 fields as `JSON` would have passed every
// gate in the repo. A `Float` over an `Int` is still allowed, in both checks,
// because a widening loses nothing.
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
import {
  ALIASED_TYPE_NAMES,
  PROJECTED_TYPES,
  PUBLISHED_TYPE_NAMES,
} from "../schemas-src/graphql/published-names.ts";

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
export const DECLARED: Record<string, string> = {
  "EmissionGateChanges.changes":
    "the component is a three-arm union (param/subnet/flow changes, each " +
    "carrying only its own fields) and the emitter answers JSON for a " +
    "heterogeneous union, correctly. The SDL flattens the three into one " +
    "`EmissionGateChange` the resolver builds -- a real type over an honest " +
    "JSON, which is the safe direction and more useful than the blob.",
  "SubnetTrajectory.deltas":
    "the resolver reshapes on purpose (src/graphql.ts, `deltas: Object.entries" +
    "(data.deltas ?? {})`): the artifact keys deltas by window ('7d'/'30d'), " +
    "which are not valid GraphQL field names, so they become a list carrying " +
    "`window`. The component is a record, so the emitter answers JSON; the " +
    "SDL's list of a named type is the shape the resolver actually returns.",
};

/**
 * Fields the SDL publishes as `JSON` where the component has a real shape,
 * each with the type it becomes.
 *
 * These are UNDER-typings, not faults: `JSON` serializes anything, so nothing
 * breaks at runtime. What a caller loses is the ability to select into the
 * value at all, which is the whole point of the type system -- and it is
 * exactly what the generated SDL fixes, by publishing the shape the component
 * already describes. Closing one means adding a named type to the published
 * schema, so they are recorded here rather than fixed piecemeal.
 *
 * THE LIST ONLY SHRINKS. An entry whose field is no longer under-typed fails,
 * and an under-typed field with no entry fails -- so the count is a live
 * measure of the distance left to the generated schema, and cannot drift up.
 */
const JSON_UNDERTYPED: Record<string, string> = {
  "Adapter.snapshot": "AdapterArtifactSnapshot",
  "BlockExtrinsics.extrinsics": "[BlockExtrinsicsArtifactExtrinsics!]",
  "BuildSummary.artifact_budget_summary":
    "BuildSummaryArtifactArtifactBudgetSummary",
  "BuildSummary.artifacts": "[BuildSummaryArtifactArtifacts!]",
  "BuildSummary.coverage": "CoverageArtifact",
  "ChainConcentrationHistoryPoint.emission": "ChainConcentrationScorecard",
  "ChainConcentrationHistoryPoint.entity_emission":
    "ChainConcentrationScorecard",
  "ChainConcentrationHistoryPoint.entity_stake": "ChainConcentrationScorecard",
  "ChainConcentrationHistoryPoint.stake": "ChainConcentrationScorecard",
  "ChainConcentrationHistoryPoint.validator_stake":
    "ChainConcentrationScorecard",
  "Changelog.artifacts": "ChangelogArtifactArtifacts",
  "Changelog.subnets": "ChangelogArtifactSubnets",
  "Changelog.summary": "ChangelogArtifactSummary",
  "ComparedValidator.coldkey_identity":
    "CompareValidatorsArtifactValidatorsColdkeyIdentity",
  "ComparedValidator.subnet_context":
    "CompareValidatorsArtifactValidatorsSubnetContext",
  "Contracts.artifacts": "[ContractsArtifactArtifacts!]",
  "SubnetConviction.leaderboard": "[SubnetConvictionArtifactLeaderboard!]",
  "SubnetEventSummary.categories": "[SubnetEventSummaryArtifactCategories!]",
  "SubnetEventSummary.event_kinds": "[SubnetEventSummaryArtifactEventKinds!]",
  "SubnetHealthIncidents.surfaces": "[HealthIncidentsArtifactSurfaces!]",
  "SubnetHealthPercentiles.surfaces": "[HealthPercentilesArtifactSurfaces!]",
  "SubnetLease.lease": "SubnetLeaseArtifactLease",
  "SubnetLeaseHistory.lease_events": "[SubnetLeaseHistoryArtifactLeaseEvents!]",
  "SubnetOwnershipHistory.ownership_changes":
    "[SubnetOwnershipHistoryArtifactOwnershipChanges!]",
};

export interface ParityReport {
  violations: string[];
  stale: string[];
  /** Declared JSON under-typings still live -- the distance left to close. */
  undertyped: number;
  comparedTypes: number;
  comparedFields: number;
  projections: string[];
  /** Declared projections checked -- see `PROJECTED_TYPES` (#10214). */
  projectedTypes: number;
  projectedFields: number;
  /** Component fields a projection declares it does not republish (#10404). */
  droppedFields: number;
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

/**
 * What a field is, written the way the SDL writes it: `Foo`, `[Foo!]`.
 *
 * Nullability of the LEAF is deliberately dropped -- that is the separate
 * non-null check above, and folding the two would report one defect twice.
 */
function sdlLeaf(node: TypeNode): { name: string; list: boolean } {
  let current = node;
  let list = false;
  while (current.kind !== "NamedType") {
    if (current.kind === "ListType") list = true;
    current = current.type;
  }
  return { name: current.name.value, list };
}

function generatedLeaf(type: GraphQLOutputType): {
  name: string;
  list: boolean;
} {
  let current: unknown = type;
  let list = false;
  while (current instanceof GraphQLNonNull || current instanceof GraphQLList) {
    if (current instanceof GraphQLList) list = true;
    current = (current as { ofType: unknown }).ofType;
  }
  return { name: (current as { name: string }).name, list };
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
  projectedTypesMap: Readonly<
    Record<string, (typeof PROJECTED_TYPES)[string]>
  > = PROJECTED_TYPES,
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
  const undertypedMatched = new Set<string>();
  let droppedFields = 0;

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
        // A paginated view, not a mirror -- but skipping it wholesale is what
        // hid 158 fields (#10404). It has to be DECLARED, and the projection
        // pass below applies every rule a projection gets.
        const declaredView = projectedTypesMap[sdlName];
        if (declaredView?.component === componentName) {
          projections.push(`${sdlName} <- ${componentName}`);
          continue;
        }
        violations.push(
          `${sdlName} -- pages over ${componentName} and is not declared in ` +
            `PROJECTED_TYPES, so nothing checks the ` +
            `${genNames.filter((n) => !PAGINATION_FIELDS.has(n)).length} field(s) ` +
            `behind its paging`,
        );
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
          // SCALAR IDENTITY -- the blind spot that hid the whole enum->JSON
          // class (#10377). Until this, `String` against `JSON` read as
          // agreement, so 348 fields could be retyped `JSON` and no gate would
          // have said anything.
          //
          // The two name systems are reconciled through PUBLISHED_TYPE_NAMES:
          // the component `SubnetIndexEntry` is published as `Subnet`, and
          // comparing raw ids would report all 300-odd mirrors as mismatched.
          const sdlSide = sdlLeaf(sdlNode.type);
          const genSide = generatedLeaf(genField.type);
          const genPublished =
            PUBLISHED_TYPE_NAMES[genSide.name] ?? genSide.name;
          const key = `${sdlName}.${name}`;
          const sameShape =
            sdlSide.list === genSide.list &&
            (sdlSide.name === genPublished ||
              // The one component published under a second name.
              sdlSide.name === ALIASED_TYPE_NAMES[genSide.name] ||
              // A WIDENING, left alone here for the same reason the narrowing
              // check above states: a Float accepts every integer, and 13
              // fields declare it deliberately for a computed value
              // (`mean_ms`, `stability_score`, the percentiles) whose
              // component happens to hold whole numbers today. The dangerous
              // direction -- Int over Float -- is the check above.
              (sdlSide.name === "Float" && genPublished === "Int"));
          if (!sameShape) {
            const written = (
              side: { name: string; list: boolean },
              n: string,
            ) => (side.list ? `[${n}!]` : n);
            const wanted = written(genSide, genPublished);
            if (sdlSide.name === "JSON") {
              // UNDER-typing: the SDL publishes an opaque blob where the
              // component has a shape. Not a runtime fault -- JSON serializes
              // anything -- but a caller cannot select into it, which is the
              // whole point of the type system. Declared rather than failed,
              // because closing one means publishing a new named type, and
              // that is the generator's job (#10214). The list only SHRINKS:
              // an entry that stops being under-typed fails below.
              if (JSON_UNDERTYPED[key] === wanted) undertypedMatched.add(key);
              else
                violations.push(
                  `${key} -- the SDL declares JSON, ${componentName} emits ` +
                    `${wanted}; declare it in JSON_UNDERTYPED or publish the type`,
                );
            } else if (declared[key]) {
              // Declared, and still real -- record it so the staleness sweep
              // does not report a live exemption as gone.
              matched.add(key);
            } else {
              // OVER-typing, or a plain disagreement. `String` over an object
              // is the dangerous direction: graphql-js' String serializer
              // throws on a non-scalar and nulls the surrounding object.
              violations.push(
                `${key} -- the SDL declares ${written(sdlSide, sdlSide.name)}, ` +
                  `${componentName} emits ${wanted}`,
              );
            }
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
  for (const [sdlName, projection] of Object.entries(projectedTypesMap)) {
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
    // A paginated view RENAMES the component's row array and row count rather
    // than dropping them, so the element type and the count are compared under
    // the published name (#10404).
    const renamed = new Map<string, string>();
    if (projection.itemsFrom) renamed.set("items", projection.itemsFrom);
    if (projection.totalFrom) renamed.set("total", projection.totalFrom);
    for (const [published, source] of renamed) {
      if (!genFields[source]) {
        violations.push(
          `${sdlName}.${published} -- declared as renaming ` +
            `${projection.component}.${source}, which the component does not publish`,
        );
      }
    }
    for (const field of sdlType.fields ?? []) {
      const name = field.name.value;
      const genField = genFields[renamed.get(name) ?? name];
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
    // Both directions on `dropped`, which is what makes the list shrink-only:
    // a name the component does not publish is a typo, and a name the SDL now
    // publishes is a closed gap whose declaration was left behind.
    const publishedNames = new Set(
      (sdlType.fields ?? []).map((field) => field.name.value),
    );
    for (const name of projection.dropped ?? []) {
      if (!genFields[name]) {
        violations.push(
          `${sdlName}.${name} -- declared as dropped, but ` +
            `${projection.component} publishes no such field`,
        );
        continue;
      }
      if (publishedNames.has(name)) {
        violations.push(
          `${sdlName}.${name} -- declared as dropped, and the SDL publishes it`,
        );
        continue;
      }
      droppedFields += 1;
    }
    // Completeness, so `dropped` is the WHOLE set rather than a sample: every
    // component field the projection does not publish must be named. Without
    // this the list would shrink honestly and still say nothing about a field
    // that vanished after it was written.
    for (const name of Object.keys(genFields)) {
      if (publishedNames.has(name)) continue;
      if (projection.dropped?.includes(name)) continue;
      if ([...renamed.values()].includes(name)) continue;
      violations.push(
        `${sdlName}.${name} -- ${projection.component} publishes it, the ` +
          `projection neither publishes nor declares it dropped`,
      );
    }
  }

  return {
    violations,
    stale: [
      ...Object.keys(declared).filter((key) => !matched.has(key)),
      ...Object.keys(JSON_UNDERTYPED).filter(
        (key) => !undertypedMatched.has(key),
      ),
    ],
    undertyped: undertypedMatched.size,
    comparedTypes,
    comparedFields,
    projections,
    projectedTypes,
    projectedFields,
    droppedFields,
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
      `${report.projections.length} pagination view(s), ` +
      `${report.droppedFields} declared drop(s), ` +
      `${report.undertyped} JSON under-typing(s) left to close.`,
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
