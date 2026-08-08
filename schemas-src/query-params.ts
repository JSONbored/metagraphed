// The query-parameter vocabulary, shared by BOTH published surfaces (#9986).
//
// These builders were written for `schemas-src/mcp-tools/` and lived there, so
// the REST route schemas in `schemas-src/routes/` could not reach them and
// hand-declared the same parameters instead -- as unbounded stubs. Measured
// before this move: of 82 MCP input schemas that share properties with their
// route's query schema, 56 disagreed about the CONSTRAINTS, and in every case
// the route side was the looser one:
//
//   netuid        MCP max 65535        route max 9007199254740991 (z.int(), no bound)
//   offset        MCP max 1000000      route unbounded
//   window        MCP enum(7d..all)    route z.string()
//   counterparty  MCP ss58 pattern     route z.string()
//
// That is what two declarations of one parameter always becomes. There is now
// one definition per parameter and both surfaces import it, so a bound changes
// in one place or not at all.
//
// This module is deliberately NOT under mcp-tools/: the parameters are not an
// MCP concept, and putting them there is what made the route schemas rewrite
// them. `mcp-tools/shared.ts` re-exports every symbol, so the ~100 existing
// import sites keep working unchanged.
import { z } from "zod";
import { MAX_OFFSET } from "../workers/request-params.ts";

/**
 * A subnet id. Bounded because it genuinely is: `netuid` is a u16 on chain, and
 * `isU16Netuid` is what the REST routes reject against.
 */
export const netuidSchema = () =>
  z
    .int()
    .min(0)
    .max(65535)
    .describe(
      "Subnet id (netuid), 0-65535. 0 is the root subnet, which is special: " +
        "it has no AMM pool and is emission-ineligible.",
    )
    .meta({ examples: [64, 0] });

/**
 * A page size, capped at the mirrored route's own ceiling.
 *
 * `fallback` is the value the handler uses when the argument is omitted, and
 * passing it is what puts the documented default INTO the contract rather than
 * only in the tool's prose. Deliberately NOT a Zod `.default()`: that would
 * substitute the value during parse, and these handlers own that decision —
 * they clamp an out-of-range limit and fall back on a missing or malformed
 * one, forgiving behaviour tests/mcp-schema-enforcement.test.ts pins on
 * purpose (#8942). Declaring the default without applying it keeps the
 * published contract honest and the runtime behaviour untouched.
 */
export const limitSchema = (max: number, fallback?: number) => {
  const schema = z.int().min(1).max(max);
  return fallback === undefined
    ? schema
        .describe(`Maximum rows to return (1-${max}).`)
        .meta({ examples: [Math.min(20, max)] })
    : schema
        .describe(
          `Maximum rows to return (1-${max}). Defaults to ${fallback} when omitted; ` +
            "a larger value is clamped to the ceiling rather than rejected.",
        )
        .meta({ default: fallback, examples: [fallback] });
};

/**
 * A page offset. `MAX_OFFSET` is the deep-paging bound every paginated route already
 * clamps to — previously declared as unbounded here and silently clamped there.
 */
export const offsetSchema = () =>
  z
    .int()
    .min(0)
    .max(MAX_OFFSET)
    .describe(
      `Rows to skip before the first returned row (0-${MAX_OFFSET}). ` +
        "Defaults to 0; a non-numeric value resolves to 0 and the response reports it.",
    )
    .meta({ examples: [0, 100] });

/**
 * An SS58 address. The pattern is the one 26 tool modules each declared
 * privately; hoisted so the regex and the sentence explaining it live once.
 *
 * Not narrowed to a network prefix: these routes accept any well-formed SS58,
 * and the chain is what rejects an address valid in shape but belonging to no
 * account.
 */
export const SS58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{47,48}$/;
export const ss58Schema = () =>
  z
    .string()
    .regex(SS58_PATTERN)
    .describe(
      "An SS58 account address (47-48 base58 characters). Coldkey or hotkey " +
        "depending on the tool — see the tool description for which this expects.",
    )
    .meta({ examples: ["5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F"] });

/**
 * Sort direction. 31 of the 32 `order` parameters are this exact pair and mean
 * the same thing on every one of them.
 */
export const orderSchema = () =>
  z
    .enum(["asc", "desc"])
    .describe(
      "Sort direction for the chosen sort key: `asc` smallest-first, " +
        "`desc` largest-first.",
    )
    .meta({ examples: ["desc"] });

// --- Descriptions for families whose VALUES are per-tool ---------------------
//
// `window`, `sort` and `kind` do not share one enum — 7, 31 and 5 distinct
// value sets respectively — so they cannot share a builder. What they do share
// is the MEANING of the parameter, and that is the part no caller could read
// anywhere. Each wrapper takes the tool's own enum and attaches the sentence;
// the published `enum` still carries the values, so nothing is duplicated or
// able to drift.

/**
 * A trailing aggregation window. Says the two things the enum cannot: that it
 * is trailing and ends now, not a calendar period, and that the option set is
 * per-tool.
 */
export const windowSchema = <T extends readonly [string, ...string[]]>(
  values: T,
) =>
  z
    .enum(values)
    .describe(
      "Trailing time window to aggregate over, ending at the latest data " +
        "point rather than a calendar boundary. Options are per-tool; see this " +
        "parameter's enum.",
    )
    .meta({ examples: [values[0]] });

/** Which column the result is ranked by. Values are per-tool. */
export const sortSchema = <T extends readonly [string, ...string[]]>(
  values: T,
) =>
  z
    .enum(values)
    .describe(
      "Column to rank the result by; pair with `order` for direction. " +
        "Options are per-tool; see this parameter's enum.",
    )
    .meta({ examples: [values[0]] });

/**
 * A block height bound. Inclusive on both ends, which is the one thing a
 * caller cannot infer from the name and gets wrong by one row.
 */
export const blockBoundSchema = (edge: "first" | "last") =>
  z
    .int()
    .min(0)
    .describe(
      `Inclusive ${edge} block height of the range to read. ` +
        "Omit for an unbounded end.",
    )
    .meta({ examples: [8783000] });

/**
 * A free-text search query. Substring/keyword, not a query language — worth
 * saying, because an agent that assumes operators will silently get no match.
 */
export const querySchema = () =>
  z
    .string()
    .describe(
      "Free-text search terms, matched as case-insensitive substrings. " +
        "Not a query language: operators, quotes and wildcards are matched literally.",
    )
    .meta({ examples: ["inference", "text embedding"] });

/**
 * A page cursor. TWO kinds, and conflating them is the mistake this pair
 * exists to prevent: 32 of the 47 `cursor` parameters are a numeric row
 * offset and 14 are an opaque keyset token. They page differently and only
 * one of them is safe across an inserting table, so they get different
 * sentences rather than one vague shared one.
 */
export const numericCursorSchema = () =>
  z
    .int()
    .min(0)
    .describe(
      "Row offset to resume from — the numeric position of the first row to " +
        "return, not an opaque token. Rows inserted since the previous page " +
        "shift it, so prefer the keyset cursor where a tool offers one.",
    )
    .meta({ examples: [0, 100] });
export const keysetCursorSchema = () =>
  z
    .string()
    .describe(
      "Opaque pagination token: pass back the `next_cursor` from the previous " +
        "response verbatim. Its contents are not stable and must not be parsed " +
        "or constructed. Stable across inserts, unlike a row offset.",
    )
    .meta({ examples: ["eyJiIjo4NzgzMDAwLCJpIjo0fQ"] });

/**
 * The `fields=` projection as a bare string. Same syntax as `fieldsSchema()`
 * but without the regex, for the tools whose handler accepts a looser form —
 * the sentence is what was missing on all 26 of them.
 */
export const fieldsStringSchema = () =>
  z
    .string()
    .describe(
      "Comma-separated row field names to project, e.g. `netuid,name,slug`. " +
        "Bare identifiers only — not a JSON array, no paths or indices. " +
        "Omit for the full row.",
    )
    .meta({ examples: ["netuid,name,slug"] });

/**
 * A `kind` filter. Like `window`/`sort`, the value sets are per-tool (surface
 * kinds, pool kinds, feed kinds …), so only the meaning is shared.
 */
export const kindSchema = <T extends readonly [string, ...string[]]>(
  values: T,
) =>
  z
    .enum(values)
    .describe(
      "Restrict the result to this kind. Options are per-tool; see this " +
        "parameter's enum.",
    )
    .meta({ examples: [values[0]] });

/**
 * A `kind` filter whose accepted values are NOT a closed set — the handler
 * matches against whatever the underlying rows carry, so there is no enum to
 * publish. Says so, because an unmatched value returns an empty result rather
 * than an error, which reads as "no data" instead of "wrong filter".
 */
export const kindStringSchema = () =>
  z
    .string()
    .describe(
      "Restrict the result to this kind, matched exactly against the value " +
        "the rows carry. Open set, so a value nothing matches yields an empty " +
        "result rather than an error. Omit for every kind.",
    )
    .meta({ examples: ["subnet-api"] });

/**
 * A provider slug. Says it is the slug rather than the display name, which is
 * the mistake the parameter invites — `npm run providers:list` prints them.
 */
export const providerSlugSchema = () =>
  z
    .string()
    .describe(
      "Restrict to one provider, by SLUG (`opentensor-foundation`), not " +
        "display name. Unknown slugs yield an empty result, not an error.",
    )
    .meta({ examples: ["opentensor-foundation"] });

/** A surface id, the stable key a surface keeps across renames. */
export const surfaceIdSchema = () =>
  z
    .string()
    .describe(
      "The surface's stable id (`sn-64-chutes-subnet-api`), as returned by " +
        "the surface-listing tools. Stable across renames, unlike the name.",
    )
    .meta({ examples: ["sn-64-chutes-subnet-api"] });

/**
 * A hotkey or coldkey the caller must pick. Distinct from `ss58Schema()` only
 * in that the tools using it name the ROLE in the parameter, so the sentence
 * says which one rather than deferring to the tool description.
 */
export const accountKeySchema = (role: "hotkey" | "coldkey") =>
  z
    .string()
    .regex(SS58_PATTERN)
    .describe(
      role === "hotkey"
        ? "The neuron/validator SS58 hotkey — the key that holds a UID and " +
            "sets weights, not the coldkey that owns the funds."
        : "The owning SS58 coldkey — the key that holds balances and " +
            "delegations, not the hotkey that serves on a subnet.",
    )
    .meta({
      examples: ["5CS3g6nVJM6ouns8n9buN9CzFf2C1YDHVcVGRcxoirKs2xbV"],
    });

/** A neuron's position within one subnet. */
export const uidSchema = () =>
  z
    .int()
    .min(0)
    .describe(
      "Neuron UID: a slot number within ONE subnet, not a global id. The same " +
        "UID on another netuid is a different neuron, and a UID is reused " +
        "after deregistration.",
    )
    .meta({ examples: [0, 128] });
