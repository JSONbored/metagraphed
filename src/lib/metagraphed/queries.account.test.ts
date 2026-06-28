import { describe, expect, it } from "vitest";
import { normalizeAccountSummary } from "./queries";

describe("normalizeAccountSummary", () => {
  it("normalizes nested registration rows and drops malformed events", () => {
    const summary = normalizeAccountSummary(
      {
        ss58: "5valid",
        event_count: 2,
        subnet_count: 1,
        registrations: [
          {
            netuid: { attacker: true },
            uid: 7,
            stake_tao: { attacker: true },
            validator_permit: { attacker: true },
            active: true,
          },
        ],
        recent_events: [
          // Well-formed row: primitive fields are coerced before render.
          {
            block_number: "123",
            event_index: 4,
            event_kind: "Transfer",
            netuid: "7",
            amount_tao: "1.5",
          },
          // Object-valued render fields → dropped by the strict normalizer (#261).
          {
            block_number: 123,
            event_index: { attacker: true },
            event_kind: { attacker: true },
          },
        ],
      },
      "fallback",
    );

    expect(summary.registrations).toEqual([
      {
        netuid: null,
        uid: 7,
        stake_tao: null,
        validator_permit: undefined,
        active: true,
      },
    ]);
    expect(summary.recent_events).toEqual([
      {
        block_number: 123,
        event_index: 4,
        event_kind: "Transfer",
        hotkey: null,
        coldkey: null,
        netuid: 7,
        uid: null,
        amount_tao: 1.5,
        alpha_amount: null,
        extrinsic_index: null,
        observed_at: undefined,
      },
    ]);
  });

  it("drops invalid nested rows and caps untrusted account arrays", () => {
    const oversizedRegistrations = Array.from({ length: 150 }, (_, uid) => ({ netuid: 1, uid }));
    const oversizedEvents = Array.from({ length: 150 }, (_, block) => ({
      block_number: block,
      event_index: block,
      event_kind: "Transfer",
    }));

    const summary = normalizeAccountSummary(
      {
        registrations: [...oversizedRegistrations, { attacker: true }],
        recent_events: [...oversizedEvents, { attacker: true }],
      },
      "fallback",
    );

    expect(summary.registrations).toHaveLength(100);
    expect(summary.registrations[0]).toMatchObject({ netuid: 1, uid: 0 });
    expect(summary.registrations.at(-1)).toMatchObject({ netuid: 1, uid: 99 });
    expect(summary.recent_events).toHaveLength(100);
    expect(summary.recent_events[0]).toMatchObject({ block_number: 0, event_kind: "Transfer" });
    expect(summary.recent_events.at(-1)).toMatchObject({ block_number: 99 });
  });
});
