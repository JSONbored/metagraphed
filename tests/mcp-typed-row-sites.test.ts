// Five MCP object sites typed from the routes they mirror (#9797).
//
// The rule that makes this safe is the one #9884 established the hard way: a
// tool advertising `fields` must accept a PROJECTED row, so its row schema is
// partial. A tool with no `fields` parameter has no caller who can drop a
// field, so its schema is not.
//
// Each of the five was validated against live production before switching --
// whole AND projected -- because deriving is a TIGHTENING.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { listToolDefinitions } from "../src/mcp-server.ts";
import { NeuronSchema } from "../schemas-src/routes/subnet-metagraph.ts";
import type { Row } from "./row-type.ts";

function toolSchemas(name: string): { input: Row; output: Row } {
  const def = listToolDefinitions().find(
    (tool) => (tool as Row).name === name,
  ) as Row;
  return { input: def.inputSchema as Row, output: def.outputSchema as Row };
}

/** The declared object schema at a site, following an array/nullable wrapper. */
function siteSchema(output: Row, key: string): Row {
  const property = (output.properties as Row)[key] as Row;
  if (property.type === "array") return property.items as Row;
  const branches = (property.anyOf ?? property.oneOf) as Row[] | undefined;
  return branches?.find((branch) => branch.type === "object") ?? property;
}

const ROW_SITES: Array<[tool: string, key: string, projectable: boolean]> = [
  ["get_subnet_metagraph", "neurons", true],
  ["get_neuron", "neuron", true],
  ["list_subnet_validators", "validators", true],
  ["get_block", "block", false],
  ["get_extrinsic", "extrinsic", false],
];

describe("typed row sites (#9797)", () => {
  test("none of the five is an untyped blob any more", () => {
    for (const [tool, key] of ROW_SITES) {
      const site = siteSchema(toolSchemas(tool).output, key);
      const properties = Object.keys((site.properties ?? {}) as Row);
      assert.ok(
        properties.length > 3,
        `${tool}.${key} declares only ${properties.length} propert(ies) -- still effectively open`,
      );
    }
  });

  test("a projectable site declares NO required properties, an unprojectable one may", () => {
    // This is the invariant, stated once. A `fields`-capable tool whose row
    // schema requires anything breaks its own contract the moment a caller
    // uses the parameter it advertises -- 25 tools did exactly that (#9884).
    for (const [tool, key, projectable] of ROW_SITES) {
      const { input, output } = toolSchemas(tool);
      const advertisesFields = Boolean((input.properties as Row).fields);
      assert.equal(
        advertisesFields,
        projectable,
        `${tool}: the table above disagrees with the tool's own inputSchema`,
      );
      const required = (siteSchema(output, key).required ?? []) as string[];
      if (projectable) {
        assert.deepEqual(
          required,
          [],
          `${tool}.${key} advertises \`fields\` but requires ${required.join(", ")}`,
        );
      }
    }
  });

  test("the neuron sites carry NeuronSchema's own field names, not a restatement", () => {
    // Derived, so a route field rename lands here as a compile error rather
    // than as silent production drift. Compared as a SET against the schema
    // rather than against a copied list, which would defeat the derivation on
    // the first field added.
    const expected = Object.keys(NeuronSchema.shape).sort();
    for (const tool of [
      "get_subnet_metagraph",
      "get_neuron",
      "list_subnet_validators",
    ]) {
      const key =
        tool === "get_neuron"
          ? "neuron"
          : tool === "get_subnet_metagraph"
            ? "neurons"
            : "validators";
      const site = siteSchema(toolSchemas(tool).output, key);
      assert.deepEqual(
        Object.keys((site.properties ?? {}) as Row).sort(),
        expected,
        `${tool}.${key} has drifted from NeuronSchema`,
      );
    }
  });

  test("a projected row still satisfies the published schema", () => {
    // The regression #9884 fixed, pinned at the three sites this PR types.
    const ajv = new Ajv2020({ strict: false });
    for (const [tool, key] of ROW_SITES.filter(([, , p]) => p)) {
      const output = toolSchemas(tool).output;
      const validate = ajv.compile(output);
      const projectedRow = { uid: 3 };
      const payload: Row =
        key === "neuron"
          ? {
              schema_version: 1,
              netuid: 1,
              captured_at: null,
              block_number: null,
              neuron: projectedRow,
            }
          : {
              schema_version: 1,
              netuid: 1,
              [key === "neurons" ? "neuron_count" : "validator_count"]: 1,
              captured_at: null,
              block_number: null,
              [key]: [projectedRow],
            };
      assert.ok(
        validate(payload),
        `${tool}: a one-field projection was rejected -- ${JSON.stringify(validate.errors?.slice(0, 2))}`,
      );
    }
  });

  test("the debt list no longer claims these are untyped", () => {
    // A gate entry that outlives its defect is the failure mode the
    // stale-entry check exists for; this asserts the same thing from the
    // other direction, at the five sites this PR closes.
    const list = new Set(
      ROW_SITES.map(([tool, key, projectable]) =>
        projectable && key !== "neuron" ? `${tool}.${key}[]` : `${tool}.${key}`,
      ),
    );
    const text = readFileSync("scripts/validate-schema-opacity.ts", "utf8");
    for (const site of list) {
      assert.equal(
        text.includes(`"${site}"`),
        false,
        `${site} is typed now but still listed as NOT_YET_TYPED`,
      );
    }
  });
});
