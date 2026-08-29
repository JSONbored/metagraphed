import { describe, expect, it } from "vitest";
import { normalizeBlockEvent, normalizeExtrinsic } from "./queries";

describe("block economics normalisation", () => {
  it("never relabels alpha as native TAO", () => {
    expect(
      normalizeBlockEvent({
        block_number: 10,
        event_index: 2,
        event_kind: "AlphaSwapped",
        amount_tao: null,
        alpha_amount: 9.5,
      }),
    ).toMatchObject({ amount_tao: null, alpha_amount: 9.5 });
  });

  it("keeps both denominations on extrinsic-attributed events", () => {
    const extrinsic = normalizeExtrinsic(
      { block_number: 10, extrinsic_index: 1, extrinsic_hash: "0xabc" },
      [
        {
          block_number: 10,
          event_index: 4,
          extrinsic_index: 1,
          event_kind: "StakeAdded",
          amount_tao: 2.25,
          alpha_amount: 3.5,
          netuid: 19,
        },
      ],
    );
    expect(extrinsic?.events?.[0]).toMatchObject({
      amount_tao: 2.25,
      alpha_amount: 3.5,
      netuid: 19,
      extrinsic_index: 1,
    });
  });
});
