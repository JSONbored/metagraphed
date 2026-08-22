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
import {
  AUTH_REQUIRED_TOOL_NAMES,
  handleMcpRequest,
  listToolDefinitions,
} from "../src/mcp-server.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

const env = createLocalArtifactEnv() as unknown as Env;

/** A real finney address, for probes that must get PAST address validation. */
const VALID_SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

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
    // #11563: a tool that needs an identity now gets a transport-level 401
    // BEFORE argument validation runs. Probing those anonymously would report
    // "silently accepted" for arguments that are in fact enforced -- a false
    // negative that would quietly stop this gate checking three tools.
    //
    // So the probe carries an identity when, and only when, the tool declares
    // it needs one. That reaches the argument guards rather than weakening the
    // gate to treat 401 as a pass, which would have been the easy fix and the
    // wrong one.
    AUTH_REQUIRED_TOOL_NAMES.has(name)
      ? { executionCtx: { waitUntil() {}, props: { accountId: 7 } } }
      : {},
  );
  const body = (await response.json()) as Row;
  return ((body?.result?.structuredContent as Row)?.error as Row)?.code ?? null;
}

/** The refusal's human sentence, for the tests that pin its CONTENT --
 * the window vocabulary test asserts the message lists the published enum,
 * which the code-only helper above cannot see. */
async function errorMessage(
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
  return (
    (((body?.result?.structuredContent as Row)?.error as Row)
      ?.message as string) ?? null
  );
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

async function isRunnable(tool: Row): Promise<boolean> {
  const code = await errorCode(
    tool.name as string,
    baselineArgs(tool.inputSchema as Row),
  );
  return code === null || code === "invalid_params";
}

describe("published MCP enums are enforced at runtime (#8942)", () => {
  // A tool that cannot run at all in this env would "fail" any probe for the
  // wrong reason, so it is skipped rather than counted — the same control that
  // turned an unreviewable 234-item finding into the real 101.

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

  // The dispatch clamp is MARKER-driven now (`x-serving-bound`), not
  // name-keyed to `limit` -- the same declaration the GraphQL dispatch reads.
  // Both directions have to hold: a marked bound clamps at dispatch (an
  // over-ceiling `offset` answers with the ceiling applied, one mechanism
  // earlier than the handler clamp that always caught it), and an UNMARKED
  // `maximum` -- `netuid`'s validity bound -- must never clamp, because
  // subnet 65535 is not the subnet the caller asked about.
  test("the dispatch clamp reads the serving-bound marker, both directions", async () => {
    const clamped = await errorCode("list_blocks", {
      limit: 2,
      offset: 99_999_999,
    });
    assert.notEqual(
      clamped,
      "invalid_params",
      "a marked serving bound must clamp at dispatch, not reject",
    );
    // The property is REJECTION, not a particular code (the enum test's own
    // doctrine above): what must never happen is the unmarked bound clamping
    // into a successful answer about subnet 65535.
    const rejected = await errorCode("get_subnet", { netuid: 99_999 });
    assert.notEqual(
      rejected,
      null,
      "an unmarked validity bound must reject -- clamping answers a question " +
        "the caller did not ask",
    );
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
        // `context` is the ONE advertised-required argument that is
        // deliberately unenforced — @posthog/mcp's own intent design, adopted
        // by withAdvertisedRequiredIntent: a schema-following agent supplies
        // intent on every call, and a caller that omits it must never be
        // rejected (it is analytics metadata, not tool input). The safe
        // direction of the divergence this gate exists to catch: the server
        // accepts MORE than it advertises, so no caller is ever harmed. Both
        // halves are pinned in tests/mcp-usage-telemetry.test.ts ("context is
        // advertised required" / "a call without context is still accepted").
        if (key === "context") continue;
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

describe("a tool that advertises `fields` publishes projectable rows (#10064)", () => {
  // Found by a PRODUCTION sweep, which is the wrong place to find it.
  //
  // `?fields=auth_required` returns rows carrying ONLY that key. Four tools
  // published their route's whole artifact schema, which requires every
  // property on a row, so the projected answer failed the tool's own published
  // schema: 1,060 violations across get_subnet_endpoints, get_subnet_candidates,
  // get_subnet_surfaces and get_coverage_depth. A generated client validating
  // the response would reject data the server considers correct.
  //
  // conformance:mcp catches this, but only against production and only out of
  // band -- #9884 is the same failure, and the same gap let it recur. The rule
  // is decidable offline from the EMITTED schemas alone: if a tool takes
  // `fields`, any subset of a row is a legal answer, so no row property may be
  // required. `projectableRows()` is how the sibling tools say that.
  test("no fields-capable tool requires properties on a row it can project", () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const tool of listToolDefinitions() as Row[]) {
      const input = tool.inputSchema as Row | undefined;
      if (!(input?.properties as Row)?.fields) continue;
      checked += 1;
      for (const [key, value] of Object.entries(
        ((tool.outputSchema as Row)?.properties ?? {}) as Row,
      )) {
        const node = value as Row;
        const items = node?.items as Row | undefined;
        const required = (items?.required ?? []) as string[];
        if (
          node?.type === "array" &&
          items?.type === "object" &&
          required.length
        ) {
          offenders.push(`${tool.name}.${key} requires ${required.length}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "these answer a `fields` request with rows that fail their own published " +
        `schema — wrap the row array in projectableRows(): ${offenders.join(", ")}`,
    );
    assert.ok(checked >= 30, `only ${checked} fields-capable tools found`);
  });
});

describe("published string constraints are enforced at runtime (#10065)", () => {
  // The constraint class #8942's audit never covered. It measured enums (zero
  // gaps) and numeric bounds (all of which were the deliberate pagination
  // clamping); `pattern` and `maxLength` were probed for the first time here.
  //
  // Four gaps, all the same shape: the tool ADVERTISES the constraint and the
  // handler ignored it, so a malformed value filtered to nothing and answered
  // 200 with an empty page. An agent that typos a hotkey was told the chain
  // has no such activity rather than that it mistyped — the #9013 defect,
  // wearing a pattern instead of an enum.
  //
  //   list_blocks.author        SS58 pattern, unenforced
  //   list_extrinsics.signer    SS58 pattern, unenforced
  //   list_extrinsics.call_hash 0x-hash pattern, unenforced
  //   list_extrinsics.call_module  maxLength 100, unenforced
  //
  // Derived from listToolDefinitions() like its siblings, so a tool that
  // publishes a pattern tomorrow is covered tonight.
  test("every published pattern and maxLength rejects a violating value", async () => {
    const unenforced: string[] = [];
    let checked = 0;

    for (const tool of listToolDefinitions() as Row[]) {
      const properties = (tool.inputSchema as Row)?.properties as
        Row | undefined;
      if (!properties) continue;
      if (!(await isRunnable(tool))) continue;

      for (const [key, raw] of Object.entries(properties)) {
        const property = raw as Row;
        // An enum already has its own gate above, and a violating value for it
        // is the same probe — no reason to count it twice.
        if (Array.isArray(property.enum)) continue;
        let violating: string | null = null;
        if (typeof property.pattern === "string") {
          violating = "!!!definitely-not-matching-any-pattern!!!";
        } else if (typeof property.maxLength === "number") {
          violating = "x".repeat(property.maxLength + 50);
        }
        if (violating === null) continue;
        checked += 1;
        const args = baselineArgs(tool.inputSchema as Row, key);
        args[key] = violating;
        if ((await errorCode(tool.name as string, args)) === null) {
          unenforced.push(
            `${tool.name}.${key} silently ACCEPTED a value its own schema forbids`,
          );
        }
      }
    }

    // 51 today. Lower than the 129 the schemas declare, because `isRunnable`
    // skips the tools that need live bindings and enums are left to the gate
    // above — the floor guards against the probe silently reaching nothing,
    // not against the catalogue changing size.
    assert.ok(
      checked > 40,
      `expected to probe real constraints, got ${checked}`,
    );
    assert.deepEqual(
      unenforced,
      [],
      "these publish a `pattern` or `maxLength` and do not enforce it, so a " +
        "malformed value filters to nothing and returns a confidently empty " +
        `page instead of an error:\n${unenforced.join("\n")}`,
    );
  }, 180_000);
});

describe("a published `limit` says what omitting it does (#10101)", () => {
  // 83 of the 97 tools that publish a `limit` declared no `default`, so a
  // caller could read the schema and still not know how many rows an omitted
  // `limit` returns. The server always applied one; it just never said which.
  //
  // The two exceptions are real: `get_subnet_metagraph` and
  // `list_subnet_validators` read their limit with `optionalPositiveInt` and
  // apply NO default -- omitting it returns everything. Publishing an invented
  // number there would be the same lie in the other direction, so they are
  // named rather than defaulted, and a stale entry FAILS.
  const NO_DEFAULT_APPLIED: Record<string, string> = {
    get_subnet_metagraph:
      "optionalPositiveInt with no fallback -- an omitted limit returns the " +
      "whole metagraph, so there is no default to publish",
    list_subnet_validators:
      "optionalPositiveInt with no fallback -- the limit is an MCP-side " +
      "post-filter, absent means unfiltered",
  };

  test("every tool publishing a limit publishes the default it applies", () => {
    const missing: string[] = [];
    const suppressed = new Set<string>();
    let checked = 0;

    for (const tool of listToolDefinitions() as Row[]) {
      const limit = ((tool.inputSchema as Row)?.properties as Row)?.limit as
        Row | undefined;
      if (!limit) continue;
      checked += 1;
      if (limit.default !== undefined) continue;
      if ((tool.name as string) in NO_DEFAULT_APPLIED) {
        suppressed.add(tool.name as string);
        continue;
      }
      missing.push(tool.name as string);
    }

    const stale = Object.keys(NO_DEFAULT_APPLIED).filter(
      (name) => !suppressed.has(name),
    );
    assert.deepEqual(
      stale,
      [],
      `these now publish a default, so remove them from NO_DEFAULT_APPLIED: ${stale.join(", ")}`,
    );
    assert.deepEqual(
      missing,
      [],
      "these publish a `limit` without saying what omitting it does — pass the " +
        "fallback the handler applies to limitSchema(max, fallback), or attach " +
        `it with .meta({ default }): ${missing.join(", ")}`,
    );
    assert.ok(checked > 90, `only ${checked} tools publish a limit`);
  });
});

describe("a window rejection names exactly the published vocabulary (#10973)", () => {
  // Ten guards restated their vocabulary in prose ("window must be one of:
  // 7d, 30d.") -- all ten agreed with their enums, so nothing was broken, but
  // adding a window would have left the guard right and the sentence lying.
  // The guards now build the message from the vocabulary they check
  // (requireWindowArgument / requireEnumArgument), and this pins the claim the
  // enum-enforcement suite above does not make: not just THAT an out-of-enum
  // window is rejected, but that the refusal LISTS the same values the tool
  // publishes. Derived from listToolDefinitions(), so a window tool added
  // tomorrow is covered tonight.
  test("every runnable tool with a `window` enum lists it in the refusal", async () => {
    const failures: string[] = [];
    let checked = 0;
    for (const tool of listToolDefinitions() as Row[]) {
      const properties = (tool.inputSchema as Row)?.properties as
        Row | undefined;
      const windowEnum = (properties?.window as Row | undefined)?.enum as
        string[] | undefined;
      if (!windowEnum?.length) continue;
      if (!(await isRunnable(tool))) continue;
      checked++;
      const args = baselineArgs(tool.inputSchema as Row, "window");
      // baselineArgs fills strings with "1", which fails SS58 validation
      // BEFORE the window guard runs -- give the address-shaped keys a real
      // address so the probe reaches the constraint under test.
      for (const key of ["ss58", "hotkey", "coldkey"]) {
        if (key in args) args[key] = VALID_SS58;
      }
      args.window = "__not_a_window__";
      const message = await errorMessage(tool.name as string, args);
      // The exact joined vocabulary, not a per-value scan: a message listing
      // the values in the published order is the claim; a message listing a
      // SUPERSET would pass a per-value scan and still lie.
      if (!message?.includes(windowEnum.join(", "))) {
        failures.push(
          `${tool.name}: published [${windowEnum.join(", ")}], refused with ${JSON.stringify(message)}`,
        );
      }
      // The other half of the same claim: the guard ACCEPTS its own published
      // values. A guard that refused everything would pass the probe above.
      args.window = windowEnum[0];
      const acceptedCode = await errorCode(tool.name as string, args);
      if (acceptedCode === "invalid_params") {
        failures.push(
          `${tool.name}: rejected its own published window ${JSON.stringify(windowEnum[0])}`,
        );
      }
      // And the published DEFAULT: omitting `window` must never be a window
      // error -- the schema says the argument is optional.
      delete args.window;
      const defaultedCode = await errorCode(tool.name as string, args);
      if (defaultedCode === "invalid_params") {
        failures.push(`${tool.name}: rejected an omitted window`);
      }
      // An EXPLICIT null is the one absent-shape dispatch does not fill with
      // the schema default (defaults are injected only for missing keys), so
      // it is the path that reaches the handler-side fallback. It must mean
      // "use the default", never a rejection.
      args.window = null;
      const nulledCode = await errorCode(tool.name as string, args);
      if (nulledCode === "invalid_params") {
        failures.push(`${tool.name}: rejected an explicit null window`);
      }
    }
    assert.ok(checked >= 40, `expected the window surface, probed ${checked}`);
    assert.deepEqual(failures, []);
  });
});
