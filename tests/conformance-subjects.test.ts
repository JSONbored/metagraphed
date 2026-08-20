// The subjects both API sweeps call with (#10312).
//
// This file exists because a REQUIRED ARGUMENT SILENTLY DELETED A WHOLE
// SURFACE. #9644 made `context` required on all 242 MCP tools to capture agent
// intent; both sweeps skip any tool naming a required argument they have no
// subject for, so from that commit on they skipped every tool. Neither said so
// -- `check-operation-latency` printed `rest: 217 timed` and `graphql: 200
// timed`, no mcp line, and a clean report.
//
// The damage was not just missing coverage. That sweep retires an exemption
// when its read comes in "comfortably under budget on EVERY surface", and a
// surface nobody asked cannot be over budget -- so it began recommending the
// deletion of exemptions on two thirds of the evidence.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  SUBJECTS,
  SWEEP_CONTEXT,
  argumentsForRequired,
  toolArguments,
} from "../scripts/conformance-subjects.ts";

describe("the argument every MCP tool requires", () => {
  test("a tool requiring only `context` is askable", () => {
    // 107 of the 242 live tools have exactly this required list. Before the
    // fix this returned null, and those 107 were never called.
    const args = argumentsForRequired(["context"]);
    assert.notEqual(args, null, "a tool requiring only context must be asked");
    assert.equal(args?.context, SWEEP_CONTEXT);
  });

  test("a tool requiring `context` alongside a subject is askable", () => {
    // The next 74: required = ["context", "netuid"].
    const args = argumentsForRequired(["context", "netuid"]);
    assert.deepEqual(args, { context: SWEEP_CONTEXT, netuid: SUBJECTS.netuid });
  });

  test("the route-template entry point supplies it too", () => {
    // `context` is not a path placeholder, so it can never come from the
    // template -- which is how the cross-surface sweep lost its MCP half
    // while still looking like it was calling the tools.
    const args = toolArguments("/api/v1/subnets/{netuid}");
    assert.equal(args.context, SWEEP_CONTEXT);
    assert.equal(args.netuid, SUBJECTS.netuid);
  });

  test("an argument with no subject is still refused", () => {
    // The control. The skip is CORRECT behaviour -- calling a tool with a
    // made-up subject and reporting the decline as slowness is the failure it
    // prevents. The bug was never the skip, it was having no subject for an
    // argument every tool had started requiring.
    assert.equal(argumentsForRequired(["context", "no_such_subject"]), null);
  });

  test("the context we send says what it actually is", () => {
    // It is "analytics only; does not affect the result", so nothing depends
    // on it being convincing -- and ~440 calls a run of a fabricated user goal
    // would poison the telemetry the argument was added to collect.
    assert.match(SWEEP_CONTEXT, /sweep/i);
    assert.match(SWEEP_CONTEXT, /not a user request/i);
  });
});
