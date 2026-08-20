// The production subjects every out-of-band sweep asks about (#10220).
//
// A sweep that compares three surfaces has to ask all three about the SAME
// entity, or it compares nothing -- and a sweep that times an operation has to
// ask about an entity production actually holds data for, or it times a 404.
// Both needs are the same table, and before this file each sweep carried its
// own copy of it.
//
// NOT `tests/concrete-path.ts`, and the two must not be merged. That helper
// fills every remaining placeholder with "x" because its job is "a path the
// ROUTER will match" -- shape-valid is the whole requirement, and a value that
// matches no row is fine. This table's job is "a path production ANSWERS", so
// an unfixtured parameter must make the sweep decline the route rather than
// call it with a subject that does not exist. Same-looking strings, opposite
// contracts.
//
// ONE TABLE, three readers. `concreteRoute` fills a REST path, `toolArguments`
// fills an MCP tool call from the route template it mirrors, and
// `argumentsForRequired` fills one from a tool's own `required` list. All three
// read `SUBJECTS`, so a subject cannot be right on one surface and stale on
// another -- which is exactly the divergence these sweeps exist to catch.

type Row = Record<string, unknown>;

/**
 * The four spellings one SS58 path parameter takes across the route table.
 *
 * Kept as an ARRAY rather than a regex alternation. `scan:public-safety`
 * allows a quoted field name and refuses a bare one inside an alternation --
 * correctly, since an alternation is exactly where a bare mention would hide
 * from a reviewer.
 */
const ACCOUNT_PARAMETER_NAMES = ["ss58", "hotkey", "coldkey", "address"];

/** A public on-chain account with history on every account-scoped route. */
const ACCOUNT_FIXTURE = "5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3";

/**
 * Every path/argument parameter a sweep knows a real subject for.
 *
 * A parameter ABSENT here is the signal to skip: `concreteRoute` returns null
 * and `argumentsForRequired` returns null, so an operation is never called
 * with a made-up subject and then reported as slow or divergent when the only
 * thing wrong was the question.
 */
/**
 * Why a sweep is calling, for the `context` argument every MCP tool requires.
 *
 * #9644 made `context` required on ALL 242 tools to capture agent intent. Both
 * sweeps read a tool's own `required` list and skip any tool naming an argument
 * they have no subject for -- which, from that commit on, was every tool. The
 * failure was silent in both: `check-operation-latency` reported `rest: 217
 * timed` and `graphql: 200 timed` and simply printed no mcp line at all, and a
 * surface that is absent cannot be over budget, so the sweep's own staleness
 * rule ("comfortably under budget on EVERY surface") was being decided on two
 * thirds of the evidence.
 *
 * The value is what this genuinely is. The argument is "analytics only; does
 * not affect the result", so nothing depends on it being convincing -- and a
 * fabricated user goal would put ~440 calls a run of fake intent into the
 * telemetry the argument exists to collect.
 */
export const SWEEP_CONTEXT =
  "Automated API conformance and latency sweep (metagraphed CI), not a user request";

export const SUBJECTS: Readonly<
  Record<string, string | number | readonly number[]>
> = {
  // Required by every MCP tool since #9644 -- see SWEEP_CONTEXT.
  context: SWEEP_CONTEXT,
  netuid: 64,
  uid: 0,
  ref: "4200000",
  // A provider that EXISTS. `opentensor-foundation` -- the subject both sweeps
  // carried before this file -- is not a provider id, and
  // `/api/v1/providers/opentensor-foundation` 404s with `artifact_not_found`.
  // The cross-surface sweep had been declining that route and its endpoints
  // sibling for that reason, reported as "did not answer". A provider's
  // identifier is its `id` (`academia`, `allways`, `404-gen`), not a separate
  // slug field, which is what made the wrong guess look plausible.
  slug: "academia",
  date: "2026-08-01",
  crowdloan_id: 0,
  query: "inference",
  q: "inference",
  // A decoded extrinsic (block 8,832,459). Decode history is complete and
  // immutable, so a hash once served is served forever -- this cannot rotate
  // out of a window the way a "latest" subject would.
  hash: "0x3e59f2cdc12f4a47ad37b02aa04d9de650caa405d58f58b4e3c2ed50996ca450",
  // A domain tag from the fixed 14-tag taxonomy (src/domain-tags.ts).
  tag: "agents",
  // A registered surface with probe history (SN7 allways, the api-health
  // surface) -- the id `surface:add` derives, stable while the surface stays
  // registered.
  surface_id: "allways-api-health",
  // Shape-valid and UNMAPPED on purpose: /evm/address/{h160} answers a mapping
  // lookup, and "no mapping" is a real 200 answer with the full response
  // shape. No stable real mapping exists to pin instead -- an H160 that is
  // mapped today can unmap tomorrow, which would turn the sweep's subject
  // stale in a way this one cannot be.
  h160: `0x${"12".repeat(20)}`,
  // The two PLURAL arguments, which only the comparison tools take. No route
  // spells either as a path parameter, so they exist for
  // `argumentsForRequired` alone.
  netuids: [1, 64],
  hotkeys: ACCOUNT_FIXTURE,
  ...Object.fromEntries(
    ACCOUNT_PARAMETER_NAMES.map((name) => [name, ACCOUNT_FIXTURE]),
  ),
};

/** The parameter names a route template still carries, `{netuid}` → `netuid`. */
function placeholders(template: string): string[] {
  return [...template.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

/**
 * The path a route template takes once its parameters are filled, or null when
 * any parameter has no subject.
 *
 * Null rather than a best-effort fill: a sweep that calls
 * `/api/v1/subnets/x/ohlc` gets a 404 and reports it as the route failing,
 * which reads exactly like a real outage.
 */
export function concreteRoute(template: string): string | null {
  let filled = template;
  for (const name of placeholders(template)) {
    const subject = SUBJECTS[name];
    if (subject === undefined) return null;
    filled = filled.replace(`{${name}}`, String(subject));
  }
  return filled;
}

/** Arguments for the MCP tool that mirrors this route template. */
export function toolArguments(template: string): Row {
  // `context` is required by every tool but is not a path placeholder, so it
  // can never come from the template -- see SWEEP_CONTEXT for what its absence
  // cost the cross-surface sweep.
  const args: Row = { context: SWEEP_CONTEXT };
  for (const name of placeholders(template)) {
    if (SUBJECTS[name] !== undefined) args[name] = SUBJECTS[name];
  }
  return args;
}

/**
 * Arguments satisfying a tool's own `required` list, or null when one of them
 * has no subject.
 *
 * The by-name entry point, for a sweep reading `tools/list` rather than the
 * route table. A tool that declines for a missing required argument would be
 * timing our own bad call.
 */
export function argumentsForRequired(required: string[]): Row | null {
  const args: Row = {};
  for (const name of required) {
    const subject = SUBJECTS[name];
    if (subject === undefined) return null;
    args[name] = subject;
  }
  return args;
}
