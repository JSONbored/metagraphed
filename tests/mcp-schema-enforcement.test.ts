// #8942 follow-up: prove that every CATEGORICAL constraint the MCP server
// publishes is actually enforced at runtime — by deriving the test cases from
// the published schemas rather than from a hand-maintained list.
//
// ── Why this file exists, and why it is not a runtime validator ──────────────
//
// #8942 reported that `validateToolArguments` checks only "is an object" and
// "no unknown keys", so every `z.enum(...)`, `.min()` and `.max()` across the
// catalogue is "decorative at runtime". The first half is literally true. The
// conclusion is not, and the difference matters enough to record here, because
// the obvious fix is actively harmful.
//
// Measured across all 210 tools by generating a schema-violating value for
// every declared constraint and dispatching it (448 constraints checked; 74
// tools skipped because they cannot run without live bindings):
//
//   * **ZERO enum constraints were unenforced.** Every categorical is already
//     rejected, by a hand-written guard in its handler.
//   * **101 numeric/type constraints were "unenforced" — and all 101 are
//     `limit` (or `recent_events_limit`).** Those handlers deliberately CLAMP:
//     `limit: 999` becomes the cap, `limit: 0` and `limit: "abc"` fall back to
//     the default. Existing tests assert exactly that ("clamps the limit",
//     "limit:0 falls back to the default", "malformed limit values fall back to
//     the default").
//
// So a generic schema validator at dispatch would have rejected seven
// deliberate, tested, forgiving behaviours that live callers depend on, and
// changed 52 handler-written error messages, in exchange for zero new safety.
// It was written, measured against the suite, and deleted.
//
// What is left is the property actually worth protecting: a NEW tool that
// publishes an enum and forgets its guard would silently match nothing instead
// of erroring (the defect #9013 fixed for `list_subnets`). This file makes that
// impossible to land, and it needs no maintenance — the cases come from
// `listToolDefinitions()`, so a tool registered tomorrow is covered tonight.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleMcpRequest, listToolDefinitions } from "../src/mcp-server.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

const env = createLocalArtifactEnv() as unknown as Env;

async function errorCode(
  name: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  const response = await handleMcpRequest(
    new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env,
    {},
  );
  const body = (await response.json()) as Row;
  return ((body?.result?.structuredContent as Row)?.error as Row)?.code ?? null;
}

/** Arguments that satisfy every `required` key, so a probe isolates the one
 * constraint under test instead of tripping a missing-argument guard. */
function baselineArgs(schema: Row, except?: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const key of (schema?.required as string[]) ?? []) {
    if (key === except) continue;
    const prop = (schema?.properties as Row)?.[key] as Row | undefined;
    const type = Array.isArray(prop?.type) ? prop?.type[0] : prop?.type;
    const values = prop?.enum as unknown[] | undefined;
    args[key] = values?.length
      ? values[0]
      : type === "string"
        ? "1"
        : type === "array"
          ? [1]
          : 1;
  }
  return args;
}

describe("published MCP enums are enforced at runtime (#8942)", () => {
  // A tool that cannot run at all in this env would "fail" any probe for the
  // wrong reason, so it is skipped rather than counted — the same control that
  // turned an unreviewable 234-item finding into the real 101.
  async function isRunnable(tool: Row): Promise<boolean> {
    const code = await errorCode(
      tool.name as string,
      baselineArgs(tool.inputSchema as Row),
    );
    return code === null || code === "invalid_params";
  }

  test("every enum-valued argument rejects an out-of-enum value", async () => {
    const unenforced: string[] = [];
    let checked = 0;

    for (const tool of listToolDefinitions() as Row[]) {
      const properties = (tool.inputSchema as Row)?.properties as
        Row | undefined;
      if (!properties) continue;

      const enumKeys = Object.entries(properties).filter(
        ([, prop]) =>
          Array.isArray((prop as Row)?.enum) && (prop as Row).enum.length,
      );
      if (enumKeys.length === 0) continue;
      if (!(await isRunnable(tool))) continue;

      for (const [key] of enumKeys) {
        checked++;
        const args = baselineArgs(tool.inputSchema as Row, key);
        args[key] = "__definitely_not_in_this_enum__";
        const code = await errorCode(tool.name as string, args);
        // The property is REJECTION, not a particular code. `run_saved_query`
        // answers `not_found` for an unknown query_id, which is a better
        // description of that caller's mistake than `invalid_params` would be
        // — insisting on one code would be asserting a house style, not a
        // safety property. What must never happen is silent acceptance: the
        // value reaching a handler that matches nothing and returns a
        // confidently empty result (the #9013 defect).
        if (code === null) {
          unenforced.push(
            `${tool.name}.${key} silently ACCEPTED an out-of-enum value`,
          );
        }
      }
    }

    assert.ok(checked > 20, `expected to probe real enums, checked ${checked}`);
    assert.deepEqual(
      unenforced,
      [],
      "these tools publish an enum but do not enforce it, so an out-of-enum " +
        "value silently matches nothing instead of erroring — add a guard in " +
        "the handler (see #9013 for the shape):\n" +
        unenforced.join("\n"),
    );
  }, 120_000);

  // The counterpart, stated as a rule rather than a list of 42 tool names: a
  // numeric bound on a pagination argument is ADVISORY, and the server clamps
  // instead of rejecting. Pinned so the forgiving behaviour cannot be
  // "tightened" into a breaking change without this failing first.
  test("numeric pagination bounds are advisory — the server clamps, never rejects", async () => {
    for (const [tool, args] of [
      ["get_chain_serving", { limit: 999_999 }],
      ["get_subnet_movers", { limit: 0 }],
      ["list_global_validators", { limit: "not-a-number" }],
      // `offset` is the OTHER pagination bound and clamps the same way -- a
      // non-numeric one resolves to 0 and the response reports `offset: 0`, so
      // the caller can see what was used. It was left out of this pin
      // originally, which made 9 tools look like unenforced type constraints
      // when they were the documented leniency wearing a different name.
      ["get_sudo", { limit: 2, offset: "not-a-number" }],
      ["list_blocks", { limit: 2, offset: -5 }],
    ] as [string, Record<string, unknown>][]) {
      const code = await errorCode(tool, args);
      assert.notEqual(
        code,
        "invalid_params",
        `${tool} rejected an out-of-range limit; it is supposed to clamp. ` +
          "If this is now a deliberate contract change, the published schema " +
          "and the forgiving-limit tests have to change with it.",
      );
    }
  }, 60_000);

  // The third constraint class, and the last one without a gate. #8942's audit
  // covered enums (zero gaps) and numeric bounds (all 101 "gaps" were the
  // deliberate pagination clamping pinned above). `required` was never probed.
  //
  // Measured before writing this: 90 required arguments across every runnable
  // tool, ZERO silently accepted when omitted. So this fixes nothing today --
  // it is the same bet the enum test makes, that a tool registered tomorrow
  // declares `required` and forgets its guard, and then answers a confidently
  // empty result for a caller who supplied nothing (the #9013 shape).
  //
  // Derived from listToolDefinitions() like its sibling, so it needs no
  // maintenance and a tool added tonight is covered tonight.
  test("every required argument is rejected when omitted", async () => {
    const silent: string[] = [];
    let checked = 0;

    for (const tool of listToolDefinitions() as Row[]) {
      const schema = tool.inputSchema as Row;
      const required = (schema?.required as string[]) ?? [];
      if (required.length === 0) continue;
      if (!(await isRunnable(tool))) continue;

      for (const key of required) {
        checked++;
        const code = await errorCode(
          tool.name as string,
          baselineArgs(schema, key),
        );
        // Rejection is the property, not a particular code -- same reasoning as
        // the enum test: a tool may describe the caller's mistake better than
        // `invalid_params` does. Silent acceptance is what must never happen.
        if (code === null) {
          silent.push(`${tool.name}.${key} silently ACCEPTED being omitted`);
        }
      }
    }

    assert.ok(
      checked > 50,
      `expected to probe real required args, checked ${checked}`,
    );
    assert.deepEqual(
      silent,
      [],
      "these tools publish a required argument but do not enforce it, so a " +
        "call that omits it reaches the handler with undefined instead of " +
        "erroring -- add a guard (requireNonNegativeInt / requireString or " +
        "equivalent) in the handler:\n" +
        silent.join("\n"),
    );
  }, 120_000);
});
