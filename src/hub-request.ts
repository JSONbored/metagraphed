// Reading a body an internal Durable Object hub was sent (#11194).
//
// SHARED, not copied into each hub. McpSessionHub, ChainFirehoseHub and
// SubnetStatusHub all take POST bodies from a sibling Worker, and each had its
// own reading of them: one cast to a concrete shape, one cast to all-`unknown`
// and re-narrowed by hand in four places, one cast and not checked at all.
// Three readings of one contract is how the three drifted -- `/mcp-subscribe`
// on ChainFirehoseHub accepted an absent `sessionId` that SubnetStatusHub's
// same-named route refused.
//
// The schemas those bodies are parsed against live in
// schemas-src/internal-wire.ts, next to every other declared vocabulary.
import type { z } from "zod";

/**
 * A request body parsed against its schema, or null.
 *
 * PARSED, NOT CAST. `as { sessionId: string }` over a body that lacks it
 * assigns `undefined` straight into hub state -- a session that answers to
 * nothing, throwing nothing at the point the mistake is made. Null here becomes
 * a 400 at the call site, which is a decline the caller can see.
 *
 * A body that is not JSON at all lands here as null too, rather than as an
 * exception escaping the DO: an internal caller sending a malformed body should
 * read a 400, not a 500 that looks like the hub itself is broken.
 *
 * Typed against Zod's own `ZodType` rather than a hand-written
 * `{ safeParse }` structural stand-in, so a schema is the only thing that can
 * be passed and the inferred output type comes from the schema itself.
 */
export async function parseRequestBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.infer<S> | null> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return null;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The 400 a malformed body earns, in the shape these hubs already answer in. */
export function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}
