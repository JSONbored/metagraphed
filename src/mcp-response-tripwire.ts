// Parse every outgoing MCP result against the schema that tool publishes.
//
// REST has done this since #7860 was made derived: every envelope is parsed
// against its Zod component before it is sent, and a drift is a 500 rather than
// a body. GraphQL gets it from graphql-js, which enforces the generated
// schema's nullability at execution. MCP -- 235 tools -- had nothing.
//
// WHY IT MATTERS MOST HERE. A REST consumer debugging a curl can see the shape
// it got. An agent cannot: a field that quietly stops appearing degrades its
// answer with no signal that anything changed. And MCP output schemas were
// hand-copied from their routes rather than shared, so they could drift from
// the component the REST tripwire enforces -- #10790 collapsed 42 of those
// copies, and found `next_cursor` typed as an integer against a producer that
// returns `string | null` while doing it.
//
// ## DERIVED, NOT LISTED
//
// `outputJsonSchema` is the one seam every tool's output schema passes through,
// and it now carries a reference back to the Zod it emitted from
// (`outputSchemaSource`). So "which schema describes this tool" is answered by
// the registry itself: a tool added tomorrow is covered tonight, and there is
// no list to fall behind. That is the whole lesson of #7860, whose five-route
// hand list was stale the day it landed -- 156 of 161 routes served unchecked
// for as long as it stood.
//
// A tool that publishes NO output schema is not validated, because it has
// promised nothing to validate against. `validate:mcp` already fails a tool
// missing one, so that set is empty and stays empty.
//
// ## IT THROWS, AND THAT WAS A DECISION
//
// The issue that asked for this (#10789) was explicit that REST's choice must
// not be copied without being made, because the caller is different: an agent
// mid-task may be worse served by a hard error than by a slightly-wrong answer.
//
// It throws anyway, for a reason that does not apply to REST. **A conformant
// MCP client validates `structuredContent` against the `outputSchema` we
// published.** So serving a drifted result does not buy the agent a usable
// answer -- it buys a client-side validation failure we cannot see, cannot
// attribute, and cannot fix, in a place where the only evidence is on the
// caller's side. A tool error is the same failure, surfaced where it can be
// read: MCP's error path is structured, `isError` is part of the protocol, and
// an agent can branch on it. That is strictly more information than a shape the
// client will reject on our behalf.
//
// The second reason is what this epic is about. Serving a response the
// published contract does not describe is how a consumer comes to trust a shape
// nothing guarantees, and an agent is the consumer least able to notice.
//
// ## THE ORDER THIS LANDED IN
//
// Measured before enforced, like the migration before it. Production was swept
// against these schemas -- not against its own published copies, which would
// have been a contract agreeing with itself and proving nothing -- before the
// flag was allowed to matter anywhere.
import { outputSchemaSource } from "./mcp-input-schema.ts";
import { isProjectedAway } from "./projection-signal.ts";

/** The stable code an agent branches on, and telemetry groups by. */
export const MCP_RESPONSE_DRIFT_CODE = "response_schema_drift";

/**
 * A tool result that does not match the schema its tool publishes.
 *
 * CLASSIFIED (`toolError`) so the caller gets `response_schema_drift` rather
 * than the generic `internal_error` every unexpected throw collapses into.
 * That distinction is the reason this throws at all: an agent can tell "the
 * answer I got is not the shape this tool promised" from "the upstream is
 * down", and only one of those is worth retrying.
 *
 * CAPTURED (`captureAsFault`) because it is a real defect on our side, not an
 * expected outcome like a rate limit -- it should page, and `cause` carries the
 * error the exception pipeline records.
 */
export class McpResponseSchemaDriftError extends Error {
  readonly tool: string;
  readonly detail: unknown;
  readonly toolError = true;
  readonly code = MCP_RESPONSE_DRIFT_CODE;
  readonly captureAsFault = true;
  constructor(tool: string, detail: unknown) {
    // The issues ride IN the message (bounded), because the message is the
    // only thing the exception pipeline serializes: `detail` never leaves
    // this object, and `cause` is `this`, so the captured fault read
    // "drifted from its published outputSchema" with the diagnosis -- WHICH
    // keys, at WHICH path -- discarded. Measured 2026-08-12: get_subnet_health
    // drifted on netuid 0 for hours and neither PostHog nor a tail could say
    // on what. Same lesson as the REST tripwire's alarm (#10897): the
    // unrecognized keys ARE the diagnosis.
    //
    // RESTORED, and pinned by a test this time. #10914 added it and #10917 --
    // a store refactor branched before that landed -- removed it again with
    // ZERO conflicts, because nothing asserted the message carried anything.
    // A silent revert is what an unasserted behaviour invites, and the cost
    // was measured: production emitted a 64-character alarm naming no key for
    // six hours, and diagnosing #10972 needed a local reproduction to recover
    // what this line already knew.
    super(
      `${tool} result drifted from its published outputSchema: ` +
        String(
          detail instanceof Error ? detail.message : JSON.stringify(detail),
        ).slice(0, 400),
    );
    this.name = "McpResponseSchemaDriftError";
    this.tool = tool;
    this.detail = detail;
    this.cause = this;
  }
}

/**
 * The payload AS THE CLIENT RECEIVES IT, not as the handler built it.
 *
 * ## WHY THIS EXISTS
 *
 * `get_subnet_health` failed 46% of its calls with `response_schema_drift`
 * (13 of 28 in 24h, #10972) on a response that was never wrong. A handler that
 * spreads an object built from an absent artifact leaves keys present with
 * `undefined` -- `overlaySubnetHealth(null, ...)` produces
 * `contract_version`, `generated_at`, `slug` and `name` that way. Zod
 * `.strict()` keys on `Object.keys()`, so it counted all four as unrecognized;
 * `JSON.stringify` DROPS them, so the client never saw one.
 *
 * The tripwire was therefore stricter than the contract it enforces, and
 * turned a correct answer into a tool error for every agent that called it.
 *
 * ## WHY THE ROUND-TRIP, AND NOT A KEY FILTER
 *
 * The published `outputSchema` describes JSON. A conformant MCP client parses
 * the JSON it received and validates THAT -- so the only shape worth checking
 * is the one serialization produces. A shallow "delete undefined keys" pass
 * would fix this call site and miss a nested one, a `Date`, a `Map`, or
 * anything else whose serialized form differs from its in-memory form; the
 * round-trip is the definition rather than an approximation of it.
 *
 * It costs one clone per validated response, paid only while
 * `METAGRAPH_VALIDATE_RESPONSES` is on -- the same trade that flag already
 * exists to make.
 *
 * A payload that cannot be serialized at all is a real fault and is left to
 * the parse, which will fail on the untouched value rather than silently
 * validating something else.
 */
function asSentOverTheWire(payload: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(payload));
  } catch {
    return payload;
  }
}

/**
 * Parse one tool's structured result against the schema it publishes.
 *
 * Called ONLY when the caller has confirmed
 * `env.METAGRAPH_VALIDATE_RESPONSES === "true"` -- the same flag REST's
 * tripwire reads, because they are one decision about one contract.
 *
 * `published` is the tool's `outputSchema` as registered. Passing the emitted
 * JSON rather than a name is what keeps this derived: the caller already holds
 * the object, and the object knows its own source.
 */
export function validateMcpResponseTripwire(
  tool: string,
  published: unknown,
  structuredContent: unknown,
  /**
   * True when the CALLER asked for less -- `fields`, `sections`, or
   * `include_points: false`. A projected result is shorter than the schema that
   * describes it by design, so absence stops being a drift; see
   * src/projection-signal.ts for what stays enforced, and why this had to be
   * shared with REST rather than asked twice.
   */
  projected = false,
): void {
  let schema;
  try {
    schema = outputSchemaSource(published);
    // A tool whose schema did not come through `outputJsonSchema` -- nothing
    // to parse against, and not this module's invariant to enforce.
    if (!schema) return;
  } catch (err) {
    console.warn(
      `[METAGRAPH_VALIDATE_RESPONSES] ${tool} tripwire failed to resolve:`,
      err,
    );
    return;
  }
  const wire = asSentOverTheWire(structuredContent);
  const result = schema.safeParse(wire);
  if (!result.success) {
    const issues = projected
      ? result.error.issues.filter(
          (issue) => !isProjectedAway(wire, issue.path),
        )
      : result.error.issues;
    // Every issue explained by the projection means the result is exactly what
    // was asked for. Anything left is a real drift and still throws.
    if (issues.length > 0) {
      throw new McpResponseSchemaDriftError(tool, { ...result.error, issues });
    }
  }
}
