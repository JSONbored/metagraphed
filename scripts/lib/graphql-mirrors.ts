// The `Mirrors GET …` convention, read in one place.
//
// A GraphQL field declares which REST route it mirrors in its own doc comment,
// and four scripts parsed that declaration with their own copy of the pattern:
// validate-published-names, validate-graphql-tier-parity,
// check-graphql-conformance and validate-graphql-route-parity.
//
// Four readers and no owner is the shape that bites quietly here. Every one of
// those scripts treats "no mirror declared" as "nothing to check" and moves
// on, so a pattern that stopped matching would not fail -- it would make each
// parity gate pass over the fields it can no longer see. The declaration is a
// contract between the SDL's prose and four checks; it should be written once.

/** The pattern itself, exported so a test can assert what it does and does not match. */
export const MIRRORS_GET = /Mirrors GET (\/api\/v1\/[^\s.]+)/;

/**
 * The REST route a GraphQL field's description says it mirrors, or null.
 *
 * Note the character class excludes `.`, so the captured route can never
 * contain or end with one -- `validate-graphql-route-parity` additionally
 * stripped a trailing dot, which this pattern makes unreachable. That strip is
 * gone with the copies it defended.
 *
 * tests/mcp-tool-cost.test.ts keeps its own, STRICTER pattern
 * (`[a-z0-9{}/_-]*`, an explicit allowlist rather than this exclusion): it
 * would reject an uppercase or unusual route where this accepts anything
 * non-space and non-dot. Folding it in would loosen it, so it stays.
 */
export function mirroredRoute(
  description: string | null | undefined,
): string | null {
  return MIRRORS_GET.exec(description ?? "")?.[1] ?? null;
}
