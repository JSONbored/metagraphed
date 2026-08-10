// The three GraphQL-only components (#10409) describe shapes whose PRODUCER
// lives in resolver or Worker code, not in a route schema. That is the whole
// reason they had no component for so long -- and it is also the way they can
// rot: nothing forces the Zod to keep describing what the producer emits.
//
// So every test here compares the schema to the producer's own source of
// truth, never to another schema. A contract consistent with itself proves
// nothing.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { CHAIN_FIREHOSE_TABLES } from "../src/chain-firehose-topics.ts";
import { validateChainFirehoseIngestPayload } from "../workers/chain-firehose-hub.ts";
import {
  ChainFirehoseEventSchema,
  EmissionGateChangeSchema,
  OPPORTUNITY_BOARDS,
  OpportunityBoardsSchema,
} from "../schemas-src/graphql/graphql-only.ts";
import {
  EmissionFlowChangeSchema,
  EmissionParamChangeSchema,
  EmissionSubnetChangeSchema,
} from "../schemas-src/routes/emission-gate-changes.ts";

describe("ChainFirehoseEvent", () => {
  test("its table vocabulary is the firehose's own, not a copy", () => {
    // `CHAIN_FIREHOSE_TABLES` is what the subscription filter, the SSE topic
    // parser and the ingest validator all read. A fifth table added there and
    // not here would publish a `ChainEvent` the schema rejects.
    assert.deepEqual(
      [...ChainFirehoseEventSchema.shape.table.options].sort(),
      [...CHAIN_FIREHOSE_TABLES].sort(),
    );
  });

  test("a payload the ingest validator accepts, the schema accepts", () => {
    // The ingest side is a HAND-WRITTEN check (bounded scalars, a known table,
    // a non-negative block_number) that deliberately does not enumerate the
    // per-table columns. This holds the two to the same answer on a real
    // payload of each table rather than assuming they agree.
    const payloads = [
      {
        table: "blocks",
        block_number: 8812800,
        observed_at: "2026-08-10T08:24:54.186Z",
        block_hash: "0xabc",
        extrinsic_count: 3,
        event_count: 12,
      },
      {
        table: "extrinsics",
        block_number: 8812800,
        extrinsic_index: 2,
        call_module: "SubtensorModule",
        call_function: "add_stake",
        signer: "5HCFWvRqzSHWRPecN7q8J6c7aKQnrCZTMHstPv39xL1wgDHh",
        success: true,
      },
      {
        table: "chain_events",
        block_number: 8812800,
        event_index: 5,
        pallet: "Balances",
        method: "Transfer",
      },
      {
        table: "account_events",
        block_number: 8812800,
        event_index: 5,
        event_kind: "StakeAdded",
        hotkey: "5HCFWvRqzSHWRPecN7q8J6c7aKQnrCZTMHstPv39xL1wgDHh",
        coldkey: "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u",
        netuid: 1,
        amount_tao: 12.5,
      },
    ];
    for (const payload of payloads) {
      const ingest = validateChainFirehoseIngestPayload(
        JSON.stringify(payload),
      );
      assert.equal(ingest.ok, true, `ingest rejected ${payload.table}`);
      const parsed = ChainFirehoseEventSchema.safeParse(payload);
      assert.equal(
        parsed.success,
        true,
        `schema rejected ${payload.table}: ${parsed.error?.message}`,
      );
    }
  });

  test("it REJECTS a table the firehose does not broadcast", () => {
    // The negative half. Without it the test above passes on a schema that
    // accepts anything.
    assert.equal(
      ChainFirehoseEventSchema.safeParse({
        table: "neuron_daily",
        block_number: 1,
      }).success,
      false,
    );
  });
});

describe("EmissionGateChange", () => {
  test("it carries every field of all three arms, and nothing else", () => {
    // DERIVED, not restated: this is what makes a field added to any arm show
    // up in the published type instead of silently not.
    const fromArms = new Set(
      [
        EmissionParamChangeSchema,
        EmissionSubnetChangeSchema,
        EmissionFlowChangeSchema,
      ].flatMap((arm) => Object.keys(arm.shape)),
    );
    assert.deepEqual(
      Object.keys(EmissionGateChangeSchema.shape).sort(),
      [...fromArms].sort(),
    );
  });

  test("a row from any one arm parses", () => {
    const shared = {
      observed_at: "2026-08-10T08:24:54.186Z",
      block_number: 8812800,
      predates_capture: false,
    };
    const rows = [
      {
        ...shared,
        kind: "param",
        param: "emission_gate_bar",
        value: 0.5,
        previous_value: 0.4,
        source: "governance",
      },
      {
        ...shared,
        kind: "subnet",
        netuid: 1,
        enabled: true,
        previous_enabled: false,
      },
      { ...shared, kind: "flow", item: "alpha_in", netuid: 1, is_set: true },
    ];
    for (const row of rows) {
      const parsed = EmissionGateChangeSchema.safeParse(row);
      assert.equal(
        parsed.success,
        true,
        `${row.kind} row rejected: ${parsed.error?.message}`,
      );
    }
  });

  test("the four shared fields stay REQUIRED", () => {
    // The flattening makes the arm-specific fields optional. If it made the
    // shared four optional too, the SDL's four non-null promises would be
    // over-promises the parity gate could no longer see.
    for (const name of [
      "kind",
      "observed_at",
      "block_number",
      "predates_capture",
    ]) {
      const row: Record<string, unknown> = {
        kind: "param",
        observed_at: "2026-08-10T08:24:54.186Z",
        block_number: 1,
        predates_capture: false,
      };
      delete row[name];
      assert.equal(
        EmissionGateChangeSchema.safeParse(row).success,
        false,
        `${name} must be required`,
      );
    }
  });
});

describe("OpportunityBoards", () => {
  test("it declares exactly the boards the resolver publishes", () => {
    const boards = Object.keys(OpportunityBoardsSchema.shape).filter(
      (name) => name !== "observed_at" && name !== "with_economics_count",
    );
    assert.deepEqual(boards.sort(), [...OPPORTUNITY_BOARDS].sort());
  });

  test("every board is required, because the ranker always materializes it", () => {
    // `formatLeaderboards` always emits every economic key, possibly as [] --
    // the resolver relies on it and says so. An optional board here would let
    // the SDL's six non-null promises go unchecked.
    const complete = {
      observed_at: null,
      with_economics_count: 0,
      ...Object.fromEntries(OPPORTUNITY_BOARDS.map((board) => [board, []])),
    };
    assert.equal(OpportunityBoardsSchema.safeParse(complete).success, true);
    for (const board of OPPORTUNITY_BOARDS) {
      const missing = { ...complete };
      delete (missing as Record<string, unknown>)[board];
      assert.equal(
        OpportunityBoardsSchema.safeParse(missing).success,
        false,
        `${board} must be required`,
      );
    }
  });
});
