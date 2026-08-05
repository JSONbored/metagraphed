// Normalisation applied to every MCP tool input schema on the way out.
//
// ## The problem this exists to solve
//
// `z.int()` in Zod 4 carries JavaScript's safe-integer range as real constraints, and
// `z.toJSONSchema` faithfully emits them:
//
// z.int()            -> {"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991}
// z.int().min(0)     -> {"type":"integer","minimum":0,"maximum":9007199254740991}
//
// Nobody wrote those numbers and none of them is a real bound. 198 of 287 integer
// parameters carried one, which made the schema unable to express the one distinction a
// caller actually needs: `netuid` is bounded (0..65535) and `block` is not, but both
// rendered identically, so "deliberately unbounded" and "the author forgot `.max()`"
// were indistinguishable. A generated client faithfully emits `le=9007199254740991` for
// a netuid, and an external consumer reading the schema reported it as an unbounded
// list parameter — reasonably, since that is what it says.
//
// Stripping the sentinel is what lets a real `.max()` MEAN something: after this, an
// integer with a `maximum` has one because someone decided it should.
//
// Only the exact safe-integer sentinels are removed. A hand-written bound that happens
// to be large survives, because it is not equal to these; that precision is why this
// strips rather than rewrites.

type Json = Record<string, unknown>;

const INT_MAX = Number.MAX_SAFE_INTEGER;
const INT_MIN = Number.MIN_SAFE_INTEGER;

/** Every place a subschema can hide inside a JSON Schema object we emit. */
const SUBSCHEMA_KEYS = [
  "items",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
] as const;
const SUBSCHEMA_MAP_KEYS = [
  "properties",
  "patternProperties",
  "$defs",
] as const;
const SUBSCHEMA_LIST_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;

/**
 * Remove Zod's implicit safe-integer bounds, recursively.
 *
 * Pure and non-mutating: the caller's schema object is untouched, so a schema shared
 * between the tool registry and a validator cannot be normalised twice into something
 * different, and a test can compare before/after.
 */
export function stripSentinelIntegerBounds<T>(schema: T): T {
  if (Array.isArray(schema)) {
    return schema.map((entry) => stripSentinelIntegerBounds(entry)) as T;
  }
  if (!schema || typeof schema !== "object") return schema;

  const out: Json = { ...(schema as unknown as Json) };

  // Only on integers: a `number` with these bounds would be a deliberate (if odd)
  // choice, and this has no business rewriting it.
  if (out.type === "integer") {
    if (out.maximum === INT_MAX) delete out.maximum;
    if (out.minimum === INT_MIN) delete out.minimum;
    if (out.exclusiveMaximum === INT_MAX) delete out.exclusiveMaximum;
    if (out.exclusiveMinimum === INT_MIN) delete out.exclusiveMinimum;
  }

  for (const key of SUBSCHEMA_KEYS) {
    if (out[key] && typeof out[key] === "object") {
      out[key] = stripSentinelIntegerBounds(out[key]);
    }
  }
  for (const key of SUBSCHEMA_LIST_KEYS) {
    if (Array.isArray(out[key])) {
      out[key] = (out[key] as unknown[]).map((entry) =>
        stripSentinelIntegerBounds(entry),
      );
    }
  }
  for (const key of SUBSCHEMA_MAP_KEYS) {
    const value = out[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const mapped: Json = {};
      for (const [name, sub] of Object.entries(value as Json)) {
        mapped[name] = stripSentinelIntegerBounds(sub);
      }
      out[key] = mapped;
    }
  }

  return out as unknown as T;
}

/**
 * True when a schema still carries a safe-integer sentinel anywhere inside it.
 *
 * The CI gate (`scripts/validate-mcp.ts`) asserts this is false for every published
 * tool, so a newly-added `z.int()` cannot reintroduce the class.
 */
export function hasSentinelIntegerBound(schema: unknown): boolean {
  return (
    JSON.stringify(schema) !==
    JSON.stringify(stripSentinelIntegerBounds(schema))
  );
}
