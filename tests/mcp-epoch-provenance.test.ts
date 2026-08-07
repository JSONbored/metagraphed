import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { MCP_TOOLS } from "../src/mcp-server.ts";

// #9871: an external consumer cross-validated our SN53 chain data against the
// subnet's own signed provider API. Every figure they could independently check
// was exact -- per-hotkey `incentive` matched engy's finalized
// `weight_u16 / 65535` to 5 decimal places across 12 miners. Then they compared
// it against the subnet's OPEN epoch, saw a ~3x disagreement, and were "one
// step away from reporting your data as broken".
//
// It was not broken. `incentive` and its siblings derive from the weights set
// in the LAST COMPLETED tempo; `captured_at`/`block_number` say when WE sampled
// the chain, which is a different thing, and nothing on the payload said so.
//
// The warning is the fix that prevents the wrong conclusion, so it is the thing
// worth pinning: a description is easy to shorten later by someone who does not
// know what it was load-bearing for.
const WEIGHT_DERIVED_TOOLS = ["get_neuron", "get_subnet_metagraph"];

describe("weight-derived fields declare which epoch they came from (#9871)", () => {
  for (const name of WEIGHT_DERIVED_TOOLS) {
    test(`${name} warns that these values are last-tempo, not live`, () => {
      const tool = MCP_TOOLS.find((entry) => entry.name === name);
      assert.ok(tool, `${name} must be a registered tool`);
      const description = String(tool.description ?? "");
      // The claim itself, not the exact wording -- what must survive is that a
      // reader is told the values lag by a tempo and that comparing them to an
      // in-progress epoch is expected to disagree.
      assert.match(
        description,
        /LAST COMPLETED tempo/,
        `${name} must say the values come from the last completed tempo`,
      );
      assert.match(
        description,
        /in-progress epoch/i,
        `${name} must warn against comparing with an in-progress epoch`,
      );
      // captured_at is the trap: it looks like provenance and is not.
      assert.match(
        description,
        /captured_at/,
        `${name} must say what captured_at actually means, since that is the field a reader reaches for`,
      );
    });
  }
});
