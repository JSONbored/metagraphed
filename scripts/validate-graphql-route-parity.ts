// Compare the GraphQL SDL's own types against the routes the SDL says it
// mirrors (#9889).
//
// `src/graphql-sdl.ts` is a THIRD hand-maintained mirror of the route contract,
// alongside the MCP tool schemas and the routes themselves. 271 of its
// descriptions carry a `Mirrors GET /api/v1/…` annotation, and until this gate
// that annotation was prose: `validate:graphql-types-drift` regenerates
// `generated/graphql/types.ts` and diffs it against the committed copy, which
// proves SDL→TypeScript codegen is current and nothing else. Nothing compared
// the SDL to what the routes actually publish.
//
// What that cost: `DomainSummary.emission_concentration` was declared `Float`
// while the route served a 12-key scorecard, so GraphQL raised a coercion error
// and nulled the field on all 14 domains — and the SDL's own comment defined
// that null as "the domain has no members". A well-formed, confident, wrong
// answer for any client that renders `data` without inspecting `errors`.
//
// This runs entirely offline against the committed `openapi.json`; it needs no
// production traffic and covers every field rather than a sample.
import { readFileSync } from "node:fs";
import {
  DECLARED_ARGUMENTS,
  DECLARED_MISSING_NETWORK,
  DECLARED_UNPUBLISHED_ARGUMENTS,
  isDeclaredArgumentType,
} from "../schemas-src/graphql/argument-divergences.ts";

type Json = Record<string, unknown>;

// Overridable so a test can run the whole gate against a MUTATED schema and
// watch it reject. A gate only ever run against a passing tree proves it runs,
// not that it can fail -- and the failure mode of a schema comparison is
// silence, which is exactly what this file's header warns about.
const SDL_PATH = process.env.GRAPHQL_SDL_PATH || "src/graphql-sdl.ts";
const OPENAPI_PATH = "public/metagraph/openapi.json";

/**
 * Field-level divergences that are intentional, each with the reason.
 *
 * The list must SHRINK. An entry that no longer matches a live divergence
 * fails this script, so a fix cannot leave a stale exemption behind — the same
 * idiom the MCP input-parity and tier-cascade gates use.
 */
const DECLARED: Record<string, string> = {
  "SubnetTrajectory.deltas":
    "the resolver reshapes on purpose (src/graphql.ts, `deltas: Object.entries(data.deltas ?? {})`): " +
    "the REST envelope keys deltas by window ('7d'/'30d'), which are not valid GraphQL field names, " +
    "so they become a list of objects carrying `window`. Verified live — the query returns " +
    "[{window:'7d'},{window:'30d'}] with no errors. A shape difference the resolver owns, not drift.",
  "Contracts.status_domain":
    "GraphQL has no null type, so a field the contract types `z.null()` cannot be spelled exactly; " +
    "String is the nullable carrier, and the value is null on every response. The alternative was " +
    "the emitter's old behaviour -- drop the field and report it -- which is how this one and both " +
    "`field_sources_usd.storage` fields left the schema with nothing reading the report (#10214). " +
    "Verified live: /api/v1/contracts serves the key, always as null.",
};

const openapi = JSON.parse(readFileSync(OPENAPI_PATH, "utf8")) as Json;

function deref(node: unknown): Json | null {
  if (!node || typeof node !== "object") return null;
  let current = node as Json;
  for (let hops = 0; hops < 10; hops += 1) {
    const ref = current.$ref;
    if (typeof ref !== "string") break;
    const path = ref.replace(/^#\//, "").split("/");
    let resolved: unknown = openapi;
    for (const segment of path) {
      resolved = (resolved as Json | undefined)?.[segment];
    }
    if (!resolved || typeof resolved !== "object") return null;
    current = resolved as Json;
  }
  return current;
}

// The 200 schema is `allOf: [ {$ref: SuccessEnvelope}, {properties: {data: …}} ]`.
// Reading `.properties.data` off it directly returns nothing, which yields
// "0 pairs compared" and reads as a clean bill of health. Merge first.
function mergeAllOf(schema: unknown): Json {
  const node = deref(schema);
  if (!node) return {};
  const parts = Array.isArray(node.allOf) ? node.allOf : [];
  const merged: Json = { ...node };
  delete merged.allOf;
  const properties: Json = { ...((node.properties as Json) ?? {}) };
  for (const part of parts) {
    const sub = mergeAllOf(part);
    Object.assign(properties, (sub.properties as Json) ?? {});
    for (const [key, value] of Object.entries(sub)) {
      if (key !== "properties" && !(key in merged)) merged[key] = value;
    }
  }
  merged.properties = properties;
  return merged;
}

function routeDataSchema(route: string): Json | null {
  const operation = (openapi.paths as Json | undefined)?.[route] as
    Json | undefined;
  const get = operation?.get as Json | undefined;
  const content = (
    ((get?.responses as Json | undefined)?.["200"] as Json | undefined)
      ?.content as Json | undefined
  )?.["application/json"] as Json | undefined;
  if (!content?.schema) return null;
  const envelope = mergeAllOf(content.schema);
  const data = (envelope.properties as Json | undefined)?.data;
  if (!data) return null;
  return mergeAllOf(data);
}

// --- SDL parsing -----------------------------------------------------------

const sdl = readFileSync(SDL_PATH, "utf8");

type SdlArgument = { name: string; type: string };
type SdlField = {
  name: string;
  type: string;
  doc: string;
  args: SdlArgument[];
};
type SdlType = { name: string; fields: SdlField[] };

/**
 * Parse `type X { … }` blocks, including fields whose argument list spans
 * several lines.
 *
 * The first version of this parser tried to "skip argument lines of a
 * multi-line field signature" with a single-line regex, and did the opposite:
 * `sort: String` sitting inside `subnets( … )` matches the field pattern
 * exactly, so every argument was recorded as a field of `Query` and the field
 * it belonged to was never recorded at all. Because a Query field's `Mirrors
 * GET …` doc landed on its FIRST argument, whose type is a scalar rather than
 * an SDL object type, `byName.get(...)` missed and the pair was skipped in
 * silence — 55 of 160 type/route pairs, a third of the surface, and exactly
 * the paginated/filterable half most likely to drift.
 *
 * Two real divergences were hiding in that third: SourceSnapshotList and
 * EvidenceList both declared `schema_version: String` where the route
 * publishes `{const: 1, type: number}`. GraphQL's String scalar coerces an
 * integer rather than erroring, so the two surfaces served `"1"` and `1` for
 * the same field, and nothing anywhere said so.
 *
 * So it tracks paren depth instead: a line opening `name(` starts an argument
 * list, `): Type` closes it, and everything between is an argument.
 */
function parseTypes(source: string): SdlType[] {
  const types: SdlType[] = [];
  const blocks = source.matchAll(/^ {2}type (\w+) \{\n([\s\S]*?)^ {2}\}/gm);
  for (const block of blocks) {
    const fields: SdlField[] = [];
    let doc = "";
    let open: { name: string; doc: string; args: SdlArgument[] } | null = null;
    for (const raw of block[2].split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (open) {
        const close = /^\):\s*(.+)$/.exec(line);
        if (close) {
          fields.push({
            name: open.name,
            type: close[1].replace(/,$/, ""),
            doc: open.doc,
            args: open.args,
          });
          open = null;
          continue;
        }
        const argument = /^(\w+):\s*([\w![\]]+),?$/.exec(line);
        if (argument) open.args.push({ name: argument[1], type: argument[2] });
        continue;
      }
      if (line.startsWith('"')) {
        doc = line.replace(/^"+|"+$/g, "");
        continue;
      }
      const inline = /^(\w+)\(([^)]*)\):\s*([\w![\]]+)$/.exec(line);
      if (inline) {
        fields.push({
          name: inline[1],
          type: inline[3],
          doc,
          args: parseInlineArguments(inline[2]),
        });
        doc = "";
        continue;
      }
      const plain = /^(\w+):\s*([\w![\]]+)$/.exec(line);
      if (plain) {
        fields.push({ name: plain[1], type: plain[2], doc, args: [] });
        doc = "";
        continue;
      }
      const opening = /^(\w+)\($/.exec(line);
      if (opening) {
        open = { name: opening[1], doc, args: [] };
        doc = "";
        continue;
      }
      doc = "";
    }
    types.push({ name: block[1], fields });
  }
  return types;
}

function parseInlineArguments(source: string): SdlArgument[] {
  const args: SdlArgument[] = [];
  for (const part of source.split(",")) {
    const match = /^\s*(\w+):\s*([\w![\]]+)\s*$/.exec(part);
    if (match) args.push({ name: match[1], type: match[2] });
  }
  return args;
}

const types = parseTypes(sdl);
const byName = new Map(types.map((t) => [t.name, t]));

// A GraphQL type name is scalar-ish only after the list/non-null decoration is
// stripped -- otherwise every `[Int!]!` is compared against a JSON `array` and
// reported as a mismatch. Four of five hits in the first hand-run were that.
function bareType(type: string) {
  return type.replace(/[[\]!]/g, "");
}

const SCALARS = new Set(["Int", "Float", "String", "Boolean", "ID", "JSON"]);

function isListType(type: string) {
  return type.trim().startsWith("[");
}

/** The JSON-Schema kinds a GraphQL scalar may legitimately carry. */
const SCALAR_JSON_TYPES: Record<string, string[]> = {
  Int: ["integer", "number"],
  Float: ["number", "integer"],
  String: ["string"],
  Boolean: ["boolean"],
  ID: ["string"],
  JSON: ["object", "array", "string", "number", "integer", "boolean"],
};

function jsonTypesOf(schema: Json): string[] {
  const direct = schema.type;
  if (typeof direct === "string") return [direct];
  if (Array.isArray(direct)) return direct.filter((t) => typeof t === "string");
  // A nullable field is often `anyOf: [ {type: object}, {type: null} ]`.
  for (const key of ["anyOf", "oneOf"]) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      const collected: string[] = [];
      for (const branch of branches) {
        const sub = deref(branch);
        if (sub) collected.push(...jsonTypesOf(sub));
      }
      return collected.filter((t) => t !== "null");
    }
  }
  if (schema.properties) return ["object"];
  if (schema.items) return ["array"];
  return [];
}

// --- comparison ------------------------------------------------------------

type Finding = { key: string; detail: string };
const findings: Finding[] = [];
// Divergences that DID occur but are declared. Tracked separately from
// `findings` so the staleness check below can tell "declared and still real"
// from "declared and no longer real" -- reading it off `findings` alone would
// report every suppressed entry as stale.
const suppressed = new Set<string>();
let comparedFields = 0;
let comparedPairs = 0;

const queryType = byName.get("Query");
if (!queryType) {
  console.error("Could not parse `type Query` out of the SDL.");
  process.exit(1);
}

for (const field of queryType.fields) {
  const mirror = /Mirrors GET (\/api\/v1\/[^\s.]+)/.exec(field.doc);
  if (!mirror) continue;
  const route = mirror[1].replace(/\.$/, "");
  const dataSchema = routeDataSchema(route);
  if (!dataSchema) continue;
  const sdlType = byName.get(bareType(field.type));
  if (!sdlType) continue;
  comparedPairs += 1;

  const properties = (dataSchema.properties as Json | undefined) ?? {};
  for (const sdlField of sdlType.fields) {
    const published = properties[sdlField.name];
    if (!published) continue;
    const publishedSchema = deref(published);
    if (!publishedSchema) continue;
    comparedFields += 1;

    const bare = bareType(sdlField.type);
    const jsonTypes = jsonTypesOf(publishedSchema);
    if (jsonTypes.length === 0) continue;

    const key = `${sdlType.name}.${sdlField.name}`;
    let detail: string | null = null;

    if (isListType(sdlField.type)) {
      if (!jsonTypes.includes("array")) {
        detail = `SDL declares a list (${sdlField.type}) but ${route} publishes ${jsonTypes.join("|")}`;
      }
    } else if (SCALARS.has(bare)) {
      const allowed = SCALAR_JSON_TYPES[bare] ?? [];
      if (!jsonTypes.some((t) => allowed.includes(t))) {
        detail = `SDL declares ${sdlField.type} but ${route} publishes ${jsonTypes.join("|")}`;
      }
    } else if (jsonTypes.includes("array") || jsonTypes.includes("string")) {
      // An object type declared against a published array or string.
      detail = `SDL declares object type ${sdlField.type} but ${route} publishes ${jsonTypes.join("|")}`;
    }

    if (detail) {
      if (key in DECLARED) {
        suppressed.add(key);
        continue;
      }
      findings.push({ key, detail });
    }
  }
}

// --- arguments -------------------------------------------------------------
//
// The types above were gated by #9889; the ARGUMENTS were not, and they are
// the other half of the same mirror. `buildSchema(SDL)` builds an SDL-only
// schema with no resolver map, so there is no per-field hook that could
// validate an argument at request time: whatever the SDL declares is exactly
// what a client may send, and whatever it omits is a route capability GraphQL
// callers simply cannot reach. Both directions are checked here.
//
// Four exemptions are DERIVED rather than declared, because each follows a
// rule the SDL already keeps, and each stops applying by itself the moment the
// underlying fact changes:
//
//   `network` — the network-scoped routes are served at a `/{network}/` twin
//   path, so `network` is a path segment there rather than a query parameter
//   on the base path the annotation names. Allowed exactly when that twin
//   exists in openapi.json.
//
//   `format` — selects the CSV export. GraphQL has no CSV surface, and the
//   SDL declares zero `format` arguments across all 194 Query fields, so this
//   is a rule the schema follows already, not an exception carved for it.
//
//   `fields` on a TYPED return — `fields` is REST's projection parameter, and
//   a GraphQL selection set already is one. Exempt exactly when the field's
//   return type is a named SDL object type carrying no `JSON` member: there,
//   asking for a subset is what the query language does. When the return is
//   the opaque `JSON` scalar or a `[JSON!]` row array, the selection set
//   cannot reach inside it and the caller has no projection at all — that is
//   a real gap and is reported. The SDL declares `fields` on 21 fields
//   already, so this exemption describes the existing split rather than
//   inventing one.
//
//   `Boolean` against a published `["true"]` / `["true","false"]` string
//   enum — a query string can only carry those two words as text; GraphQL has
//   a real Boolean. Every resolver on this shape normalises the same way
//   (`if (changes === true) params.set("changes", "true")`), so the SDL is
//   the stricter and more honest of the two spellings, not a divergence.
//
// Everything else diverging goes in one of the two DECLARED maps below with
// the reason, and a stale entry fails.

/**
 * A GraphQL Int is 32 bits signed (max 2,147,483,647) where JSON's integer is
 * not, so an epoch-ms bound has to cross as a String. `src/graphql.ts`'s
 * `blocks` resolver states it at the source: "from/to are observed_at epoch-ms
 * and overflow GraphQL Int's 32 bits, so they are String args passed
 * verbatim". Not drift — the only spelling GraphQL has for the value.
 */

/**
 * Published query parameters with no SDL argument, each with the reason.
 *
 * These are capabilities a REST or MCP caller has and a GraphQL caller does
 * not. Closing one means adding the argument AND forwarding it in the
 * resolver, so they are recorded rather than silently tolerated — every entry
 * here is a gap to close, not a difference to keep.
 */
const DECLARED_MISSING_ARGUMENTS: Record<string, string> = {};

const argumentFindings: Finding[] = [];
const suppressedArguments = new Set<string>();
let comparedArguments = 0;

function publishedParameters(route: string): Map<string, Json> | null {
  const get = ((openapi.paths as Json | undefined)?.[route] as Json | undefined)
    ?.get as Json | undefined;
  if (!get) return null;
  const parameters = Array.isArray(get.parameters) ? get.parameters : [];
  const byParameterName = new Map<string, Json>();
  for (const parameter of parameters) {
    const resolved = deref(parameter);
    if (resolved && typeof resolved.name === "string") {
      byParameterName.set(resolved.name, resolved);
    }
  }
  return byParameterName;
}

/** True when the route has a `/api/v1/{network}/…` twin. */
function hasNetworkTwin(route: string): boolean {
  const twin = route.replace("/api/v1/", "/api/v1/{network}/");
  return Boolean((openapi.paths as Json | undefined)?.[twin]);
}

/**
 * True when the field's return type is fully typed, so a selection set can
 * already project it and REST's `fields` parameter has no work left to do.
 */
function returnsProjectableType(fieldType: string): boolean {
  const named = byName.get(bareType(fieldType));
  if (!named) return false;
  return !named.fields.some((f) => bareType(f.type) === "JSON");
}

/** True when the published parameter is a string enum of `true`/`false`. */
function isBooleanStringEnum(schema: Json): boolean {
  if (schema.type !== "string") return false;
  const values = schema.enum;
  if (!Array.isArray(values) || values.length === 0) return false;
  return values.every((value) => value === "true" || value === "false");
}

for (const field of queryType.fields) {
  const mirror = /Mirrors GET (\/api\/v1\/[^\s.]+)/.exec(field.doc);
  if (!mirror) continue;
  const route = mirror[1].replace(/\.$/, "");
  const published = publishedParameters(route);
  if (!published) continue;

  const declaredArguments = new Set(field.args.map((arg) => arg.name));

  for (const arg of field.args) {
    const key = `${field.name}.${arg.name}`;
    const parameter = published.get(arg.name);
    if (!parameter) {
      if (arg.name === "network" && hasNetworkTwin(route)) continue;
      // `DECLARED_ARGUMENT_TYPES` carries the same fact for an argument whose
      // TYPE is declared -- `extrinsic.ref` and `block_chain_events.block_number`
      // are the route's path parameter under the name GraphQL publishes, and
      // the generator emits them from that entry. One list, read by the gate
      // that would otherwise contradict it (#10772).
      if (
        key in DECLARED_ARGUMENTS ||
        isDeclaredArgumentType(field.name, arg.name)
      ) {
        suppressedArguments.add(key);
        continue;
      }
      argumentFindings.push({
        key,
        detail: `SDL takes ${arg.name} but ${route} publishes no such parameter`,
      });
      continue;
    }
    comparedArguments += 1;
    const schema = deref(parameter.schema);
    if (!schema) continue;
    if (bareType(arg.type) === "Boolean" && isBooleanStringEnum(schema)) {
      continue;
    }
    const jsonTypes = jsonTypesOf(schema);
    const bare = bareType(arg.type);
    if (jsonTypes.length === 0 || !SCALARS.has(bare)) continue;
    const allowed = SCALAR_JSON_TYPES[bare] ?? [];
    if (jsonTypes.some((t) => allowed.includes(t))) continue;
    // A published type that diverges from the route's is exactly what
    // `DECLARED_ARGUMENT_TYPES` records, and the generator EMITS the spelling
    // from it -- so a gate reporting it as drift contradicts the artifact it
    // helped produce. `subnets.cursor`/`providers.cursor` are the opaque
    // keyset against the route's integer offset (#10772).
    if (
      key in DECLARED_ARGUMENTS ||
      isDeclaredArgumentType(field.name, arg.name)
    ) {
      suppressedArguments.add(key);
      continue;
    }
    argumentFindings.push({
      key,
      detail: `SDL types ${arg.name} as ${arg.type} but ${route} publishes ${jsonTypes.join("|")}`,
    });
  }

  // The `network` twin, in the direction the loop below structurally cannot
  // see. On the twin path `network` is `in: "path"`, and on the base path it
  // does not appear at all, so "the route has a twin and the field takes no
  // network argument" was unrepresentable -- the forward rule above exempts a
  // `network` argument BECAUSE the twin is how it is spelled, and the reverse
  // check needed the same knowledge and did not have it. Twenty fields sat in
  // that blind spot: testnet was reachable over REST and unreachable over
  // GraphQL, and the gate reported zero divergences (#10394).
  if (hasNetworkTwin(route) && !declaredArguments.has("network")) {
    const key = `${field.name}.network`;
    // `DECLARED_MISSING_NETWORK` is where this exact judgement already lives,
    // and it is read by the generator and by
    // `validate:graphql-query-arguments`. This gate kept its own empty list and
    // so re-asked a question the registry had already answered -- one concept,
    // two lists, which is the shape #10772 exists to remove.
    if (
      key in DECLARED_MISSING_ARGUMENTS ||
      DECLARED_MISSING_NETWORK.includes(field.name)
    ) {
      suppressedArguments.add(key);
    } else {
      argumentFindings.push({
        key,
        detail: `${route} has a /{network}/ twin and the SDL takes no network argument, so testnet is unreachable here`,
      });
    }
  }

  for (const [name, parameter] of published) {
    if (parameter.in !== "query") continue;
    if (declaredArguments.has(name)) continue;
    if (name === "format") continue;
    if (name === "fields" && returnsProjectableType(field.type)) continue;
    const key = `${field.name}.${name}`;
    // Same registry, third reader (#10772). `DECLARED_UNPUBLISHED_ARGUMENTS`
    // is the slot this direction never had -- a route capability GraphQL does
    // not publish, with the reason -- and the generator already reads it to
    // decide what to OMIT. A gate that re-asks the question it answers is the
    // second list this epic exists to delete.
    if (
      key in DECLARED_MISSING_ARGUMENTS ||
      key in DECLARED_UNPUBLISHED_ARGUMENTS
    ) {
      suppressedArguments.add(key);
      continue;
    }
    argumentFindings.push({
      key,
      detail: `${route} publishes ${name} and the SDL takes no such argument`,
    });
  }
}

// --- report ----------------------------------------------------------------

const declaredKeys = Object.keys(DECLARED);
const argumentDeclaredKeys = [
  ...Object.keys(DECLARED_ARGUMENTS),
  ...Object.keys(DECLARED_MISSING_ARGUMENTS),
];
const stale = [
  ...declaredKeys.filter((key) => !suppressed.has(key)),
  ...argumentDeclaredKeys.filter((key) => !suppressedArguments.has(key)),
];

console.log(
  `GraphQL↔route parity: ${comparedPairs} type/route pairs, ${comparedFields} fields compared, ` +
    `${findings.length} divergence(s), ${declaredKeys.length} declared.`,
);
console.log(
  `GraphQL↔route arguments: ${comparedArguments} argument/parameter pairs, ` +
    `${argumentFindings.length} divergence(s), ${argumentDeclaredKeys.length} declared.`,
);

if (comparedPairs < 155) {
  console.error(
    `\nOnly ${comparedPairs} pairs resolved — the comparison is not reaching the SDL.\n` +
      "This usually means the 200-schema allOf merge broke, which reports a clean\n" +
      "bill of health while checking nothing.",
  );
  process.exit(1);
}

if (stale.length > 0) {
  console.error(
    `\nStale DECLARED entries — these no longer diverge, so remove them:\n  ${stale.join("\n  ")}`,
  );
}

if (comparedArguments < 400) {
  console.error(
    `\nOnly ${comparedArguments} argument/parameter pairs resolved — the argument\n` +
      "comparison is not reaching the SDL. A multi-line argument list that stops\n" +
      "parsing reports zero divergences while checking nothing, which is how the\n" +
      "type half of this gate ran blind over a third of the schema until #10065.",
  );
  process.exit(1);
}

if (findings.length > 0) {
  console.error("\nThe SDL disagrees with the route it says it mirrors:\n");
  for (const finding of findings) {
    console.error(`  ${finding.key}: ${finding.detail}`);
  }
  console.error(
    "\nFix the SDL to match what the route publishes (the route is the contract),\n" +
      "or add the field to DECLARED with the reason the divergence is intended.",
  );
}

if (argumentFindings.length > 0) {
  console.error(
    "\nThe SDL's arguments disagree with the route's parameters:\n",
  );
  for (const finding of argumentFindings) {
    console.error(`  Query.${finding.key}: ${finding.detail}`);
  }
  console.error(
    "\nAdd the argument to the SDL and forward it in the resolver, or declare it in\n" +
      "DECLARED_ARGUMENTS / DECLARED_MISSING_ARGUMENTS with the reason.",
  );
}

process.exit(
  findings.length > 0 || argumentFindings.length > 0 || stale.length > 0
    ? 1
    : 0,
);
