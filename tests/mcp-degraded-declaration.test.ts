// The `degraded` block every tool can be stamped with, declared at the seam
// that emits every tool's output schema (#10790).
//
// `markMcpTierDegraded` fires in `dispatchTool` for EVERY tool, after the
// handler has returned, whenever the Postgres tier fell back during the call.
// So `degraded: {reason}` can land on a result whose own schema never mentioned
// it. `.passthrough()` waved that through; under `.strict()` three tools failed
// their own published outputSchema the first time the tier went cold -- and the
// only reason it was three is that three is what the hermetic harness happened
// to exercise with a cold tier.
//
// Declaring it per tool would be a list of "tools that can degrade", wrong the
// first time a handler started reading a tier. It is declared once, in
// `outputJsonSchema`, because that is where the fact lives.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { z } from "zod";
import { outputJsonSchema } from "../src/mcp-input-schema.ts";

type JsonSchema = {
  properties?: Record<string, { properties?: Record<string, unknown> }>;
  required?: string[];
};

describe("outputJsonSchema", () => {
  test("adds `degraded` to a tool that never declared one", () => {
    const emitted = outputJsonSchema(
      z.object({ netuid: z.int() }).strict(),
    ) as JsonSchema;
    assert.ok(emitted.properties?.degraded, "every tool result may carry it");
    assert.ok(
      emitted.properties.degraded.properties?.reason,
      "and it carries the reason the answer is untrustworthy",
    );
  });

  test("it is OPTIONAL -- a healthy answer carries no block", () => {
    const emitted = outputJsonSchema(
      z.object({ netuid: z.int() }).strict(),
    ) as JsonSchema;
    assert.equal(
      (emitted.required ?? []).includes("degraded"),
      false,
      "requiring it would make every healthy response invalid",
    );
  });

  test("a tool that declares a RICHER `degraded` keeps its own", () => {
    // #9910: `get_account_positions` declares three required properties on it,
    // and `completeDegradedBlock` fills them at dispatch. Overwriting that with
    // the generic one-field shape would undo exactly that fix.
    const rich = z
      .object({
        netuid: z.int(),
        degraded: z
          .object({
            reason: z.string(),
            snapshot_captured_at: z.string().nullable(),
            latest_stake_event_at: z.string().nullable(),
          })
          .strict()
          .nullable(),
      })
      .strict();
    const emitted = outputJsonSchema(rich) as JsonSchema;
    const declared = emitted.properties?.degraded;
    assert.ok(
      JSON.stringify(declared).includes("snapshot_captured_at"),
      "the tool's own richer block survives",
    );
  });

  test("the un-extended schema does NOT already carry it", () => {
    // The negative that makes the first test mean something: without this, an
    // emitter that added `degraded` to nothing at all would still pass, and so
    // would one that had always added it.
    const plain = z.toJSONSchema(z.object({ netuid: z.int() }).strict(), {
      target: "draft-2020-12",
    }) as JsonSchema;
    assert.equal(plain.properties?.degraded, undefined);
  });

  test("a non-object schema passes through untouched", () => {
    const emitted = z.toJSONSchema(z.array(z.string()), {
      target: "draft-2020-12",
    });
    assert.deepEqual(outputJsonSchema(z.array(z.string())), emitted);
  });
});
