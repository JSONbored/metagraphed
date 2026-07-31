// Read a media type's worked example value out of an OpenAPI document.
//
// Examples are hoisted into components.examples and referenced by $ref (#8763),
// so the value a test wants to assert on is a pointer hop away rather than
// sitting inline on the media type. This helper is the single place that knows
// how to follow it, so a test asserting a CSV header stays about the header
// instead of about the indirection — and so the shape is changed in one file if
// it ever changes again.
//
// tests/openapi-examples.test.ts deliberately does NOT use this helper: its job
// is to assert the hoisting mechanism itself, which means reading the raw $ref
// rather than resolving past it.
import type { Row } from "./row-type.ts";

const REF_PREFIX = "#/components/examples/";

/**
 * The worked example value for a media type object.
 *
 * Accepts both shapes: the hoisted `examples` map the generator emits, and a
 * plain inline `example` (so a hand-built fixture document still works).
 */
export function openApiExampleValue(document: Row, media: Row): Row {
  if (media?.examples) {
    const entry = Object.values(media.examples)[0] as Row;
    if (typeof entry?.$ref !== "string") return entry?.value;
    const name = entry.$ref.replace(REF_PREFIX, "");
    return document?.components?.examples?.[name]?.value;
  }
  return media?.example;
}
