// Is the GENERATED schema's nullability true of production? (#10214)
//
// The emitter marks a field non-null when its Zod has no `.nullable()`. That is
// a claim about the schema; graphql-js turns it into a promise about the
// PRODUCER, enforced at execution -- one null and the whole surrounding object
// nulls with an error attached, which is what `SelfHealthLane.detail` did on
// every self_health request (#10215).
//
// 253 fields differ that way between the generated schema and the served one,
// and the served one is the safe side of every difference. Cutting over means
// making 253 promises at once, so each needs evidence, and the only place that
// evidence exists is the live surface.
//
// THIS IS THE EVIDENCE. For every Query field, it builds a selection from the
// GENERATED type -- every non-null leaf it can reach that the PUBLISHED schema
// also exposes -- sends it to production, and walks the answer against the
// generated type. A null under a generated non-null is reported with the query
// that found it, so the fix is either the Zod (the producer really can answer
// null) or nothing (the field is safe to tighten).
//
// TWO SOURCES, ONE QUESTION (#10214). Asking through GraphQL is the direct
// measurement, and it is BLIND by construction on any field the published
// schema serves as `JSON`: a probe that selects into one gets back `Field
// "profiles" must not have a selection since type "[JSON!]!" has no subfields`
// and the field is skipped entirely. That was every type #10214 published --
// so the check could not see precisely the fields whose promises were new.
// The same rows are also read off each binding's mirrored REST route, where
// the shape is visible whatever GraphQL says about it, and both feed ONE set
// of counts. Kept in one script rather than a sibling because it is one
// question with two transports: split across two files the shared rule --
// what counts as a violation -- gets decided twice and drifts, which it had
// already started to do (a missing key was fatal in one reading and skipped
// in the other).
//
// Out of band, like its conformance siblings: a check that needs production
// data should not pretend to run on a pull request.
//
// The complement of `src/response-validation-tripwire.ts`, which does the same
// job continuously for REST. Together they are what makes the cutover a
// measurement rather than a leap: REST proves the components hold on every
// request, this proves the GraphQL-only promises hold on the live surface.
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import {
  buildSchema,
  getNamedType,
  isEnumType,
  isNonNullType,
  isObjectType,
  isScalarType,
} from "graphql";
import type {
  GraphQLField,
  GraphQLObjectType,
  GraphQLOutputType,
} from "graphql";
import { buildGeneratedSchema } from "../schemas-src/graphql/build-schema.ts";
import { emitTypes } from "../schemas-src/graphql/emit.ts";
import { QUERY_BINDINGS } from "../schemas-src/graphql/published-names.ts";
import type { OpenApiParameters } from "../schemas-src/graphql/query-arguments.ts";
import { SDL } from "../src/graphql-sdl.ts";
import { dataComponent, limitFor } from "./openapi-document.ts";

const BASE = process.env.CONFORMANCE_API_BASE || "https://api.metagraph.sh";
const SPEC_PATH =
  process.env.CONFORMANCE_SPEC_PATH || "public/metagraph/openapi.json";
/** How deep to follow object edges when building a probe selection. */
const MAX_DEPTH = 3;
/** Retries past a rate limit or a transient 5xx, and the wait between them. */
const RETRIES = 2;
const RETRY_DELAY_MS = 750;

/** Known-good values for the arguments a Query field requires. */
const ARGUMENTS: Readonly<Record<string, string>> = {
  netuid: "1",
  hotkey: '"5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u"',
  coldkey: '"5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u"',
  ss58: '"5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u"',
  address: '"5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u"',
  account: '"5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u"',
  slug: '"apex"',
  tag: '"inference"',
  netuids: "[1, 2]",
  hotkeys: '["5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u"]',
  ref: '"8813000"',
  block: "8813000",
  block_number: "8813000",
  id: '"1"',
  name: '"subnets"',
  path: '"/metagraph/subnets.json"',
  amount: "1.0",
};

/**
 * Per-FIELD overrides, for an argument name whose namespace is not global.
 *
 * `slug` is two different vocabularies. `provider(slug:)` takes a provider
 * slug and `adapter(slug:)` takes a subnet slug, and the table above can only
 * hold one value for the name -- so `adapter(slug: "apex")` resolved null and
 * every `Adapter` field went unobserved, which the report then printed as "no
 * evidence either way". That is the failure this whole script exists to avoid,
 * one level up: a silence read as an answer. Verified against
 * api.metagraph.sh -- `adapter(slug: "apex")` is null, `adapter(slug: "sn-1")`
 * returns netuid 1.
 *
 * Deliberately per field rather than a list of candidates per name: trying
 * every value against every field multiplies the request count by the size of
 * the table, and the ambiguity is not "which of these works" but "this field
 * reads a different namespace", which is a fact worth writing down.
 */
const ARGUMENTS_BY_FIELD: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  adapter: { slug: '"sn-1"' },
};

/**
 * Path-parameter values for the REST half, SEVERAL per parameter.
 *
 * One subject silently decides which types get measured: netuid 1 has 3
 * monitored surfaces and no health incidents, so probing only it leaves
 * `HealthIncidentsArtifactSurfacesIncidents` unobserved and reads that silence
 * as coverage. netuid 64 has 34 surfaces and live incidents. Every value is
 * tried and the observations pool into the same counts.
 *
 * Derived from `ARGUMENTS` where they overlap rather than restated, so the two
 * halves cannot come to disagree about which account or block is known-good.
 */
const REST_PATH_VALUES: Readonly<Record<string, readonly string[]>> = {
  netuid: ["1", "64", "4"],
  hotkey: [ARGUMENTS.hotkey.replaceAll('"', "")],
  coldkey: [ARGUMENTS.coldkey.replaceAll('"', "")],
  ss58: [ARGUMENTS.ss58.replaceAll('"', "")],
  address: [ARGUMENTS.address.replaceAll('"', "")],
  slug: [ARGUMENTS.slug.replaceAll('"', "")],
  block_number: [ARGUMENTS.block_number],
  ref: [ARGUMENTS.ref.replaceAll('"', "")],
  id: [ARGUMENTS.id.replaceAll('"', "")],
  // Computed, not pinned: the archive is a rolling window, so a date literal
  // would pass today and 404 in a month with nothing saying why.
  date: [new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)],
};

/**
 * Query arguments a route needs before it answers with anything to walk.
 *
 * `/api/v1/compare/validators` returns 200 with a null `subnet_context` on
 * every row unless it is given a `netuid` -- an empty answer measures nothing,
 * which is how a type inside a healthy route stays unobserved.
 */
const REST_REQUIRED_QUERY: Readonly<Record<string, string>> = {
  "/api/v1/compare/validators": `hotkeys=${ARGUMENTS.hotkey.replaceAll('"', "")}&netuid=1`,
};

/**
 * Where an observation came from, because the two see different things.
 *
 * GRAPHQL asks production for exactly the non-null leaves it wants and reads
 * the answer. It is the direct measurement -- the same execution that will
 * enforce the promise -- and it is the authority wherever it can reach.
 *
 * REST reads the same rows off the mirrored route. It exists because the
 * GraphQL side is BLIND by construction on any field the published schema
 * serves as `JSON`: a probe selecting into one gets `Field "profiles" must not
 * have a selection since type "[JSON!]!" has no subfields` and the whole field
 * is skipped. That was every type #10214 published, which is to say the
 * measurement mattered most exactly where this check could not make it. The
 * loader is shared, so the row REST returns IS the row the resolver hands
 * graphql-js; only the promise attached to it differs.
 */
export type Source = "graphql" | "rest";

export interface NullabilityFinding {
  /** `Type.field`, as the generated schema names it. */
  field: string;
  /** How many of the sampled values were null. */
  nulls: number;
  seen: number;
  /** The Query field(s) whose answer exposed it -- how to reproduce. */
  via: string;
}

export interface NullabilityReport {
  /** Query fields the probe could build and send. */
  probed: number;
  /**
   * Bindings the REST half read, which is a DIFFERENT number from `probed`.
   *
   * Printed separately rather than summed: a field GraphQL skipped and REST
   * reached is measured, and one both reached is measured twice as thoroughly.
   * One combined figure would make those indistinguishable.
   */
  restProbed: number;
  /** Query fields skipped entirely, with the reason -- 0 evidence for each. */
  skipped: string[];
  /**
   * Fields that answered only after the query was split, with whatever still
   * refused.
   *
   * NOT skipped: their leaves were observed, so the evidence counts. Filing
   * them under `skipped` would have said the opposite of what happened -- the
   * split exists precisely to turn a refusal into evidence, and a bucket that
   * hides that makes the split look like it failed.
   */
  partial: string[];
  /** Non-null leaves observed at least once. */
  observed: number;
  /** Generated non-nulls production actually answered null for. */
  findings: NullabilityFinding[];
  /** Non-null leaves the probe never saw a value for. */
  unobserved: string[];
}

/**
 * A selection covering every non-null leaf the generated type promises, kept to
 * what the PUBLISHED schema also exposes -- production serves that one, so a
 * field only the generator has cannot be asked for.
 *
 * The two types are passed as an explicit PAIR rather than looked up by name.
 * They disagree about names exactly where this matters: `incidents` returns
 * `IncidentList` in the generated schema and `GlobalIncidents` in the served
 * one, and resolving the counterpart from the generated name lands on a
 * different type or none -- the same mistake, on the writing side, that made
 * `walk` invent 18 findings once.
 *
 * Returns null when nothing is selectable, which is not a finding: a type whose
 * every field is an object the published schema lacks simply cannot be probed
 * from here.
 */
function selectionFor(
  generated: GraphQLObjectType,
  counterpart: GraphQLObjectType,
  depth: number,
  seen: ReadonlySet<string>,
): Selection | null {
  const parts: SelectionPart[] = [];
  for (const [name, field] of Object.entries(generated.getFields())) {
    const servedField = counterpart.getFields()[name];
    if (!servedField) continue;
    // SHAPE comes from the published type, non-nullness from the generated one.
    // Production validates the query against what it serves, so asking by the
    // generated shape is how the probe wrote `changes` bare on a field the
    // surface publishes as `[EmissionGateChange!]!` -- the generator types it
    // JSON -- and got the whole Query field refused. Same rule `walk` already
    // follows for reading the answer, applied to writing the question.
    const served = getNamedType(servedField.type);
    const nonNull = isNonNullType(field.type)
      ? [`${generated.name}.${name}`]
      : [];
    if (isScalarType(served) || isEnumType(served)) {
      parts.push({ field: name, text: name, leaves: nonNull });
      continue;
    }
    const named = getNamedType(field.type);
    if (!isObjectType(served) || depth >= MAX_DEPTH || seen.has(served.name)) {
      continue;
    }
    // The generated counterpart supplies the non-null claims under this edge.
    // When the generator has no object there (it types the field JSON), there
    // are no claims to evidence, so the edge is skipped rather than asked for.
    if (!isObjectType(named)) continue;
    const nested = selectionFor(
      named,
      served,
      depth + 1,
      new Set([...seen, served.name]),
    );
    if (!nested) continue;
    parts.push({
      field: name,
      text: `${name} ${renderSelection(nested.parts)}`,
      leaves: [...nested.leaves, ...nonNull],
      nested,
    });
  }
  if (!parts.length) return null;
  return { parts, leaves: parts.flatMap((p) => p.leaves) };
}

/** One selectable field, with the non-null leaves asking for it would evidence. */
interface SelectionPart {
  /** The field name, kept so a too-complex edge can be re-rendered smaller. */
  field: string;
  text: string;
  leaves: string[];
  /** Present on an object edge -- what a split of this part divides. */
  nested?: Selection;
}
interface Selection {
  parts: SelectionPart[];
  leaves: string[];
}

function renderSelection(parts: readonly SelectionPart[]): string {
  return `{ ${parts.map((p) => p.text).join(" ")} }`;
}

/**
 * Halve one part, so a selection that is a SINGLE too-complex edge can still be
 * asked for.
 *
 * Splitting only the top level bottoms out at `subnets { …everything… }`, which
 * is one part and still over the limit -- and the types that trip it are the
 * biggest ones, so those are exactly the fields whose evidence matters most.
 * Returns null for a leaf or a one-field edge: there is nothing left to divide,
 * and that is reported rather than retried forever.
 */
function splitPart(part: SelectionPart): [SelectionPart, SelectionPart] | null {
  if (!part.nested || part.nested.parts.length < 2) return null;
  const half = Math.ceil(part.nested.parts.length / 2);
  const chunk = (parts: SelectionPart[]): SelectionPart => ({
    field: part.field,
    text: `${part.field} ${renderSelection(parts)}`,
    leaves: parts.flatMap((p) => p.leaves),
    nested: { parts, leaves: parts.flatMap((p) => p.leaves) },
  });
  return [
    chunk(part.nested.parts.slice(0, half)),
    chunk(part.nested.parts.slice(half)),
  ];
}

/** A refusal to ANSWER, as opposed to an answer of null. */
function isTooComplex(errors: readonly { message: string }[]): boolean {
  return errors.some((e) => /complexity/i.test(e.message));
}

interface GraphQLBody {
  data?: unknown;
  errors?: { message: string }[];
}

/**
 * One request, retried once past a rate limit or a transient 5xx.
 *
 * Splitting multiplies the request count, and a request that dies takes the
 * evidence for every leaf under it with it -- silently, because a thinner
 * denominator looks exactly like a healthy run. Observed leaves swung between
 * 600 and 1,241 across otherwise identical runs before this. A failure that
 * survives the retry is still reported, so the run says so rather than passing
 * on less evidence than it claims.
 */
async function send(
  query: string,
  fetchImpl: typeof fetch,
): Promise<GraphQLBody> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchImpl(`${BASE}/api/v1/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });
    // The body is read whatever the status: this surface answers a REFUSED
    // query (complexity, validation) with a 4xx carrying a normal GraphQL
    // `errors` array, and that array is what tells the caller to split and
    // retry smaller. Treating every non-200 as fatal silenced the bisection
    // and cost 18 Query fields their evidence.
    const body = await response.json().catch(() => null);
    if (body && typeof body === "object") return body as GraphQLBody;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= RETRIES) {
      throw new Error(`HTTP ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
}

/** The arguments a Query field requires, rendered -- or null if one is unknown. */
function renderArguments(field: GraphQLField<unknown, unknown>): string | null {
  const parts: string[] = [];
  const overrides = ARGUMENTS_BY_FIELD[field.name] ?? {};
  for (const argument of field.args) {
    if (!isNonNullType(argument.type)) continue;
    const value = overrides[argument.name] ?? ARGUMENTS[argument.name];
    if (value === undefined) return null;
    parts.push(`${argument.name}: ${value}`);
  }
  return parts.length ? `(${parts.join(", ")})` : "";
}

/**
 * Walk an answer beside BOTH types, counting nulls the generated schema would
 * forbid.
 *
 * The answer is shaped by the PUBLISHED schema -- that is what production
 * serves -- so the published type is what describes it, and walking it as the
 * generated type instead invents findings wherever the two disagree. The first
 * version of this did exactly that: `incidents` returns `IncidentList` in the
 * generated schema and `GlobalIncidents` in the served one, and reading the
 * answer through the wrong type reported 18 `EndpointIncident` fields as null
 * on 232 rows for a path production does not expose at all.
 *
 * So: the published type drives the walk, and a field is only judged when the
 * generated type has it too.
 */
/**
 * Walk one answer, counting what the generated schema promises non-null.
 *
 * A NULL counts. An ABSENT key does NOT, from either source, and the reason is
 * worth stating because the opposite is tempting: graphql-js treats a missing
 * property exactly like an explicit null, so absence looks like the same
 * defect.
 *
 * It is not, because an absent key is not one fact but several, and this check
 * cannot tell them apart. Over GraphQL, a key missing from the answer usually
 * means the probe did not ask for it. Over REST, production serves whatever
 * build is deployed, against a contract generated from THIS tree -- so a key
 * the contract declares and the payload lacks may be a defect, or may simply
 * be a field the deployed producer does not compute yet.
 *
 * `stake_tao`/`emission_tao` are the live example, and they are worth spelling
 * out because the obvious reading of them is wrong. They are NOT a rename of
 * the `stake_alpha`/`emission_alpha` the surface answers with: alpha and TAO
 * are DIFFERENT TOKENS. A non-root subnet's stake is denominated in that
 * subnet's own alpha, and #9058/#9066 made the `_tao` fields mean TAO by
 * PRICING alpha through each subnet's alpha price -- a derived quantity, not
 * the same number under a new name. So the deployed producer emitting the raw
 * alpha figure and not the priced one is a gap in the producer, not a Zod that
 * overstates it, and counting it here produced eight findings whose only
 * available "fix" was loosening four correct components to match.
 *
 * What remains is the question this check was written to ask, and both sources
 * can answer it: does the producer ever ANSWER null where the generated schema
 * promises it cannot.
 */
function walk(
  value: unknown,
  publishedOn: GraphQLOutputType,
  generatedOn: GraphQLOutputType | null,
  path: string,
  counts: Map<string, { seen: number; nulls: number; via: Set<string> }>,
  via: string,
): void {
  const named = getNamedType(publishedOn);
  const generatedNamed = generatedOn ? getNamedType(generatedOn) : null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      walk(entry, named, generatedNamed, path, counts, via);
    }
    return;
  }
  if (!isObjectType(named) || value === null || typeof value !== "object") {
    return;
  }
  // Only a generated type of the SAME NAME describes this answer. A different
  // one is a type disagreement between the two schemas, which the schema diff
  // reports -- not a nullability fact about the producer.
  const generatedType =
    generatedNamed &&
    isObjectType(generatedNamed) &&
    generatedNamed.name === named.name
      ? generatedNamed
      : null;
  const row = value as Record<string, unknown>;
  for (const [name, field] of Object.entries(named.getFields())) {
    if (!(name in row)) continue;
    const generatedField = generatedType?.getFields()[name];
    if (generatedField && isNonNullType(generatedField.type)) {
      const key = `${named.name}.${name}`;
      const bucket = counts.get(key) ?? { seen: 0, nulls: 0, via: new Set() };
      bucket.seen += 1;
      if (row[name] === null) {
        bucket.nulls += 1;
        bucket.via.add(via);
      }
      counts.set(key, bucket);
    }
    walk(
      row[name],
      field.type,
      generatedField?.type ?? null,
      `${path}.${name}`,
      counts,
      via,
    );
  }
}

/** Every filling of a route's path parameters, or none if one has no value. */
export function fillRoute(route: string): string[] {
  let filled = [route];
  for (const match of route.matchAll(/\{([^}]+)\}/g)) {
    const values = REST_PATH_VALUES[match[1]];
    if (values === undefined) return [];
    filled = filled.flatMap((one) =>
      values.map((value) => one.replace(match[0], encodeURIComponent(value))),
    );
  }
  return filled;
}

export async function checkNullability(
  openapi: OpenApiParameters,
  fetchImpl: typeof fetch = fetch,
): Promise<NullabilityReport> {
  const { schema: generated } = buildGeneratedSchema(openapi);
  const published = buildSchema(SDL);
  const { types: emitted } = emitTypes();
  const root = generated.getQueryType()!;
  const counts = new Map<
    string,
    { seen: number; nulls: number; via: Set<string> }
  >();
  const skipped: string[] = [];
  const partial: string[] = [];
  const allLeaves = new Set<string>();
  /** Bindings the REST half read, which is separate from what GraphQL probed. */
  const restProbed = new Set<string>();
  let probed = 0;

  /**
   * The REST half, run for every binding that names a route -- including the
   * ones the GraphQL probe handled.
   *
   * Not a fallback. Where both can see a field they agree (the loader is
   * shared), and pooling both is what makes a field null on 1 row in 400 show
   * up at all -- the GraphQL probe reads one answer per field, REST reads up
   * to the route's whole page.
   */
  const probeRest = async (
    binding: (typeof QUERY_BINDINGS)[number],
  ): Promise<void> => {
    if (!binding.route) return;
    // The root to walk REST's `data` against is the route's COMPONENT, never
    // the Query field's return type. For ~40 bindings the resolver returns a
    // PROJECTION it builds -- `EndpointList {items, total, cursor, limit,
    // returned}` over an `EndpointsArtifact {endpoints, summary, ...}` -- and
    // walking a REST body against one reports every projection field as
    // missing. That is a view compared to its source, which is the same
    // mistake `PROJECTED_TYPES` exists to stop the parity gate making: it
    // manufactured 84 findings, every one of them a `*List.items` or
    // `*List.total`, before the root was resolved this way.
    const component = dataComponent(binding.route);
    const generatedType = component ? emitted.get(component) : undefined;
    if (!generatedType) return;
    const routes = fillRoute(binding.route);
    if (routes.length === 0) return;
    const query = [
      limitFor(openapi, binding.route),
      REST_REQUIRED_QUERY[binding.route] ?? "",
    ].filter(Boolean);
    for (const route of routes) {
      const url = `${BASE}${route}${query.length ? `?${query.join("&")}` : ""}`;
      let data: unknown;
      try {
        const res = await fetchImpl(url, {
          headers: { accept: "application/json" },
        });
        if (!res.ok) continue;
        data = ((await res.json()) as { data?: unknown })?.data ?? null;
      } catch {
        continue;
      }
      if (data === null || data === undefined) continue;
      // The generated type is passed as BOTH sides: a REST row is the
      // component's own shape, so the published GraphQL type has no say here
      // -- and it is precisely the side that is blind, since the fields this
      // reaches are the ones it publishes as opaque JSON.
      walk(
        data,
        generatedType,
        generatedType,
        binding.field,
        counts,
        `${binding.field} (REST)`,
      );
      restProbed.add(binding.field);
    }
  };

  for (const binding of QUERY_BINDINGS) {
    const field = root.getFields()[binding.field];
    if (!field) {
      skipped.push(`${binding.field} -- the generated root has no such field`);
      continue;
    }
    // Before any GraphQL reasoning, so a binding the probe SKIPS still gets
    // measured. That is the whole point of consolidating the two: the fields
    // GraphQL cannot ask about are exactly the ones worth asking about.
    await probeRest(binding);
    const publishedField = published.getQueryType()?.getFields()[binding.field];
    if (!publishedField) {
      skipped.push(`${binding.field} -- the served root has no such field`);
      continue;
    }
    // Arguments come from the SERVED field: production rejects a query that
    // omits an argument IT requires, whatever the generator derived. `subnet`
    // was skipped for exactly that -- the generator makes `netuid` optional,
    // the surface requires `Int!`, and rendering the generated shape produced
    // a query production would not accept. (That disagreement is itself worth
    // a look before the cutover; it is reported by the argument gate, not here.)
    const args = renderArguments(publishedField);
    if (args === null) {
      skipped.push(
        `${binding.field} -- a required argument has no known value`,
      );
      continue;
    }
    const named = getNamedType(field.type);
    const servedNamed = getNamedType(publishedField.type);
    if (!isObjectType(named) || !isObjectType(servedNamed)) {
      skipped.push(`${binding.field} -- returns a leaf, nothing to walk`);
      continue;
    }
    const selection = selectionFor(
      named,
      servedNamed,
      1,
      new Set([servedNamed.name]),
    );
    if (!selection) {
      skipped.push(
        `${binding.field} -- nothing selectable on the served schema`,
      );
      continue;
    }
    for (const leaf of selection.leaves) allLeaves.add(leaf);

    /**
     * Ask for these parts, splitting when the surface refuses the query as too
     * complex.
     *
     * The probe asks for every non-null leaf at once, which is the exact shape
     * the published complexity limit exists to refuse: 20 of the skips were the
     * probe tripping over its own request, not a field it could not reach, and
     * a skipped field is 0 evidence for every leaf under it. Bisecting rather
     * than modelling the cost function keeps this honest if the limit or its
     * accounting ever moves -- the surface stays the authority on what it will
     * answer. Returns the reasons nothing could be asked, so a part that is
     * indivisible AND too complex is reported rather than silently dropped.
     */
    const ask = async (parts: readonly SelectionPart[]): Promise<string[]> => {
      if (!parts.length) return [];
      const query = `{ ${binding.field}${args} ${renderSelection(parts)} }`;
      let body: { data?: unknown; errors?: { message: string }[] };
      try {
        body = await send(query, fetchImpl);
      } catch (error) {
        return [String(error)];
      }
      if (body.errors?.length) {
        if (isTooComplex(body.errors)) {
          if (parts.length > 1) {
            const half = Math.ceil(parts.length / 2);
            return [
              ...(await ask(parts.slice(0, half))),
              ...(await ask(parts.slice(half))),
            ];
          }
          const halves = splitPart(parts[0]);
          if (halves) {
            return [...(await ask([halves[0]])), ...(await ask([halves[1]]))];
          }
        }
        return [
          body.errors
            .map((e) => e.message)
            .join(" | ")
            .slice(0, 120),
        ];
      }
      answered = true;
      walk(
        (body.data as Record<string, unknown> | undefined)?.[binding.field],
        publishedField.type,
        field.type,
        binding.field,
        counts,
        binding.field,
      );
      return [];
    };

    let answered = false;
    const reasons = await ask(selection.parts);
    if (answered) probed += 1;
    if (reasons.length) {
      const line =
        `${binding.field} -- ` +
        `${[...new Set(reasons)].join(" | ").slice(0, 160)}`;
      (answered ? partial : skipped).push(line);
    }
  }

  const findings: NullabilityFinding[] = [];
  for (const [key, bucket] of counts) {
    if (bucket.nulls) {
      findings.push({
        field: key,
        nulls: bucket.nulls,
        seen: bucket.seen,
        via: [...bucket.via].sort().join(", "),
      });
    }
  }
  return {
    probed,
    restProbed: restProbed.size,
    skipped,
    partial,
    observed: [...counts.values()].filter((c) => c.seen > 0).length,
    findings: findings.sort((a, b) => a.field.localeCompare(b.field)),
    unobserved: [...allLeaves].filter((leaf) => !counts.get(leaf)?.seen).sort(),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await checkNullability(
    JSON.parse(readFileSync(SPEC_PATH, "utf8")) as OpenApiParameters,
  );
  // The DENOMINATOR is printed with the numerator on purpose. How much a run
  // observes moves with what production served -- a list that answers empty
  // yields no rows and so no evidence for any leaf under it -- and runs minutes
  // apart have ranged from 451 to 1,246. Printing only the numerator lets a
  // thin run read exactly like a thorough one. The count that does hold still
  // across every run is the one that decides the cutover: how many answered
  // null.
  console.log(
    `graphql-nullability: probed ${report.probed} Query field(s) over GraphQL ` +
      `and ${report.restProbed} over REST against ${BASE}; ` +
      `${report.observed} of ${report.observed + report.unobserved.length} ` +
      `generated non-null field(s) observed, ` +
      `${report.findings.length} answered NULL.`,
  );
  if (report.unobserved.length) {
    console.log(
      `\n${report.unobserved.length} non-null field(s) the probe never saw a value for -- ` +
        `no evidence either way:`,
    );
    for (const line of report.unobserved.slice(0, 30))
      console.log(`  - ${line}`);
    if (report.unobserved.length > 30) {
      console.log(`  … and ${report.unobserved.length - 30} more`);
    }
  }
  // Printed apart from `skipped`, because they are the opposite outcome: the
  // split turned a refusal into evidence. Collapsing them would make a working
  // bisect look like a run that gave up.
  if (report.partial.length) {
    console.log(
      `\n${report.partial.length} Query field(s) answered only after the query ` +
        `was split, with what still refused:`,
    );
    for (const line of report.partial.slice(0, 20)) console.log(`  - ${line}`);
    if (report.partial.length > 20) {
      console.log(`  … and ${report.partial.length - 20} more`);
    }
  }
  if (report.skipped.length) {
    console.log(
      `\n${report.skipped.length} Query field(s) skipped -- 0 evidence for each:`,
    );
    for (const line of report.skipped.slice(0, 20)) console.log(`  - ${line}`);
    if (report.skipped.length > 20) {
      console.log(`  … and ${report.skipped.length - 20} more`);
    }
  }
  if (report.findings.length) {
    console.log(
      `\n${report.findings.length} field(s) the generated schema promises non-null ` +
        `and production answers NULL -- each is a Zod that overstates its producer:`,
    );
    for (const finding of report.findings) {
      console.log(
        `  - ${finding.field} -- null on ${finding.nulls} of ${finding.seen} ` +
          `sampled, via ${finding.via}`,
      );
    }
    process.exit(1);
  }
}
