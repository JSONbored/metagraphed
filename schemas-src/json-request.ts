// A JSON request body, PARSED rather than asserted (#11418).
//
// Five handlers across `workers/api.ts` and `workers/data-api.ts` wrote
// `(await request.json()) as Record<string, unknown>` over a body a caller
// controls, then read fields off it. `request.json()` rejects only on invalid
// JSON -- `null`, `[]`, `"a string"` and `42` are all VALID JSON and all
// satisfied the cast.
//
// TWO OF THE FIVE CRASHED ON IT. `watch_push_subscriptions` (POST and DELETE)
// caught the parse and then read `body.endpoint` outside the `try`, so a
// request whose body is the four bytes `null` reached a property access on
// null: an uncaught TypeError, served as a 500, where the handler two lines
// below was already prepared to answer 400. The other three used `body?.x` and
// survived by accident.
//
// The fix is not a wider cast. It is checking the one thing the handlers all
// assume -- that an OBJECT arrived -- and answering 400 when it did not.
import { z } from "zod";

/**
 * An object body, with its members left to the handler.
 *
 * `z.record` declines null, arrays, strings and numbers, which is exactly the
 * set that got through before. What it does NOT do is pin the members: each
 * handler already validates the fields it reads (`typeof body.endpoint ===
 * "string"`), and those checks are the route's contract rather than this
 * module's.
 */
export const JsonObjectBodySchema = z.record(z.string(), z.unknown());
export type JsonObjectBody = z.infer<typeof JsonObjectBodySchema>;

/**
 * An array of object bodies -- a list endpoint's rows.
 *
 * Same argument one level down: `Array.isArray(body.surfaces)` proved the
 * container and said nothing about the elements, so a list of nulls reached
 * consumers as rows whose every field read `undefined`.
 */
export const JsonObjectArraySchema = z.array(JsonObjectBodySchema);

/**
 * Parse a value as a JSON object, or null.
 *
 * For bodies already in hand -- a cache hit, an R2 object, a response a caller
 * has read for its own reasons -- where `readJsonObjectBody` cannot help.
 */
export function asJsonObject(value: unknown): JsonObjectBody | null {
  const parsed = JsonObjectBodySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Read a request's body as a JSON object, or null when it is not one.
 *
 * ONE return for both failures on purpose: "not JSON" and "JSON, but not an
 * object" are the same answer to a caller who sent neither -- a 400 naming the
 * body. Distinguishing them would leak parser detail without giving the caller
 * anything more to fix.
 */
export async function readJsonObjectBody(request: {
  json(): Promise<unknown>;
}): Promise<JsonObjectBody | null> {
  try {
    const parsed = JsonObjectBodySchema.safeParse(await request.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
