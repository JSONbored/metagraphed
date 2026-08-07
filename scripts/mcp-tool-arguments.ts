// How to call an MCP tool from nothing but its own published inputSchema.
//
// Extracted from scripts/validate-mcp.ts (#9879) so the hermetic gate and the
// scheduled production conformance check build their arguments the SAME way.
// Two copies of this rule would drift, and the direction they would drift is
// the dangerous one: the production check exists to catch what the hermetic one
// cannot see, so a production check calling tools differently would report
// differences that are its own.
//
// Nothing here is hand-maintained. A newly registered tool is swept correctly
// the day it lands, because every argument comes from the tool's own schema.

type Row = Record<string, unknown>;

/**
 * The first declared example for one parameter's schema.
 *
 * Arguments come from each parameter's OWN declared example, not from a table.
 * That makes the examples load-bearing rather than decorative: an example that
 * is not a valid argument fails the sweep that uses it, which matters because
 * an example is the first thing an agent copies.
 */
export function declaredExample(schema: Row | undefined): {
  found: boolean;
  value?: unknown;
} {
  if (!schema) return { found: false };
  const direct = schema.examples;
  if (Array.isArray(direct) && direct.length > 0) {
    return { found: true, value: direct[0] };
  }
  for (const key of ["anyOf", "oneOf"]) {
    const branch = schema[key];
    if (!Array.isArray(branch)) continue;
    for (const entry of branch) {
      const nested = declaredExample(entry as Row);
      if (nested.found) return nested;
    }
  }
  return { found: false };
}

/**
 * Which arguments must be supplied to call this tool at all.
 *
 * `required` alone is not the whole answer once a tool publishes a choice
 * (#9872): `get_neuron` takes EITHER `uid` OR `hotkey`, so neither can appear
 * in `required` -- and a sweep reading only `required` would call it with no
 * identifier at all and be told so, which looks exactly like a broken contract.
 * Taking the first `oneOf`/`anyOf` branch's own `required` picks one side of
 * the choice, which is what a caller does too.
 *
 * Only a branch that constrains PRESENCE is followed. `get_feed` publishes a
 * value-conditional one -- `kind: "subnet"` requires `netuid`, the other kinds
 * forbid it -- and adopting its first branch's `required` produced
 * `{kind: "registry", netuid: 64}`, which the server rightly rejects. Resolving
 * that needs the condition, not just the requirement, so a branch carrying
 * `properties`/`not`/`if` is left alone and the tool is called from `required`
 * as before.
 */
export function requiredArgumentNames(inputSchema: Row | undefined): string[] {
  const base = ((inputSchema?.required ?? []) as string[]).slice();
  for (const key of ["oneOf", "anyOf"]) {
    const branches = inputSchema?.[key];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const presenceOnly = branches.filter((branch) => {
      const keys = Object.keys((branch ?? {}) as Row);
      return keys.length === 1 && keys[0] === "required";
    });
    if (presenceOnly.length !== branches.length) break;
    for (const name of ((presenceOnly[0] as Row)?.required ?? []) as string[]) {
      if (!base.includes(name)) base.push(name);
    }
    break;
  }
  return base;
}

/**
 * A complete argument object for one tool, plus the parameters that declared no
 * example.
 *
 * `undocumented` is returned rather than thrown on, because the two callers
 * want different things from it: the hermetic gate FAILS (a required parameter
 * with no example means its tool can never be swept), while the production
 * check reports it and moves on rather than turning a documentation gap into a
 * paging alarm.
 */
export function buildToolArguments(inputSchema: Row | undefined): {
  args: Row;
  undocumented: string[];
} {
  const properties = (inputSchema?.properties ?? {}) as Row;
  const args: Row = {};
  const undocumented: string[] = [];
  for (const key of requiredArgumentNames(inputSchema)) {
    const example = declaredExample(properties[key] as Row);
    if (!example.found) {
      undocumented.push(key);
      continue;
    }
    args[key] = example.value;
  }
  return { args, undocumented };
}

/**
 * One real field name off a tool's response, for exercising its `fields`
 * projection.
 *
 * Derived from the response rather than hardcoded, because the valid `fields`
 * values are per-tool: a hardcoded list would be one more hand-maintained copy,
 * and a wrong entry would make the projection check fail for its own reasons.
 *
 * Returns null when the response carries no rows -- which is the whole reason
 * this check has to run against PRODUCTION. In the hermetic harness 30 of the
 * 32 `fields`-capable tools serve nothing, so their projected shape is
 * unexercised there however carefully the gate is written.
 */
export function projectionArgumentFor(
  inputSchema: Row | undefined,
  field: string,
): string | string[] {
  // `fields` has TWO published shapes, and sending the wrong one is rejected
  // rather than ignored: 28 tools take a comma-separated STRING, and the three
  // neuron-row tools take an ARRAY (their own description says so -- "an ARRAY
  // of names, unlike the comma-separated string `fields` takes elsewhere").
  //
  // Read off the tool's own schema rather than listed, because the first
  // version of the production check sent an array to all of them and 27 tools
  // answered `invalid_params`. That looked exactly like "these tools serve no
  // rows", which is the report this check exists to make trustworthy.
  const schema = ((inputSchema?.properties ?? {}) as Row).fields as
    Row | undefined;
  const type = schema?.type;
  const isArray = Array.isArray(type)
    ? type.includes("array")
    : type === "array";
  return isArray ? [field] : field;
}

export function projectableFieldFrom(response: Row | undefined): string | null {
  if (!response) return null;
  const rows = Object.values(response).find(
    (value) =>
      Array.isArray(value) &&
      value.length > 0 &&
      typeof value[0] === "object" &&
      value[0] !== null,
  ) as Row[] | undefined;
  const row = rows?.[0] ?? (response.neuron as Row | undefined);
  if (!row || typeof row !== "object") return null;
  return Object.keys(row)[0] ?? null;
}
