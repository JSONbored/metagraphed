// Equivalence-diff audit for the Zod-generated OpenAPI components
// (types-epic B, #7860 requirement 3): compares each Zod-owned component
// against the hand-edited JSON Schema it replaces (read from git HEAD, since
// the working tree already has the hand-edited keys deleted), after
// normalizing the specific cosmetic differences z.toJSONSchema() introduces
// (documented inline below). Anything left after normalization is a real
// (bucket a/b) difference and must be resolved before merge, not silenced
// here.
import { execFileSync } from "node:child_process";
import { OPENAPI_ZOD_COMPONENT_NAMES } from "../schemas-src/openapi-registry.ts";
import { generateOpenApiZodComponents } from "./generate-openapi-zod-components.ts";

type Row = Record<string, unknown>;

const OLD_COMPONENT_FILES = [
  "schemas/components/00-core.schema.json",
  "schemas/components/01-enums.schema.json",
  "schemas/components/03-providers.schema.json",
  "schemas/components/04-surfaces.schema.json",
  "schemas/components/05-subnets.schema.json",
  "schemas/components/06-health.schema.json",
  "schemas/components/07-endpoints-rpc.schema.json",
  // Batch 8 (#8062) additions: AdapterArtifact/the review/enrichment-*
  // family live in these two files, previously never read by this script
  // since no earlier batch's components lived there.
  "schemas/components/09-schemas-adapters-r2.schema.json",
  "schemas/components/11-review-intake.schema.json",
  // Batch 10 (#8064) additions: the meta/contracts, evidence/freshness/
  // search families live in these two files, previously never read by this
  // script (09-schemas-adapters-r2.schema.json already added above).
  "schemas/components/08-evidence-search-sources.schema.json",
  "schemas/components/10-contracts-build.schema.json",
];

const MAX_SAFE_INT = Number.MAX_SAFE_INTEGER;

// Recursively normalizes the cosmetic-only differences between a
// hand-edited JSON Schema component and Zod's z.toJSONSchema() output for
// the equivalent Zod schema, so a structural deep-equal after normalization
// isolates genuine (bucket a/b) differences.
function normalize(
  node: unknown,
  opts: { insideArtifactBase?: boolean } = {},
): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => normalize(item, opts));
  }
  if (!node || typeof node !== "object") return node;
  const obj = node as Row;

  // allOf:[{$ref:"#/components/schemas/ArtifactBase"}, {...rest}] -- Zod
  // flattens ArtifactBaseSchema.extend({...}) into one flat object; the
  // hand-edited components instead $ref ArtifactBase and allOf it with the
  // route-specific fields. Normalize the hand-edited side to the same flat
  // shape (drop the $ref branch, merge the rest's required/properties in,
  // OR-ing additionalProperties since ArtifactBase's own is `true`).
  if (
    Array.isArray(obj.allOf) &&
    obj.allOf.length === 2 &&
    (obj.allOf[0] as Row)?.$ref === "#/components/schemas/ArtifactBase"
  ) {
    const rest = obj.allOf[1] as Row;
    return normalize(
      {
        type: "object",
        required: [
          "generated_at",
          "schema_version",
          ...((rest.required as string[]) || []),
        ],
        properties: {
          contract_version: { type: "string" },
          generated_at: { type: "string" },
          notes: {
            anyOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
          },
          schema_version: { const: 1 },
          ...((rest.properties as Row) || {}),
        },
        additionalProperties: true,
      },
      opts,
    );
  }

  // Nullable-with-siblings: hand-edited `{type: [X, "null"], properties:
  // {...}, required: [...], additionalProperties: ...}` -- the non-null
  // siblings only apply to the X branch. Rewrite as `anyOf: [{type: X,
  // ...siblings}, {type: "null"}]` BEFORE the generic per-key loop below
  // (which would otherwise leave those siblings dangling next to anyOf).
  if (Array.isArray(obj.type) && (obj.type as string[]).includes("null")) {
    const nonNull = (obj.type as string[]).filter((t) => t !== "null");
    const { type: _t, ...siblings } = obj;
    return normalize(
      {
        anyOf: [{ type: nonNull[0], ...siblings }, { type: "null" }],
      },
      opts,
    );
  }

  const out: Row = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "$schema" || key === "$id") continue; // Zod-only bookkeeping

    // z.record(z.string(), ...) stamps `propertyNames: {type: "string"}` --
    // always true for a JSON object (every key is already a string), never
    // declared by hand-edited components.
    if (
      key === "propertyNames" &&
      value &&
      typeof value === "object" &&
      (value as Row).type === "string" &&
      Object.keys(value as Row).length === 1
    ) {
      continue;
    }

    // The pre-existing (types-epic A) HttpUrlSchema/HttpOrWssUrlSchema
    // regexes used for social/token/schema/surface URLs are DELIBERATELY
    // stricter than format:"uri" (which permits any scheme, including
    // javascript:/mailto:/ftp: -- verified empirically). This is an
    // intentional, already-decided bucket-c difference (documented in the
    // PR body), not something to relax.
    if (
      key === "pattern" &&
      (value === "^[Hh][Tt][Tt][Pp][Ss]?:\\/\\/" ||
        value === "^(?:[Hh][Tt][Tt][Pp][Ss]?|[Ww][Ss][Ss]?):\\/\\/") &&
      obj.format === undefined
    ) {
      out.format = "uri";
      continue;
    }

    // z.iso.date()/.datetime() etc. pair `format` with an explicit regex
    // `pattern` enforcing that exact format; hand-edited components only
    // ever declare `format` alone. The pattern is a strict superset of what
    // `format` already implies (bucket c: stricter, not different).
    if (key === "pattern" && typeof obj.format === "string") {
      continue;
    }

    // `required` is a JSON Schema SET -- order never affects validation;
    // hand-edited files declare it in field-declaration order, Zod emits
    // object-key order (usually alphabetical). Sort both so ordering never
    // shows up as a diff.
    if (key === "required" && Array.isArray(value)) {
      out[key] = [...(value as string[])].sort();
      continue;
    }

    // z.object({}).passthrough() (the genuinely-open-map carve-out for
    // links[]/provenance, see subnet-detail.ts's own header) emits an empty
    // `properties: {}` alongside `additionalProperties: {}`; hand-edited
    // just omits `properties` entirely for the same "no fixed keys" shape.
    if (
      key === "properties" &&
      value &&
      typeof value === "object" &&
      Object.keys(value).length === 0
    ) {
      continue;
    }

    // `examples` metadata: hand-edited components carry a few illustrative
    // examples (e.g. url: ["https://example.com"]); the Zod schemas don't
    // declare `.meta({examples})` yet -- same documented bucket-b loss as
    // descriptions, not a structural/validation difference.
    if (key === "examples") continue;

    // Descriptions are a documented, separate bucket-b finding (the Zod
    // schemas carry no .describe() calls yet) -- strip from both sides so
    // this structural/type-equivalence pass isn't drowned out by them.
    if (key === "description") continue;

    // z.int() with no explicit .max() stamps Number.MAX_SAFE_INTEGER bounds;
    // z.int().min(0) similarly always carries the upper bound. Hand-edited
    // integers never declare these sentinel bounds -- drop them from
    // whichever side has them so an unbounded int compares equal either way.
    if (
      (key === "maximum" && value === MAX_SAFE_INT) ||
      (key === "minimum" && value === -MAX_SAFE_INT)
    ) {
      continue;
    }

    // `type: X, const: <literal>` (Zod's z.literal(...)) vs hand-edited bare
    // `const: <literal>` with no type -- both mean "exactly this literal
    // value"; drop the redundant type alongside a const, for any literal
    // type (number, string, boolean). Same redundancy for `enum`: Zod
    // always pairs it with `type`, hand-edited enum components never do.
    if (key === "type" && ("const" in obj || "enum" in obj)) {
      continue;
    }

    // A hand-edited `type: [X, "null"], enum: [...literal values..., null]`
    // (batch 1, #8055: the 7d/30d window fields) carries `null` as BOTH a
    // type-array member AND a literal enum member -- redundant, since the
    // nullable-with-siblings rewrite above already produces a separate
    // `{type:"null"}` anyOf branch for it. Zod's z.enum([...]).nullable()
    // only ever emits the type-array form, never duplicates null inside the
    // enum's own value list. Strip a `null` enum member wherever found (both
    // sides) so this redundant-but-equivalent hand-edited authoring style
    // compares equal to Zod's non-redundant one.
    if (key === "enum" && Array.isArray(value) && value.includes(null)) {
      out[key] = (value as unknown[]).filter((v) => v !== null);
      continue;
    }

    // `items: {}` (Zod's z.array(z.unknown())) means "any item type" -- the
    // same as omitting `items` entirely (a hand-edited `{type:"array"}` with
    // no items constraint, e.g. SubnetOverviewArtifact's gap_priorities).
    if (
      key === "items" &&
      value &&
      typeof value === "object" &&
      Object.keys(value).length === 0
    ) {
      continue;
    }

    // additionalProperties: {} (Zod's .passthrough()) and
    // additionalProperties: true (hand-edited) both mean "any extra
    // properties allowed" -- the SAME as omitting the key entirely (JSON
    // Schema's own default). Drop it outright rather than coercing to
    // `true`, so a bare `{type:"object"}` (hand-edited, no properties/
    // additionalProperties at all, e.g. RegistrySummaryArtifact.coverage,
    // types-epic B batch 8/#8062) compares equal to Zod's `{type:"object",
    // properties:{}, additionalProperties:{}}` for the same
    // empty-passthrough-object case. Mirrors
    // scripts/diff-mcp-tool-schemas.ts's identical rule for the MCP epic.
    if (
      key === "additionalProperties" &&
      (value === true ||
        (value && typeof value === "object" && Object.keys(value).length === 0))
    ) {
      continue;
    }

    // `notes` field: hand-edited uses oneOf, Zod emits anyOf, for the exact
    // same two-branch union -- semantically identical for a non-overlapping
    // union (JSON Schema's oneOf/anyOf only differ when branches overlap).
    if (key === "oneOf") {
      out.anyOf = normalize(value, opts);
      continue;
    }

    out[key] = normalize(value, opts);
  }

  // Collapse a single-branch anyOf/oneOf the flattening above may have left
  // (not expected here, defensive only).
  if (Array.isArray(out.anyOf) && out.anyOf.length === 1) {
    Object.assign(out, out.anyOf[0]);
    delete out.anyOf;
  }
  // Single-branch allOf:[{$ref}] is a common hand-edited-OpenAPI idiom for
  // attaching sibling keys (e.g. a description) next to a $ref, which plain
  // JSON Schema doesn't otherwise allow -- after resolveShallowRef resolves
  // the $ref, collapse the wrapper the same way.
  if (Array.isArray(out.allOf) && out.allOf.length === 1) {
    Object.assign(out, out.allOf[0]);
    delete out.allOf;
  }

  return sortKeys(out);
}

function sortKeys(obj: Row): Row {
  const sorted: Row = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted;
}

function loadOldComponents(): Record<string, Row> {
  const components: Record<string, Row> = {};
  for (const file of OLD_COMPONENT_FILES) {
    const content = execFileSync("git", ["show", `HEAD:${file}`], {
      encoding: "utf8",
    });
    const doc = JSON.parse(content);
    Object.assign(components, doc.components.schemas);
  }
  return components;
}

const oldComponents = loadOldComponents();
const newComponents = generateOpenApiZodComponents();

// Resolve a single level of $ref against the hand-edited component set --
// used only to normalize "hand-edited $refs a shared enum, Zod inlines it"
// (bucket c, already documented in the PR body), not for deep resolution.
function resolveShallowRef(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(resolveShallowRef);
  if (!node || typeof node !== "object") return node;
  const obj = node as Row;
  if (
    typeof obj.$ref === "string" &&
    obj.$ref.startsWith("#/components/schemas/") &&
    Object.keys(obj).length === 1
  ) {
    const target = obj.$ref.slice("#/components/schemas/".length);
    // Zod-owned component names stay real $refs on both sides (compared
    // as-is); ArtifactBase is handled by the allOf-flattening branch above
    // (which pattern-matches this literal $ref string, so it must survive
    // to see it); everything else (enums, and SubnetEconomics -- the one
    // deliberately-un-registered leaf, see openapi-registry.ts's header) is
    // resolved inline to match how the Zod side actually emits it.
    if (
      target !== "ArtifactBase" &&
      !OPENAPI_ZOD_COMPONENT_NAMES.includes(target as never)
    ) {
      const resolved = oldComponents[target];
      if (resolved) {
        return resolved.enum
          ? { enum: resolved.enum }
          : resolveShallowRef(resolved);
      }
    }
  }
  if (Array.isArray(node)) return node;
  const out: Row = {};
  for (const [k, v] of Object.entries(obj)) out[k] = resolveShallowRef(v);
  return out;
}

let diffCount = 0;
for (const name of OPENAPI_ZOD_COMPONENT_NAMES) {
  const old = oldComponents[name];
  const fresh = newComponents[name];
  if (!old) {
    console.log(`${name}: SKIP (no hand-edited predecessor found)`);
    continue;
  }
  const normalizedOld = JSON.stringify(
    sortKeys(normalize(resolveShallowRef(old)) as Row),
  );
  const normalizedNew = JSON.stringify(sortKeys(normalize(fresh) as Row));
  if (normalizedOld === normalizedNew) {
    console.log(`${name}: PASS (equivalent after normalizing cosmetic diffs)`);
  } else {
    diffCount++;
    console.log(`${name}: DIFF`);
    console.log("  old (normalized):", normalizedOld);
    console.log("  new (normalized):", normalizedNew);
  }
}

console.log(
  `\n${OPENAPI_ZOD_COMPONENT_NAMES.length - diffCount}/${OPENAPI_ZOD_COMPONENT_NAMES.length} components PASS; ${diffCount} DIFF.`,
);
if (diffCount > 0) process.exit(1);
