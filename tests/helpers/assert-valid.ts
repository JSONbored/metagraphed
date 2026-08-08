// One assertion for "this fixture validates against its schema", so a failure
// says WHICH field is wrong (#9846).
//
// `assert.ok(validate(data))` throws away `validate.errors`, which is where AJV
// has already computed the instance path, keyword and missing property. The
// whole failure output was:
//
//     AssertionError: The expression evaluated to a falsy value:
//       ok(validate(SAMPLE_CHANGELOG))
//     - Expected  + Received
//     - true      + false
//
// Reaching "/summary must have required property 'coverage_delta'" from that
// took three vitest round trips, one of them down a false trail: a scratch test
// imported the fixture from the wrong module, validated `undefined`, and got a
// meaningless root-level `must be object` -- a wrong answer that looks like a
// real one.
//
// This matters more as the schemas move to being DERIVED from artifacts rather
// than hand-copied (#9796, #9799, #9801, #9830): fixtures now fall behind their
// schemas by design, so the failure message is the whole developer experience
// of that transition. The Zod side was already readable -- ZodError prints the
// path and the expected type -- which is the contrast that motivated this.
import assert from "node:assert/strict";
import type { ValidateFunction } from "ajv/dist/2020.js";

export function assertValid(
  validate: ValidateFunction,
  data: unknown,
  label = "value",
): void {
  if (validate(data)) return;
  const detail = (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
  // `errors` is empty only if a caller passes a validator that has already been
  // re-run since the failing call; say so rather than printing a bare colon.
  assert.fail(
    `${label} does not validate: ${detail || "(validator reported no errors)"}`,
  );
}
