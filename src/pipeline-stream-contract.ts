// The boundary that stops a Pipelines stream losing rows silently (#10850).
//
// ## The measurement this exists for
//
// Phase 1's spike sent six events through a real stream on 2026-08-16. Two of
// them never arrived, and the producer was told they had:
//
//   missing required field   -> HTTP 200  {"success":true,"result":{"committed":1}}
//   type mismatch            -> HTTP 200  {"success":true,"result":{"committed":1}}
//   unknown extra field      -> HTTP 200  landed, the extra field STRIPPED
//   malformed JSON           -> HTTP 400  rejected
//
// So the ingest API reports `committed: 1` for a row it will later discard.
// A caller checking `success`, or even `committed`, counts a dropped row as
// written. The drop is visible afterwards in `pipelinesUserErrorsAdaptiveGroups`
// -- but empty at 4 minutes and populated at 11, so it is a reconcile input and
// never a synchronous check. The stripped-field case raises nothing at all, in
// either channel.
//
// This repo already refuses that shape of failure everywhere else: a lane that
// looks healthy and writes nothing is the exact class #10710, #472 and #10838
// were. The answer is not to trust the stream's validation. It is to make
// invalid events unable to reach it.
//
// ## One schema, as everywhere else here
//
// `schemas-src/` is the single source every published artifact derives from,
// and openapi.json is generated rather than written. A Pipelines stream has its
// own schema format, so declaring it by hand beside a Zod schema would be a
// second copy of the same contract -- and a stream schema that drifts from the
// Zod one fails in the silent direction above, because the stream is the half
// that does not complain.
//
// So the Zod schema is the source, `streamSchemaFrom` derives the stream's
// field list, and `validateStreamBatch` gates the send. Neither is optional:
// derivation without validation still lets a bad row through at runtime, and
// validation without derivation lets the two schemas disagree about what "bad"
// means.
//
// ## What this deliberately does NOT do
//
// It does not retry, batch, or send. Pacing and the 429 the spike measured
// (5 MB/request hard-capped, and a second large post refused for >20s) belong
// to a caller that owns a cadence. This module is pure so both can be tested
// without a network.

import { z } from "zod";

/** A field as `wrangler pipelines streams create --schema-file` declares it. */
export interface StreamField {
  name: string;
  type: string;
  required: boolean;
}

/** The whole file that command takes. */
export interface StreamSchema {
  fields: StreamField[];
}

/**
 * The slice of JSON Schema `z.toJSONSchema` emits that this derivation reads.
 *
 * PARSED WITH ZOD, not cast. The input is a foreign document -- Zod's output
 * format, which is free to change between versions -- and this repo's rule for
 * a foreign document is `safeParse`, never an assertion. A shape we do not
 * recognise must fail loudly here rather than silently produce a stream schema
 * that drops rows at the sink.
 */
const JsonSchemaNode = z.object({
  type: z.string().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  anyOf: z.array(z.object({ type: z.string().optional() }).loose()).optional(),
});

const JsonSchemaObject = z.object({
  properties: z.record(z.string(), JsonSchemaNode).default({}),
  required: z.array(z.string()).default([]),
});

/**
 * `int32` when the bounds say so, `int64` otherwise.
 *
 * THE BOUNDS ARE THE WIDTH. `z.int32()` emits
 * `minimum: -2147483648, maximum: 2147483647`; `z.int()` emits the safe-integer
 * range. Reading the declared range is what the document actually states, where
 * reaching for a Zod-internal `format` string reads an implementation detail
 * that carries the same information less durably.
 */
const INT32_MAX = 2_147_483_647;

function pipelineTypeOf(
  node: z.infer<typeof JsonSchemaNode>,
  path: string,
): string {
  switch (node.type) {
    case "string":
      return "string";
    case "boolean":
      return "bool";
    case "integer":
      return typeof node.maximum === "number" && node.maximum <= INT32_MAX
        ? "int32"
        : "int64";
    case "number":
      // A bare `z.number()` is a float. Declaring it an integer would truncate
      // every fractional value with no error anywhere.
      return "float64";
    default:
      throw new Error(
        `pipeline stream schema: ${path} has no representable JSON Schema type ` +
          `(${JSON.stringify(node.type ?? null)}). Zod emits {} for types it cannot ` +
          `express, such as bigint. Model the field as something the stream can ` +
          `carry -- an unmapped type must not guess, because a wrong type is ` +
          `dropped silently at the sink.`,
      );
  }
}

/**
 * The stream schema a Zod object describes.
 *
 * DERIVED THROUGH `z.toJSONSchema`, Zod's own supported export, rather than by
 * walking its class hierarchy. An `instanceof` chain over ZodString/ZodNumber/
 * ZodOptional works until the library reorganises, and reading `.def` needs a
 * double assertion this repo does not allow (#11194). JSON Schema is a stable
 * published contract; Zod's internals are not.
 *
 * Field ORDER follows the Zod shape, so a regenerated file diffs against the
 * previous one instead of reshuffling.
 */
export function streamSchemaFrom(
  schema: z.ZodObject<z.ZodRawShape>,
): StreamSchema {
  // `io: "input"` because a stream carries what the PRODUCER sends, before any
  // transform or default the schema would apply on the way out.
  // `unrepresentable: "any"` so an unmappable type reaches pipelineTypeOf and
  // is named, instead of throwing here as an opaque Zod error.
  // `parse`, not `safeParse` with a hand-written rethrow. Both `properties` and
  // `required` carry defaults, so every document `z.toJSONSchema` produces for a
  // ZodObject satisfies this -- a bespoke failure branch would be unreachable
  // through the signature above, and unreachable defensive code reads as a
  // guard while guarding nothing. Zod's own error is the right one if the
  // output format ever moves.
  const { properties, required } = JsonSchemaObject.parse(
    z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
  );
  return {
    fields: Object.entries(properties).map(([name, node]) => {
      // A nullable field arrives as `anyOf: [{...}, {type: "null"}]` AND stays
      // listed in `required`, because JSON Schema treats present-but-null as
      // present. A stream has no null-vs-absent distinction, so carrying that
      // through would declare the field required and drop every null row.
      const branches = node.anyOf ?? [];
      const nullable = branches.some((branch) => branch.type === "null");
      const effective = nullable
        ? (branches.find((branch) => branch.type !== "null") ?? node)
        : node;
      return {
        name,
        type: pipelineTypeOf(effective, name),
        required: required.includes(name) && !nullable,
      };
    }),
  };
}

/** One event the boundary refused, and why. */
export interface RejectedEvent {
  /** Index in the batch as submitted, so a caller can name the row. */
  index: number;
  /** `issue.path` joined, or "" for a whole-object failure. */
  field: string;
  message: string;
}

export interface StreamBatch<T> {
  /** Parsed events, safe to send. */
  accepted: T[];
  /** Everything refused, with the reason. Never silently dropped. */
  rejected: RejectedEvent[];
}

/**
 * Parse a batch against its schema, keeping the good rows and naming the bad.
 *
 * REJECTED IS RETURNED, NOT THROWN. One malformed row in a 30,000-row pass
 * must not cost the other 29,999 -- that is the same reasoning as the staleness
 * heartbeat isolating each lane. But it is also not swallowed: the caller gets
 * every rejection with its index and field, which is precisely what the stream
 * would have thrown away.
 *
 * `safeParse` per event rather than an array schema, so the index survives.
 * A `z.array(...)` parse reports a path into the array and stops being useful
 * the moment a caller wants to log the row.
 */
export function validateStreamBatch<T>(
  schema: z.ZodType<T>,
  events: readonly unknown[],
): StreamBatch<T> {
  const accepted: T[] = [];
  const rejected: RejectedEvent[] = [];
  events.forEach((event, index) => {
    const parsed = schema.safeParse(event);
    if (parsed.success) {
      accepted.push(parsed.data);
      return;
    }
    for (const issue of parsed.error.issues) {
      rejected.push({
        index,
        field: issue.path.join("."),
        message: issue.message,
      });
    }
  });
  return { accepted, rejected };
}

/**
 * Whether a batch may be sent at all.
 *
 * The stream cannot tell us it dropped something for eleven minutes, so a
 * caller that wants a synchronous answer asks here. Separate from
 * `validateStreamBatch` because "send the good ones and report the rest" and
 * "refuse the whole batch" are both legitimate, and which one is right depends
 * on whether the rows are independent -- a caller should have to choose.
 */
export function isSendable<T>(batch: StreamBatch<T>): boolean {
  return batch.rejected.length === 0;
}
