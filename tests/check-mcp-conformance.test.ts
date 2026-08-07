// The MCP production conformance check (#9879).
//
// The TRANSPORT needs production; the two decisions it makes do not, and a
// decision nobody can test offline is a decision nobody checks. So the
// argument-building rules and the schema comparison are exercised here, and
// only the sweep loop itself is left to the scheduled workflow.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  buildToolArguments,
  declaredExample,
  projectableFieldFrom,
  projectionArgumentFor,
  requiredArgumentNames,
} from "../scripts/mcp-tool-arguments.ts";
import {
  formatReport,
  violationsFor,
  type ConformanceReport,
} from "../scripts/check-mcp-conformance.ts";
import { listToolDefinitions } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

describe("argument building is shared with validate:mcp (#9879)", () => {
  test("a presence-only oneOf contributes one side of the choice", () => {
    // get_neuron's real shape: EITHER uid OR hotkey, so neither can sit in
    // `required` -- and a sweep reading only `required` would call it with no
    // identifier and read its correct rejection as a broken contract.
    const schema = {
      required: ["netuid"],
      oneOf: [{ required: ["uid"] }, { required: ["hotkey"] }],
    };
    assert.deepEqual(requiredArgumentNames(schema), ["netuid", "uid"]);
  });

  test("a VALUE-conditional branch is left alone", () => {
    // get_feed's real shape. Following it produced `{kind: "registry",
    // netuid: 64}`, which the server rightly refuses -- resolving the choice
    // needs the condition, not just the requirement.
    const schema = {
      required: ["kind"],
      anyOf: [
        {
          properties: { kind: { const: "subnet" } },
          required: ["kind", "netuid"],
        },
        {
          properties: { kind: { enum: ["registry", "incidents"] } },
          not: { required: ["netuid"] },
        },
      ],
    };
    assert.deepEqual(requiredArgumentNames(schema), ["kind"]);
  });

  test("an example is found through anyOf, and its absence is reported not thrown", () => {
    assert.deepEqual(
      declaredExample({ anyOf: [{ type: "null" }, { examples: [7] }] }),
      { found: true, value: 7 },
    );
    const { args, undocumented } = buildToolArguments({
      required: ["netuid", "slug"],
      properties: { netuid: { examples: [64] }, slug: { type: "string" } },
    });
    assert.deepEqual(args, { netuid: 64 });
    assert.deepEqual(undocumented, ["slug"]);
  });
});

describe("the `fields` projection argument matches each tool's own shape", () => {
  test("array-typed tools get an array, string-typed tools get a string", () => {
    assert.deepEqual(
      projectionArgumentFor(
        { properties: { fields: { type: "array" } } },
        "uid",
      ),
      ["uid"],
    );
    assert.equal(
      projectionArgumentFor(
        { properties: { fields: { type: "string" } } },
        "uid",
      ),
      "uid",
    );
    // A nullable array is published as type: ["array","null"].
    assert.deepEqual(
      projectionArgumentFor(
        { properties: { fields: { type: ["array", "null"] } } },
        "uid",
      ),
      ["uid"],
    );
  });

  test("every live tool's shape is derivable, and both shapes really exist", () => {
    // The first version of the check sent an array to all of them and 27 tools
    // answered invalid_params -- which read exactly like "these tools serve no
    // rows", the report this check exists to make trustworthy. Asserting BOTH
    // shapes are present keeps this test from passing vacuously if the enum
    // ever collapses to one.
    const shapes = new Set<string>();
    for (const tool of listToolDefinitions() as Row[]) {
      const properties = ((tool.inputSchema as Row)?.properties ?? {}) as Row;
      if (!properties.fields) continue;
      const argument = projectionArgumentFor(tool.inputSchema as Row, "uid");
      shapes.add(Array.isArray(argument) ? "array" : "string");
    }
    assert.deepEqual([...shapes].sort(), ["array", "string"]);
  });

  test("a field name is taken off the response, including the single-row shape", () => {
    assert.equal(
      projectableFieldFrom({ items: [{ uid: 1, hotkey: "x" }] }),
      "uid",
    );
    // get_neuron returns one row under `neuron`, not a collection.
    assert.equal(projectableFieldFrom({ neuron: { uid: 1 } }), "uid");
    // No rows is a real answer -- it means the projection is unexercisable,
    // which the report names rather than counting as a pass.
    assert.equal(projectableFieldFrom({ items: [] }), null);
    assert.equal(projectableFieldFrom(undefined), null);
  });
});

describe("violations are reported against the published schema", () => {
  const schema = {
    type: "object",
    properties: {
      degraded: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
    required: ["degraded"],
  };

  test("a conforming response yields nothing", () => {
    assert.deepEqual(
      violationsFor(schema, { degraded: { reason: "x" } }, "t", "plain"),
      [],
    );
  });

  test("a violation carries the tool, the call and the path", () => {
    const found = violationsFor(schema, {}, "get_x", "projected:uid");
    assert.equal(found.length, 1);
    assert.equal(found[0].tool, "get_x");
    assert.equal(found[0].call, "projected:uid");
    assert.match(found[0].message, /degraded/);
  });
});

describe("the report is legible on a clean run and on a failing one", () => {
  const base: ConformanceReport = {
    checked: 219,
    projectionChecked: 32,
    projectionUnexercised: [],
    declined: [],
    undocumented: [],
    violations: [],
  };

  test("a clean run says so in words, not by silence", () => {
    const text = formatReport(base);
    assert.match(text, /219/);
    assert.match(text, /No response violated the schema it publishes/);
  });

  test("violations are listed individually, not counted", () => {
    const text = formatReport({
      ...base,
      violations: [
        { tool: "get_x", call: "plain", path: "/degraded", message: "boom" },
      ],
    });
    assert.match(text, /1 SCHEMA VIOLATION/);
    assert.match(text, /get_x \[plain\] \/degraded: boom/);
  });

  test("an unexercised projection is NAMED, so it cannot hide in a count", () => {
    const text = formatReport({ ...base, projectionUnexercised: ["list_y"] });
    assert.match(text, /projection unexercised.*list_y/);
  });
});

describe("the scheduled workflow that runs it (#9879)", () => {
  const workflow = readFileSync(
    ".github/workflows/check-mcp-conformance.yml",
    "utf8",
  );

  test("is actually scheduled, which is the whole point of the issue", () => {
    // The defect being closed is a check that existed and ran nowhere. A test
    // that only asserted the script works would reproduce it exactly.
    assert.match(workflow, /^\s+- cron: /m);
    assert.match(workflow, /workflow_dispatch/);
  });

  test("runs the checker rather than the noisy triage sweep", () => {
    // mcp-smoke-sweep.ts is a TRIAGE list where a SUSPECT flag never fails;
    // this workflow must run the check that fails on a schema violation.
    assert.match(workflow, /scripts\/check-mcp-conformance\.ts/);
    assert.equal(workflow.includes("mcp-smoke-sweep"), false);
  });

  test("does not mask a failure", () => {
    assert.equal(/continue-on-error:\s*true/.test(workflow), false);
  });
});
