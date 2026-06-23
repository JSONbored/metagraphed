// Deterministic, schema-valid example generator for the OpenAPI contract.
//
// Produces a minimal-but-realistic instance for any component/response schema so
// every operation can ship a worked `example` WITHOUT depending on live data —
// keeping public/metagraph/openapi.json reproducible from contracts + schemas
// alone (validate:contract-drift regenerates it offline). Values are seeded by
// field name + format + pattern so the examples read like real metagraphed
// responses rather than bare placeholders. Validity is enforced downstream by
// scripts/validate-openapi-examples.mjs (ajv against each operation's schema).

// Top levels show optional fields (informative); deeper levels stay required-only
// so examples don't explode. MAX_DEPTH bounds recursion on self-referential schemas.
const OPTIONAL_DEPTH = 3;
const MAX_DEPTH = 8;
const ISO = "2026-06-01T00:00:00.000Z";
const HEX64 = "a3f1".repeat(16); // 64 hex chars, matches ^[a-f0-9]{64}$

function valueForPattern(pattern) {
  switch (pattern) {
    case "^[a-f0-9]{64}$":
      return HEX64;
    case "^\\d{4}-\\d{2}-\\d{2}$":
      return "2026-06-01";
    case "^[a-z0-9][a-z0-9-]*$":
      return "example-subnet";
    case "^/metagraph/":
      return "/metagraph/example.json";
    case "^/api/v1":
      return "/api/v1/example";
    case "^#/components/schemas/[A-Za-z0-9]+$":
      return "#/components/schemas/Example";
    case "^[Hh][Tt][Tt][Pp][Ss]?://":
      // http(s)-only guard (e.g. provider logo_url) — keep the sample a valid
      // absolute URL so it satisfies both the pattern and format: uri.
      return "https://api.metagraph.sh/example";
    default:
      return "example";
  }
}

function seededString(name) {
  const n = String(name || "").toLowerCase();
  if (/(^url$|_url$|href|endpoint|uri|repository|documentation|logo)/.test(n)) {
    return "https://api.metagraph.sh/example";
  }
  if (
    /(_at$|_time$|^last_|observed|checked|reviewed|verified|captured|published_|generated_|updated_|started_|ended_)/.test(
      n,
    )
  ) {
    return ISO;
  }
  if (/(^day$|^date$)/.test(n)) return "2026-06-01";
  if (/window/.test(n)) return "30d";
  if (/slug/.test(n)) return "example-subnet";
  if (/(^name$|title|subnet_name|display_name)/.test(n))
    return "Example Subnet";
  if (/(description|^notes$|instructions|summary$)/.test(n)) {
    return "Example description.";
  }
  if (/version/.test(n)) return "2026-06-06.1";
  if (/(provider|operator)/.test(n)) return "example-provider";
  if (/(content_hash|_hash$|^hash$)/.test(n)) return HEX64;
  if (/health_source/.test(n)) return "probe-derived";
  if (/source$/.test(n)) return "live-cron-prober";
  if (/status$/.test(n)) return "ok";
  if (/grade/.test(n)) return "A";
  if (/method/.test(n)) return "GET";
  if (/(surface_id|^id$|_id$)/.test(n)) return "example";
  return "example";
}

function seededNumber(name, schema) {
  const n = String(name || "").toLowerCase();
  const isInt =
    schema.type === "integer" ||
    (Array.isArray(schema.type) && schema.type.includes("integer"));
  let value;
  if (/netuid/.test(n)) value = 7;
  else if (/(uptime_ratio|_ratio$)/.test(n)) value = 0.9966;
  else if (/score$/.test(n)) value = 100;
  else if (/latency/.test(n)) value = 120;
  else if (/block/.test(n)) value = 5000000;
  else if (/(_count$|count$|samples|^total$|returned|limit|cursor)/.test(n)) {
    value = 1;
  } else value = isInt ? 1 : 0.5;
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    value = schema.minimum;
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    value = schema.maximum;
  }
  return isInt ? Math.round(value) : value;
}

function seededBoolean(name) {
  return /(required|^enabled$|public_safe|^ok$|supported)/.test(
    String(name || "").toLowerCase(),
  );
}

function pickType(type) {
  if (Array.isArray(type)) {
    return type.find((entry) => entry !== "null") || type[0];
  }
  return type;
}

function resolveRef(ref, components) {
  return components[ref.split("/").pop()];
}

// Sample a JSON-Schema (2020-12 subset used by the metagraphed contract) into a
// concrete, valid instance. `components` is the bundle's components.schemas map.
// `seenRefs` tracks the $refs resolved along the current descent path (see the
// $ref branch) and is threaded through every recursive call; callers leave it
// at its default.
export function sampleFromSchema(
  schema,
  components,
  name = "",
  depth = 0,
  seenRefs = null,
) {
  if (!schema || typeof schema !== "object") return null;
  if (schema.$ref) {
    // Bound self-referential schemas. The object and array branches grow
    // `depth` as they descend, so an object/array self-reference (a linked list
    // / tree node) trips this MAX_DEPTH guard. But the allOf/oneOf/anyOf and
    // $ref branches recurse WITHOUT growing `depth`, so a self-reference routed
    // purely through composition keywords (e.g. `Node: { oneOf: [$ref Node] }`)
    // never advanced `depth` and recursed until the stack overflowed.
    if (depth >= MAX_DEPTH) return null;
    // Cut a non-advancing cycle: if this same $ref recurs at the same `depth` we
    // already passed through on this path, no progress is being made. Keying by
    // depth (not the ref alone) preserves depth-advancing object/array
    // self-refs, which keep descending until the MAX_DEPTH guard above — so
    // non-cyclic schemas still sample exactly as before.
    const refKey = `${schema.$ref}@${depth}`;
    if (seenRefs && seenRefs.has(refKey)) return null;
    const nextSeen = new Set(seenRefs);
    nextSeen.add(refKey);
    return sampleFromSchema(
      resolveRef(schema.$ref, components),
      components,
      name,
      depth,
      nextSeen,
    );
  }
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.find((value) => value !== null) ?? schema.enum[0];
  }
  if (Array.isArray(schema.allOf)) {
    let merged = {};
    let scalar;
    for (const sub of schema.allOf) {
      const part = sampleFromSchema(sub, components, name, depth, seenRefs);
      if (part && typeof part === "object" && !Array.isArray(part)) {
        merged = { ...merged, ...part };
      } else if (part !== null && part !== undefined) {
        scalar = part;
      }
    }
    return Object.keys(merged).length > 0 ? merged : (scalar ?? merged);
  }
  const variants = schema.oneOf || schema.anyOf;
  if (Array.isArray(variants) && variants.length > 0) {
    const pick =
      variants.find((variant) => pickType(variant.type) !== "null") ||
      variants[0];
    return sampleFromSchema(pick, components, name, depth, seenRefs);
  }

  const type = pickType(schema.type);
  if (type === "null") return null;

  if (type === "object" || (!type && schema.properties)) {
    const out = {};
    const props = schema.properties || {};
    const required = new Set(schema.required || []);
    const includeOptional = depth < OPTIONAL_DEPTH;
    for (const [key, propSchema] of Object.entries(props)) {
      if (!required.has(key) && !includeOptional) continue;
      out[key] = sampleFromSchema(
        propSchema,
        components,
        key,
        depth + 1,
        seenRefs,
      );
    }
    // Pure map object (additionalProperties is a schema, no named props): show
    // one representative entry so the shape is visible.
    if (
      Object.keys(props).length === 0 &&
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object" &&
      depth < OPTIONAL_DEPTH
    ) {
      out.example = sampleFromSchema(
        schema.additionalProperties,
        components,
        "example",
        depth + 1,
        seenRefs,
      );
    }
    return out;
  }

  if (type === "array") {
    if (depth >= MAX_DEPTH) return [];
    return [
      sampleFromSchema(
        schema.items || {},
        components,
        name,
        depth + 1,
        seenRefs,
      ),
    ];
  }

  if (type === "string") {
    if (schema.pattern) return valueForPattern(schema.pattern);
    if (schema.format === "uri") return "https://api.metagraph.sh/example";
    if (schema.format === "date-time") return ISO;
    return seededString(name);
  }
  if (type === "integer" || type === "number")
    return seededNumber(name, schema);
  if (type === "boolean") return seededBoolean(name);
  return null;
}
