// The declared published-name registry must still describe the SDL (#10214).
//
// `validate-graphql-component-parity.ts` pairs an SDL type with its Zod
// component by COMPUTING the pairing from the SDL. That is the thing #10214
// deletes, so `schemas-src/graphql/published-names.ts` now declares the map --
// and a declaration nothing checks is a comment.
//
// BOTH DIRECTIONS, because each catches a different way the registry goes
// wrong while the SDL is still here to check against:
//
//   a computed pair the registry does not have  -> a type was added to the SDL
//                                                  and the generator would not
//                                                  know its published name
//   a registry entry nothing computes           -> a stale name that would make
//                                                  the generator emit a type
//                                                  the schema no longer has
//
// Plus the Query bindings and the resolver-built list, for the same reason: the
// generator reads all three, and all three are frozen extracts that only the
// SDL can currently prove right.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse, print } from "graphql";
import type {
  GraphQLObjectType,
  ObjectTypeDefinitionNode,
  TypeNode,
} from "graphql";
import { emitTypes } from "../schemas-src/graphql/emit.ts";
import {
  ALIASED_TYPE_NAMES,
  PUBLISHED_TYPE_NAMES,
  QUERY_BINDINGS,
  SUBSCRIPTION_BINDINGS,
  PROJECTED_TYPES,
  RESOLVER_BUILT_TYPES,
} from "../schemas-src/graphql/published-names.ts";
import { extractSdl } from "./validate-graphql-component-parity.ts";
import { dataComponent } from "./openapi-document.ts";

const SDL_PATH = "src/graphql-sdl.ts";

/** One Query field as the SDL declares it. */
export interface SdlBinding {
  field: string;
  route: string | null;
  /** The full spelling, nullability included -- `SubnetList!`. */
  returns: string;
  description: string;
}

/**
 * Every way the registry's Query bindings stop describing the SDL.
 *
 * A pure function over both lists so a test can drive it with a MUTATED
 * registry and prove each check actually fails -- the rest of this script
 * reads the repo at module load, and a gate only ever run against a passing
 * tree proves nothing.
 */
export function compareQueryBindings(
  sdlBindings: readonly SdlBinding[],
  declaredList: readonly {
    field: string;
    route: string | null;
    returns: string;
    description: string;
  }[],
): string[] {
  const declaredBindings = new Map(
    declaredList.map((binding) => [binding.field, binding]),
  );
  const problems: string[] = [];
  for (const binding of sdlBindings) {
    const declared = declaredBindings.get(binding.field);
    if (!declared) {
      problems.push(`${binding.field} -- in the SDL, not in QUERY_BINDINGS`);
      continue;
    }
    if (declared.route !== binding.route) {
      problems.push(
        `${binding.field} mirrors ${binding.route ?? "no route"}, the registry says ${declared.route ?? "no route"}`,
      );
    }
    // The FULL spelling, nullability included: `SubnetList` and `SubnetList!`
    // are different promises, and the generator emits whichever the registry
    // says. Comparing bare names let a `!` drift silently.
    if (declared.returns !== binding.returns) {
      problems.push(
        `${binding.field} returns ${binding.returns}, the registry says ${declared.returns}`,
      );
    }
    // The published prose. It is the registry's copy that gets emitted, so a
    // description edited in the SDL and not here would be silently reverted at
    // the next generation -- which is exactly the drift this file exists to
    // stop, one field lower down.
    if (declared.description !== binding.description) {
      problems.push(
        `${binding.field} -- the SDL's description and the registry's differ`,
      );
    }
  }
  const sdlFieldNames = new Set(sdlBindings.map((binding) => binding.field));
  for (const binding of declaredList) {
    if (!sdlFieldNames.has(binding.field)) {
      problems.push(`${binding.field} -- in QUERY_BINDINGS, not in the SDL`);
    }
  }
  return problems;
}

/** What the SDL walk found: name identities, mirrors, and everything reached. */
export interface Traversal {
  /** component -> every published name it MIRRORS under. */
  computed: Map<string, Set<string>>;
  /** SDL types reached as a full mirror. */
  paired: Set<string>;
  /** Every component the SDL can reach, projections included. */
  reachable: Set<string>;
}

/**
 * Walk the SDL from its route-backed roots and record what it reaches.
 *
 * TWO SEED KINDS, and the difference is the whole point. A `mirror` seed
 * asserts a NAME IDENTITY -- this SDL type is that component under another
 * name -- and is what the missing/mismatched checks read. A `projection` seed
 * asserts only that the type is REACHABLE: `AccountSubnet` picks four of
 * `AccountPortfolioArtifactPositions`' eleven fields, and that component's own
 * published name is `AccountPortfolioPosition`, so recording the pair would
 * assert two different types are the same one.
 *
 * The projections have to be seeded at all because the walk steps through
 * SAME-NAMED fields and a paginated view renames its row array --
 * `BlockList.items` over `BlocksFeedArtifact.blocks`. Without the rename the
 * walk dead-ends there and never reaches the element component, which is why
 * five components the SDL genuinely publishes had no registry entry and could
 * not have had one: naming them read as stale (#10409).
 *
 * A pure function over its inputs so a test can drive it with a MUTATED
 * registry and prove the walk actually reaches what it claims to -- the rest
 * of this script reads the repo at module load.
 */
export function traverse(
  sdlTypes: ReadonlyMap<string, ObjectTypeDefinitionNode>,
  generated: ReadonlyMap<string, GraphQLObjectType>,
  mirrorSeeds: readonly [string, string][],
  projections: Readonly<Record<string, (typeof PROJECTED_TYPES)[string]>>,
): Traversal {
  /** A projection's renamed row array / row count, per published type. */
  const renamedFields = new Map<string, Map<string, string>>();
  for (const [published, projection] of Object.entries(projections)) {
    const renames = new Map<string, string>();
    if (projection.itemsFrom) renames.set("items", projection.itemsFrom);
    if (projection.totalFrom) renames.set("total", projection.totalFrom);
    if (renames.size) renamedFields.set(published, renames);
  }

  const queue: [string, string, "mirror" | "projection"][] = [
    ...mirrorSeeds.map(
      ([sdlName, component]) =>
        [sdlName, component, "mirror"] as [string, string, "mirror"],
    ),
    ...Object.entries(projections).map(
      ([published, projection]) =>
        [published, projection.component, "projection"] as [
          string,
          string,
          "projection",
        ],
    ),
  ];
  const computed = new Map<string, Set<string>>();
  const paired = new Set<string>();
  const reachable = new Set<string>();
  const visited = new Set<string>();
  while (queue.length) {
    const [sdlName, componentName, kind] = queue.shift()!;
    const sdlType = sdlTypes.get(sdlName);
    const genType = generated.get(componentName);
    if (!sdlType || !genType) continue;
    // One visited set for BOTH kinds. Guarding only the mirrors would let a
    // projection whose descendant is that same projection re-expand forever.
    const key = `${sdlName}|${componentName}|${kind}`;
    if (visited.has(key)) continue;
    visited.add(key);
    reachable.add(componentName);
    if (kind === "mirror") {
      const seen = computed.get(componentName);
      if (seen) seen.add(sdlName);
      else computed.set(componentName, new Set([sdlName]));
      paired.add(sdlName);
    }
    const genFields = genType.getFields();
    const renames = renamedFields.get(sdlName);
    for (const field of sdlType.fields ?? []) {
      const child =
        genFields[renames?.get(field.name.value) ?? field.name.value];
      if (!child) continue;
      const childSdl = namedType(field.type);
      const childGen = generatedName(child.type);
      if (childGen && sdlTypes.has(childSdl) && generated.has(childGen)) {
        // A child that is ITSELF a declared projection stays one. Reaching
        // `Subnet` through `SubnetList.items` -> `SubnetsArtifact.subnets`
        // says where it comes from, not that it mirrors `SubnetIndexEntry`
        // field for field -- it publishes four fields the component has not
        // got and drops twelve it has. Recording it as a mirror would assert
        // both a name identity that is false and that its PROJECTED_TYPES
        // entry is stale.
        queue.push([
          childSdl,
          childGen,
          projections[childSdl] ? "projection" : "mirror",
        ]);
      }
    }
  }
  return { computed, paired, reachable };
}

const sdl = extractSdl(readFileSync(SDL_PATH, "utf8"));
if (!sdl) {
  console.error(`published-names: no SDL template literal in ${SDL_PATH}`);
  process.exit(1);
}
const { types: generated } = emitTypes();

const sdlTypes = new Map<string, ObjectTypeDefinitionNode>();
for (const def of parse(sdl).definitions) {
  if (def.kind === "ObjectTypeDefinition") sdlTypes.set(def.name.value, def);
}

const namedType = (node: TypeNode): string => {
  let current = node;
  while (current.kind !== "NamedType") current = current.type;
  return current.name.value;
};
const generatedName = (type: unknown): string | null => {
  let current = type as { ofType?: unknown; name?: string };
  while (current && "ofType" in current && current.ofType) {
    current = current.ofType as typeof current;
  }
  return current?.name ?? null;
};

// ── the SDL's own Query bindings ─────────────────────────────────────────────
const sdlBindings = (sdlTypes.get("Query")?.fields ?? []).map((field) => {
  const mirrors = /Mirrors GET (\/api\/v1\/[^\s.]+)/.exec(
    field.description?.value ?? "",
  );
  return {
    field: field.name.value,
    route: mirrors ? mirrors[1].replace(/\.$/, "") : null,
    /** The bare name, for the component pairing below. */
    returnsName: namedType(field.type),
    /** The full spelling, nullability included -- what the registry declares. */
    returns: print(field.type),
    description: field.description?.value ?? "",
  };
});

/** Subscription's fields, read the same way Query's are. */
const sdlSubscriptionBindings = (
  sdlTypes.get("Subscription")?.fields ?? []
).map((field) => ({
  field: field.name.value,
  // Always null, and structurally so: the field is reached over WebSocket
  // only, and there is no REST route to mirror.
  route: null,
  returns: print(field.type),
  description: field.description?.value ?? "",
}));

/**
 * The fields whose RESPONSE is deliberately not their route's component.
 *
 * `route` names the request; `reshapes` is the response-side fact that used to
 * be smuggled through `route: null` (#10772).
 */
const RESHAPING_FIELDS = new Set(
  QUERY_BINDINGS.filter((binding) => binding.reshapes).map(
    (binding) => binding.field,
  ),
);

// ── the pairing, computed the way the parity gate computes it ────────────────
const { computed, paired, reachable } = traverse(
  sdlTypes,
  generated,
  sdlBindings.flatMap((binding) => {
    // A seed asserts "this published type IS that route's component", and a
    // binding that declares `reshapes` says exactly the opposite (#10772):
    // `opportunity_boards` re-keys the leaderboards record into six named
    // board fields, so pairing it with RegistryLeaderboardsArtifact asks the
    // walk to prove two different types are the same one. The declaration
    // existed and NOTHING read it -- `reshapes` appeared nowhere in this file
    // -- which is the one-reader trap the epic names. The faithful mirror of
    // the same route (`registry_leaderboards`) still seeds it, so nothing
    // stops being checked.
    if (!binding.route || RESHAPING_FIELDS.has(binding.field)) return [];
    // A type with a PROJECTED_TYPES entry already states this pairing, and
    // states it more precisely: `ExtrinsicDetail` drops two of its component's
    // fields, `BlockChainEvents` adds two and drops one. Seeding it as a full
    // mirror as well asks the walk to prove a stricter claim than the registry
    // makes, and the projection then reads as stale -- one relationship
    // declared twice, which is what naming the routes exposed (#10772).
    if (binding.returnsName && binding.returnsName in PROJECTED_TYPES)
      return [];
    const component = dataComponent(binding.route);
    return component
      ? ([[binding.returnsName, component]] as [string, string][])
      : [];
  }),
  PROJECTED_TYPES,
);

const errors: string[] = [];

/** Every name the registry allows for a component. */
function declaredNames(component: string): string[] {
  const names: string[] = [];
  const primary = PUBLISHED_TYPE_NAMES[component];
  if (primary) names.push(primary);
  const alias = ALIASED_TYPE_NAMES[component];
  if (alias) names.push(alias);
  return names;
}

const missing: string[] = [];
const mismatched: string[] = [];
for (const [component, names] of computed) {
  const declared = declaredNames(component);
  if (declared.length === 0) {
    missing.push(`${component} -> ${[...names].sort().join(", ")}`);
    continue;
  }
  for (const name of names) {
    if (!declared.includes(name)) {
      mismatched.push(
        `${component} is published as ${name}, the registry says ${declared.join(" / ")}`,
      );
    }
  }
}
if (missing.length) {
  errors.push(
    `${missing.length} component(s) the SDL publishes with no registry entry -- add them to PUBLISHED_TYPE_NAMES:\n` +
      missing
        .sort()
        .map((line) => `    ${line}`)
        .join("\n"),
  );
}
if (mismatched.length) {
  errors.push(
    `${mismatched.length} registry entr(y/ies) that name the wrong type:\n` +
      mismatched
        .sort()
        .map((line) => `    ${line}`)
        .join("\n"),
  );
}

const stale = Object.keys(PUBLISHED_TYPE_NAMES)
  .filter((component) => !reachable.has(component))
  .sort();
if (stale.length) {
  errors.push(
    `${stale.length} registry entr(y/ies) naming a component the SDL no longer reaches -- delete them:\n` +
      stale.map((component) => `    ${component}`).join("\n"),
  );
}

const staleAlias = Object.keys(ALIASED_TYPE_NAMES)
  .filter((component) => (computed.get(component)?.size ?? 0) < 2)
  .sort();
if (staleAlias.length) {
  errors.push(
    `${staleAlias.length} alias entr(y/ies) for a component now published under ONE name -- delete them (the duplication resolved itself):\n` +
      staleAlias.map((component) => `    ${component}`).join("\n"),
  );
}

// ── the root bindings ────────────────────────────────────────────────────────
//
// BOTH roots, on the same comparison. Subscription's one field was checked by
// nothing until #10409: it was accounted for as a resolver-built type, which
// means its return type and description lived only in the SDL -- the exact
// drift `QUERY_BINDINGS` exists to stop, on the one root that had no registry.
for (const [rootName, sdlRoot, declaredRoot] of [
  ["Query", sdlBindings, QUERY_BINDINGS],
  ["Subscription", sdlSubscriptionBindings, SUBSCRIPTION_BINDINGS],
] as const) {
  const bindingProblems = compareQueryBindings(sdlRoot, declaredRoot);
  if (bindingProblems.length) {
    errors.push(
      `${bindingProblems.length} ${rootName} binding(s) that no longer describe the SDL:\n` +
        bindingProblems
          .sort()
          .map((line) => `    ${line}`)
          .join("\n"),
    );
  }
}

// ── the resolver-built list, and the projections ─────────────────────────────
//
// A type the traversal cannot reach has to be accounted for by ONE of two
// declarations: `PROJECTED_TYPES` if it picks its fields from a component (and
// is therefore checked field-by-field by validate-graphql-component-parity),
// or `RESOLVER_BUILT_TYPES` if the resolver shapes it from nothing. Splitting
// them matters because only the first is checked: everything in the second is
// taken on trust, so that list is the debt and should only shrink.
const projected = new Set(Object.keys(PROJECTED_TYPES));
// The two ROOTS are excluded by name, not listed as debt. A root is not a
// component and never will be -- it is assembled from its fields -- and both
// have their fields declared: `QUERY_BINDINGS` for Query, `SUBSCRIPTION_
// BINDINGS` for Subscription (#10409). `Subscription` sat in
// RESOLVER_BUILT_TYPES only because the debt list was the one place to put it.
const ROOT_TYPES = new Set(["Query", "Subscription"]);
const unpaired = [...sdlTypes.keys()]
  .filter((name) => !ROOT_TYPES.has(name) && !paired.has(name))
  .sort();
const declaredResolverBuilt = [...RESOLVER_BUILT_TYPES].sort();
const missingResolverBuilt = unpaired.filter(
  (name) => !declaredResolverBuilt.includes(name) && !projected.has(name),
);
const staleResolverBuilt = declaredResolverBuilt.filter(
  (name) => !unpaired.includes(name),
);
const bothLists = declaredResolverBuilt.filter((name) => projected.has(name));
// A projection the traversal reaches AS A FULL MIRROR is a stale declaration:
// the parity gate compares it field-for-field and the entry does nothing. A
// PAGINATED view is reached too and is NOT stale -- the traversal is how the
// parity gate pairs it, and it stays a projection because it publishes a
// subset under its own paging (#10404). The test is the parity gate's own:
// does it add two or more pagination fields its component lacks?
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
const isPaginatedView = (name: string): boolean => {
  const projection = PROJECTED_TYPES[name];
  const genType = projection && generated.get(projection.component);
  if (!genType) return false;
  const componentFields = new Set(Object.keys(genType.getFields()));
  const added = (sdlTypes.get(name)?.fields ?? []).filter(
    (field) =>
      PAGINATION_FIELDS.has(field.name.value) &&
      !componentFields.has(field.name.value),
  );
  return added.length >= 2;
};
const projectedButReached = [...projected].filter(
  (name) => paired.has(name) && !isPaginatedView(name),
);
if (missingResolverBuilt.length) {
  errors.push(
    `${missingResolverBuilt.length} SDL type(s) no component reaches, and neither PROJECTED_TYPES nor RESOLVER_BUILT_TYPES accounts for:\n` +
      missingResolverBuilt.map((name) => `    ${name}`).join("\n"),
  );
}
if (staleResolverBuilt.length) {
  errors.push(
    `${staleResolverBuilt.length} RESOLVER_BUILT_TYPES entr(y/ies) now reached from a component -- delete them:\n` +
      staleResolverBuilt.map((name) => `    ${name}`).join("\n"),
  );
}
if (bothLists.length) {
  errors.push(
    `${bothLists.length} type(s) in BOTH PROJECTED_TYPES and RESOLVER_BUILT_TYPES -- a type is one or the other:\n` +
      bothLists.map((name) => `    ${name}`).join("\n"),
  );
}
if (projectedButReached.length) {
  errors.push(
    `${projectedButReached.length} PROJECTED_TYPES entr(y/ies) the traversal now reaches as a full mirror -- delete them:\n` +
      projectedButReached.map((name) => `    ${name}`).join("\n"),
  );
}

// Reporting and the exit code are the SCRIPT's, not the module's: importing
// this file to reach `compareQueryBindings` must not end the importing process
// -- a test that a gate can fail cannot run inside a gate that exits.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (errors.length) {
  if (!isMain) throw new Error(errors.join("\n"));
  console.error(
    `Published-name validation failed with ${errors.length} issue(s):`,
  );
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

if (isMain)
  console.log(
    `Published-name validation passed: ${Object.keys(PUBLISHED_TYPE_NAMES).length} component name(s), ` +
      `${new Set(Object.values(PUBLISHED_TYPE_NAMES)).size} published type(s), ` +
      `${QUERY_BINDINGS.length} Query binding(s), ` +
      `${SUBSCRIPTION_BINDINGS.length} Subscription binding(s), ` +
      `${Object.keys(PROJECTED_TYPES).length} declared projection(s), ` +
      `${RESOLVER_BUILT_TYPES.length} resolver-built type(s), ` +
      `${Object.keys(ALIASED_TYPE_NAMES).length} declared alias(es).`,
  );
