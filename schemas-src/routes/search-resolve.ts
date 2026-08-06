// GET /api/v1/search/resolve (metagraphed-infra#362): what did the user paste?
// Modeled from src/identifier-resolver.ts's resolveIdentifier().
//
// The shape's whole job is to carry AMBIGUITY honestly. Two inputs on this chain
// have more than one correct reading -- a 64-hex string is a block hash or an
// extrinsic hash, and a small integer is a netuid and a block height -- so the
// payload is a LIST with an `exact` flag per candidate rather than a single
// answer. A schema with one `kind` field would have forced the resolver to guess.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

/** One place the query could lead. */
export const ResolvedIdentifierSchema = z
  .object({
    kind: z.enum([
      "account",
      "block",
      "extrinsic",
      "evm-account",
      "subnet",
      "neuron",
    ]),
    /** The canonical value: hex lowercased and 0x-prefixed, integers as text. */
    value: z.string(),
    /** The API path that answers for this candidate. */
    api_path: z.string(),
    /** The site path a UI should link to. */
    ui_path: z.string(),
    /**
     * Whether this is the ONLY reading of the input.
     *
     * `false` means another kind matches the same shape, so a caller should
     * present the alternatives instead of redirecting. It is NOT a claim that
     * the entity exists -- this route never looks anything up.
     */
    exact: z.boolean(),
  })
  .strict();
export type ResolvedIdentifierEntry = z.infer<typeof ResolvedIdentifierSchema>;

export const SearchResolveArtifactSchema = z
  .object({
    schema_version: z.literal(1),
    /** The query as received, trimmed. Echoed so a caller can correlate. */
    query: z.string(),
    /**
     * Candidates, most likely first. EMPTY is a meaningful answer, not an
     * error: it means the query is not an identifier, and the caller should
     * fall through to corpus search (/search or /search/semantic).
     */
    matches: z.array(ResolvedIdentifierSchema),
    match_count: z.int().min(0),
    /**
     * True when there is exactly one candidate and it is exact -- the signal
     * that a UI may navigate straight there rather than showing a list.
     */
    unambiguous: z.boolean(),
  })
  .passthrough();
export type SearchResolveArtifact = z.infer<typeof SearchResolveArtifactSchema>;
export const SearchResolveResponseSchema = successEnvelopeSchema(
  SearchResolveArtifactSchema,
);
