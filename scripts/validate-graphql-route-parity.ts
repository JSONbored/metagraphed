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

type Json = Record<string, unknown>;

const SDL_PATH = "src/graphql-sdl.ts";
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

type SdlField = { name: string; type: string; doc: string };
type SdlType = { name: string; fields: SdlField[] };

function parseTypes(source: string): SdlType[] {
  const types: SdlType[] = [];
  const blocks = source.matchAll(/^ {2}type (\w+) \{\n([\s\S]*?)^ {2}\}/gm);
  for (const block of blocks) {
    const fields: SdlField[] = [];
    let doc = "";
    for (const raw of block[2].split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('"')) {
        doc = line.replace(/^"+|"+$/g, "");
        continue;
      }
      // Skip argument lines of a multi-line field signature.
      const match = /^(\w+)(?:\([^)]*\))?:\s*([\w![\]]+)$/.exec(line);
      if (match) fields.push({ name: match[1], type: match[2], doc });
      doc = "";
    }
    types.push({ name: block[1], fields });
  }
  return types;
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

// --- report ----------------------------------------------------------------

const declaredKeys = Object.keys(DECLARED);
const stale = declaredKeys.filter((key) => !suppressed.has(key));

console.log(
  `GraphQL↔route parity: ${comparedPairs} type/route pairs, ${comparedFields} fields compared, ` +
    `${findings.length} divergence(s), ${declaredKeys.length} declared.`,
);

if (comparedPairs < 100) {
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

process.exit(findings.length > 0 || stale.length > 0 ? 1 : 0);
