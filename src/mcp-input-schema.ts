import { z } from "zod";
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

/**
 * The JSON Schema every MCP tool INPUT is emitted as.
 *
 * One helper instead of `{ target: "draft-2020-12" }` repeated at ~376 call
 * sites, so the emission options are chosen once.
 *
 * Deliberately does NOT extract reused sub-schemas into `$defs`, unlike its
 * output-side sibling. An input schema is read by clients that build a form
 * from `properties` and by model providers that consume it directly; a `$ref`
 * there is spec-legal and still risks a tool that silently cannot be called.
 * The saving is on the output side anyway (#9685).
 */
export function inputJsonSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema, { target: "draft-2020-12" });
}

/**
 * The JSON Schema every MCP tool OUTPUT is emitted as.
 *
 * Identical to the input side today, and kept separate because the two have
 * different consumers and the question of whether to diverge them keeps coming
 * back. MEASURED, so it does not have to be asked again:
 *
 * `z.toJSONSchema(..., { reused: "ref" })` extracts repeated sub-schemas into
 * `$defs` -- Zod's own extraction, not a hand-rolled deduper -- and both
 * consumers accept it (Ajv2020 compiles one; the MCP SDK's
 * `ListToolsResultSchema` parses one). On the single worst schema it is worth
 * 37%. Repo-wide it is worth **5.8%** -- 618,068 B to 582,332 B -- because
 * only 64 tools reuse a sub-schema by identity at all.
 *
 * Not taken. A 3% cut of `tools/list` does not pay for changing the emitted
 * SHAPE on the surface with the most external callers, where a client that
 * walks `properties` without resolving `$ref` sees a tool it cannot describe.
 * The real weight is CROSS-tool repetition -- 377 KB, 61% of the output
 * schemas -- and `$defs` cannot reach it, because each tool's schema has to be
 * self-contained. Shrinking that means the schemas carrying less, not being
 * encoded more cleverly (#9685, #9981).
 */
/**
 * The `degraded` block DISPATCH can stamp on any tool result (#10790).
 *
 * `markMcpTierDegraded` fires in `dispatchTool` for every tool, after the
 * handler has returned, whenever the Postgres tier fell back during the call --
 * so `degraded: {reason}` can appear on a result whose own schema never
 * mentioned it. `.passthrough()` let that through unnoticed; under `.strict()`
 * three tools failed their own published outputSchema the first time the tier
 * was cold, and the only reason it was three is that three is what the
 * conformance run happened to exercise.
 *
 * Declared at the SEAM rather than on the tools, because that is where the
 * fact lives: the stamp is a property of dispatch, not of any handler, and a
 * list of "tools that can degrade" would be wrong the first time a handler
 * started reading a tier. A tool that declares a RICHER `degraded` keeps it --
 * `completeDegradedBlock` fills those extra required-nullable keys, and
 * overwriting the richer shape with this one would undo #9910.
 */
const MCP_DEGRADED_BLOCK = z
  .object({
    reason: z
      .string()
      .describe(
        "Why this answer is untrustworthy. `tier_unavailable` is the generic dispatch stamp; a handler that knows more says so in its own words. NEVER read a zero beside this as a measurement.",
      ),
  })
  .strict()
  .optional();

export function outputJsonSchema(schema: z.ZodType) {
  const object = schema instanceof z.ZodObject ? schema : null;
  const published =
    object && !("degraded" in object.shape)
      ? object.extend({ degraded: MCP_DEGRADED_BLOCK })
      : schema;
  return z.toJSONSchema(published, { target: "draft-2020-12" });
}
