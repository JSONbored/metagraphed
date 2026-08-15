// The counts every cost-to-participate surface quotes, in ONE place.
//
// ## WHY THIS FILE EXISTS
//
// Four surfaces describe this card -- the REST route and its artifact
// (src/contracts.ts), the GraphQL exposure
// (schemas-src/graphql/query-exposures.ts), the MCP tool (src/mcp-server.ts)
// and the field docs (schemas-src/routes/cost-to-participate.ts,
// schemas-src/compute.ts). Their PROSE is deliberately different: the MCP text
// is imperative because it is read by an agent ("DO NOT COMPUTE A PROFIT"), the
// GraphQL text is shorter, the field docs speak about one field. Collapsing
// them into one string would flatten a difference that is doing real work.
//
// What is NOT different is the FACTS they quote. Those were written as literals
// in each of the four, and on 2026-08-15 all four were wrong: they said "of the
// 17 registered declarations exactly one asks for a GPU" and "111 of 128
// subnets", figures measured while a CHECK constraint was silently rejecting
// SN29's and SN108's rows (#11284). Correcting the REST copy left the GraphQL
// and MCP copies still serving the old numbers to their own callers.
//
// So the numbers live here and are interpolated, exactly the way
// src/route-limits.ts already single-sources CHAIN_HOLDERS_LIMIT_DEFAULT into
// the REST, GraphQL and MCP descriptions of /chain/holders. The mechanism was
// never missing; these facts just never got it.
//
// DEPENDENCY-FREE ON PURPOSE. src/contracts.ts imports this, and contracts.ts
// importing anything that pulls in a route schema breaks the data-api build.
// Plain numbers, no imports -- the same shape src/route-limits.ts holds.
//
// ## WHICH OF THESE CAN GO STALE, AND WHAT STOPS THEM
//
// The first three are properties of the REGISTRY, so they are re-derived from
// registry/subnets/*.json by tests/compute-declaration-figures.test.ts, which
// fails the moment a subnet or a min_compute surface is added or removed. They
// cannot drift silently.
//
// The fourth cannot be derived that way: whether a declaration asks for a GPU
// is a property of the fetched DOCUMENT, not of the registry, so it is a
// measurement with a date on it. Its test asserts the shape of the claim it
// supports -- a minority -- rather than a number no build can check.

/** Subnets in the registry. */
export const SUBNETS_IN_REGISTRY = 129;

/** Registered, publicly-fetchable `min_compute` surfaces -- the declarations
 * this card can ever read. Counted the way the lane itself selects them: by
 * FILENAME (`minComputeSurfaces` / `MIN_COMPUTE_FILENAME`), and `public_safe`.
 *
 * 18, not the 17 published until 2026-08-15: SN103 (Djinn) registers one whose
 * URL 404s, and it was dropped from the count at some point rather than counted
 * as registered-but-dead. It is registered. The prober owns whether it answers. */
export const MIN_COMPUTE_SURFACES_REGISTERED = 18;

/** Subnets registering no `min_compute` surface at all -- the `null` state, and
 * the common one. Exactly SUBNETS_IN_REGISTRY - MIN_COMPUTE_SURFACES_REGISTERED;
 * stated rather than computed so the published sentence and the assertion that
 * checks it read the same way. */
export const SUBNETS_WITHOUT_A_DECLARATION = 111;

/** Declarations that ask for a GPU: SN3, SN29, SN63, SN81, SN108.
 *
 * MEASURED 2026-08-15, and the measurement is the point. The published figure
 * was ONE for as long as SN29's and SN108's rows were being rejected by the
 * stanza CHECK (#11284) -- both declare `required: true` at source, so the
 * constraint bug had been holding up the very number the "no cost per day is
 * published" decision cites. Five of eighteen is still a minority, so that
 * decision is unchanged; it now rests on a count that includes every
 * declaration rather than the ones that happened to persist.
 *
 * Four-valued, so this counts the STRICT `required` verdict only. The other
 * three (not-required, declared-inconsistently, no stanza) are deliberately not
 * folded in -- see gpuRequirement in src/cost-to-participate.ts. */
export const DECLARATIONS_REQUIRING_A_GPU = 5;
