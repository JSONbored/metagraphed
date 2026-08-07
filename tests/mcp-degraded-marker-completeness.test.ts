// The dispatch-level `degraded` stamp must satisfy the tool's own schema
// (#9910), and query_graphql's `data` must accept the null GraphQL requires
// (#9911).
//
// Both were found by the out-of-band production conformance sweep (#9879) and
// confirmed against live production on 2026-08-07, which is the point: neither
// was visible to CI. The hermetic harness never degrades a tier mid-call, and
// nothing had ever validated a FAILED GraphQL query against the schema the tool
// publishes for it.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  completeDegradedBlock,
  listToolDefinitions,
} from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

function schemaFor(name: string): Row {
  const def = listToolDefinitions().find(
    (tool) => (tool as Row).name === name,
  ) as Row;
  return def.outputSchema as Row;
}

function validates(schema: Row, value: unknown): boolean {
  return new Ajv2020({ strict: false }).compile(schema)(value);
}

describe("completeDegradedBlock (#9910)", () => {
  const positions = () => schemaFor("get_account_positions");

  test("the generic stamp alone FAILS the tool's published schema", () => {
    // The state production was actually in. Asserted first so the fix below is
    // shown to change something -- a negative assertion that passes on nothing
    // proves nothing (#9689).
    const stamped = {
      schema_version: 1,
      ss58: "5GP7c3fFazW9GXK8Up3qgu2DJBk8inu4aK9TZy3RuoSWVCMi",
      // Required at the top level too -- the fixture is the whole card
      // unavailableAccountPositions() builds, not just its degraded block.
      captured_at: null,
      position_count: 0,
      total_stake_alpha: 0,
      positions: [],
      degraded: { reason: "tier_unavailable" },
    };
    assert.equal(validates(positions(), stamped), false);
    // ...and completing it against the same schema fixes exactly that.
    const completed = completeDegradedBlock(stamped, positions()) as Row;
    assert.equal(validates(positions(), completed), true);
    assert.deepEqual(completed.degraded, {
      reason: "tier_unavailable",
      snapshot_captured_at: null,
      latest_stake_event_at: null,
    });
  });

  test("a block the handler already completed is returned untouched", () => {
    const full = {
      degraded: {
        reason: "snapshot_predates_stake_activity",
        snapshot_captured_at: "2026-08-07T00:00:00.000Z",
        latest_stake_event_at: "2026-08-07T12:00:00.000Z",
      },
    };
    // Identity, not deep equality: a rebuilt-but-identical object would still
    // mean the completion runs on every healthy response.
    assert.equal(completeDegradedBlock(full, positions()), full);
  });

  test("a real value is never overwritten with null", () => {
    const partial = {
      degraded: {
        reason: "positions_unpriceable",
        snapshot_captured_at: "2026-08-07T00:00:00.000Z",
      },
    };
    const completed = completeDegradedBlock(partial, positions()) as Row;
    assert.equal(
      (completed.degraded as Row).snapshot_captured_at,
      "2026-08-07T00:00:00.000Z",
    );
    assert.equal((completed.degraded as Row).latest_stake_event_at, null);
  });

  test("a payload with no degraded block is untouched", () => {
    const healthy = { schema_version: 1, positions: [], degraded: null };
    assert.equal(completeDegradedBlock(healthy, positions()), healthy);
    const absent = { schema_version: 1, positions: [] };
    assert.equal(completeDegradedBlock(absent, positions()), absent);
  });

  test("a tool whose degraded requires only `reason` is untouched", () => {
    // The generic stamp is already complete for these, and filling keys their
    // schema does not declare would be inventing fields.
    const stamped = { degraded: { reason: "tier_unavailable" } };
    const schema = {
      type: "object",
      properties: {
        degraded: {
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
        },
      },
    };
    assert.equal(completeDegradedBlock(stamped, schema), stamped);
  });

  test("a required NON-nullable property is left absent rather than invented", () => {
    // There is no honest value for it here, and a visible violation the
    // conformance sweep reports beats a fabricated one it does not.
    const schema = {
      type: "object",
      properties: {
        degraded: {
          type: "object",
          properties: {
            reason: { type: "string" },
            detail: { type: "string" },
          },
          required: ["reason", "detail"],
        },
      },
    };
    const completed = completeDegradedBlock(
      { degraded: { reason: "tier_unavailable" } },
      schema,
    ) as Row;
    assert.equal(Object.hasOwn(completed.degraded as Row, "detail"), false);
  });

  test("a nullable property declared as a type ARRAY is filled too", () => {
    // `{"type": ["string", "null"]}` and `{"anyOf": [{string}, {null}]}` are
    // the same statement; Zod emits the second, a hand-written schema the
    // first, and both reach this code.
    const schema = {
      type: "object",
      properties: {
        degraded: {
          type: "object",
          properties: {
            reason: { type: "string" },
            stamp: { type: ["string", "null"] },
          },
          required: ["reason", "stamp"],
        },
      },
    };
    const completed = completeDegradedBlock(
      { degraded: { reason: "tier_unavailable" } },
      schema,
    ) as Row;
    assert.equal((completed.degraded as Row).stamp, null);
  });

  test("a degraded branch declaring no `required` is skipped, not crashed on", () => {
    const schema = {
      type: "object",
      properties: {
        degraded: {
          type: "object",
          properties: { reason: { type: "string" } },
        },
      },
    };
    const stamped = { degraded: { reason: "tier_unavailable" } };
    assert.equal(completeDegradedBlock(stamped, schema), stamped);
  });

  test("no missing schema means no completion, and no crash", () => {
    const stamped = { degraded: { reason: "tier_unavailable" } };
    assert.equal(completeDegradedBlock(stamped, undefined), stamped);
  });
});

describe("query_graphql publishes the null GraphQL requires (#9911)", () => {
  test("a failed query's `data: null` satisfies the published schema", () => {
    // The exact production response: a variable-coercion failure returns
    // data:null with errors, which the previous non-nullable schema forbade.
    const failed = {
      data: null,
      errors: [
        {
          message:
            'Variable "$netuid" has invalid value: Expected a value of non-null type "Int!" to be provided.',
        },
      ],
    };
    assert.equal(validates(schemaFor("query_graphql"), failed), true);
  });

  test("a successful query still validates", () => {
    assert.equal(
      validates(schemaFor("query_graphql"), {
        data: { subnet: { netuid: 64, name: "Chutes" } },
        errors: [],
      }),
      true,
    );
  });

  test("the declared query example is self-contained", () => {
    const def = listToolDefinitions().find(
      (tool) => (tool as Row).name === "query_graphql",
    ) as Row;
    const example = (((def.inputSchema as Row).properties as Row).query as Row)
      .examples?.[0] as string;
    // A `$variable` in the example needs the SEPARATE optional `variables`
    // parameter to work, so an agent copying the query alone gets a coercion
    // error. Verified live: the replacement returns SN64.
    assert.equal(example.includes("$"), false);
    assert.match(example, /subnet\(netuid:\s*64\)/);
  });
});
