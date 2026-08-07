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
  ["get_subnet_trajectory", "points", false],
  ["get_adapter", "snapshot", false],
  ["get_economics", "subnets", true],
  ["get_subnet_economics", "economics", false],
  ["get_health_history", "surfaces", true],
  ["get_subnet_health", "summary", false],
  ["get_agent_catalog", "subnets", false],
  ["list_subnet_apis", "services", false],
  ["get_account", "activity", false],
  ["get_account_counterparties", "relationship", false],
  ["compare_validators", "validators", false],
  ["list_profiles", "profiles", true],
  ["get_domain_summary", "domains", false],
  ["get_subnet_gaps", "priorities", false],
  ["list_search", "documents", true],
  ["list_subnet_health", "surfaces", false],
  ["how_do_i_call", "services", false],
  ["find_subnet_for_task", "results", false],
  ["list_surface_credentials", "credentials", false],
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

  test("a projected neuron row still satisfies the published schema", () => {
    // The regression #9884 fixed, pinned end to end on the three tools whose
    // ENVELOPE this synthetic payload models. The other projectable sites are
    // covered by the requiredness invariant above plus the production sweep --
    // building a per-tool envelope here would be restating each output schema
    // in the test, which is the duplication this whole epic removes.
    const NEURON_ENVELOPES = new Set([
      "get_subnet_metagraph",
      "get_neuron",
      "list_subnet_validators",
    ]);
    const ajv = new Ajv2020({ strict: false });
    for (const [tool, key] of ROW_SITES.filter(
      ([t, , p]) => p && NEURON_ENVELOPES.has(t),
    )) {
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
  test("get_subnet_trajectory declares its deltas as a TYPED record", () => {
    // `deltas` is keyed by window label, so a new window must add a key rather
    // than change the contract -- a typed record says that, an untyped object
    // says nothing. The route already carried the load-bearing note that these
    // values are DIFFERENCES, not levels; an agent reading only the tool could
    // not have known it.
    const output = toolSchemas("get_subnet_trajectory").output;
    const deltas = (output.properties as Row).deltas as Row;
    const value = deltas.additionalProperties as Row;
    assert.ok(
      value && typeof value === "object",
      "deltas declares no value schema",
    );
    const branches = (value.anyOf ?? value.oneOf ?? [value]) as Row[];
    const object = branches.find((b) => b.type === "object") as Row;
    assert.ok(
      Object.keys((object?.properties ?? {}) as Row).includes("from_date"),
      "the delta value schema is still open",
    );
  });
  test("the economics summary keeps its rao-precision STRING totals", () => {
    // The TAO totals are decimal strings with exactly nine places, not
    // numbers. A caller reading them as floats loses rao -- and `{"type":
    // "object"}` did not even say which fields they were.
    for (const tool of ["get_economics", "get_subnet_economics"]) {
      const summary = siteSchema(toolSchemas(tool).output, "summary");
      const total = (summary.properties as Row).total_stake_alpha as Row;
      assert.equal(
        total.type,
        "string",
        `${tool}.summary.total_stake_alpha is not published as a string`,
      );
      assert.ok(
        total.pattern,
        `${tool}.summary declares no rao-precision pattern`,
      );
    }
  });
  test("the #9797 debt list is EMPTY", () => {
    // The whole point of the epic. `validate:schema-opacity` still allows
    // reasoned-open sites -- an embedded third-party document, decoded chain
    // arguments -- but nothing is left carrying NOT_YET_TYPED, which was 33
    // sites at the start of 2026-08-07.
    const text = readFileSync("scripts/validate-schema-opacity.ts", "utf8");
    const block = text.slice(
      text.indexOf("const MCP_NOT_YET_TYPED"),
      text.indexOf("/** MCP sites that are open on purpose"),
    );
    const entries = [...block.matchAll(/"[^"]+"/g)];
    assert.deepEqual(
      entries.map((m) => m[0]),
      [],
      "MCP_NOT_YET_TYPED is no longer empty -- a new untyped site was added rather than declared with a reason",
    );
  });
});
