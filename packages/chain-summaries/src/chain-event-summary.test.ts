import { describe, expect, it } from "vitest";
import { summarizeChainEvent, isNoiseEvent, NOISE_EVENTS } from "./chain-event-summary";

// #8253: fixtures are REAL args shapes captured live from
// GET /api/v1/chain-events on 2026-07-26 -- not invented ones. The
// single-element-array wrapping (`netuid: [102]`, `actual_fee: [0]`) is the
// specific thing that made a naive field read return an array where a number
// was expected, so it's pinned here.

describe("summarizeChainEvent", () => {
  it("unwraps single-element-array scalars (the live SCALE-decoded shape)", () => {
    // Commitments.Commitment, verbatim from the live feed.
    const s = summarizeChainEvent({
      who: "5GQuE3dTiEA3ECE9k1fxK9KHgeAz4fURRd5gHnPkxwWSiLzf",
      netuid: [102],
    });
    expect(s.netuid).toBe(102);
    expect(s.from).toBe("5GQuE3dTiEA3ECE9k1fxK9KHgeAz4fURRd5gHnPkxwWSiLzf");
  });

  it("converts rao amounts to TAO", () => {
    const s = summarizeChainEvent({ amount: [2_500_000_000] });
    expect(s.amountTao).toBe(2.5);
  });

  it("reads a zero fee as a real 0, not as absent", () => {
    // TransactionPayment.TransactionFeePaid, verbatim from the live feed.
    const s = summarizeChainEvent({
      tip: [0],
      who: "5Ea2KgMqRkJGtfP3F8reh5YvEmJocJurMh6mDzBmU35AKVBm",
      actual_fee: [0],
    });
    expect(s.amountTao).toBe(0);
    expect(s.from).toBe("5Ea2KgMqRkJGtfP3F8reh5YvEmJocJurMh6mDzBmU35AKVBm");
  });

  it("never renders one account as both sides of a transfer", () => {
    const who = "5GQuE3dTiEA3ECE9k1fxK9KHgeAz4fURRd5gHnPkxwWSiLzf";
    // `who` matches a FROM key; nothing should populate `to` from it.
    expect(summarizeChainEvent({ who }).to).toBeNull();
    // An explicit distinct target does populate it.
    const to = "5Ea2KgMqRkJGtfP3F8reh5YvEmJocJurMh6mDzBmU35AKVBm";
    const s = summarizeChainEvent({ from: who, dest: to });
    expect(s.from).toBe(who);
    expect(s.to).toBe(to);
  });

  it("decodes 32-byte account arrays into ss58, and does NOT treat a hash as an address", () => {
    const bytes = Array.from({ length: 32 }, (_, i) => i + 1);
    // `who` is an account key -> ss58; `hash` is not -> 0x-hex, so it must not
    // surface as an address.
    expect(summarizeChainEvent({ who: bytes }).from).toMatch(/^5/);
    expect(summarizeChainEvent({ hash: bytes }).from).toBeNull();
  });

  it("returns all-null for args it can't read rather than guessing", () => {
    for (const args of [null, undefined, "string", 42, []]) {
      expect(summarizeChainEvent(args)).toEqual({
        amountTao: null,
        from: null,
        to: null,
        netuid: null,
      });
    }
  });

  it("ignores non-numeric junk in a numeric field", () => {
    expect(summarizeChainEvent({ amount: { nested: true } }).amountTao).toBeNull();
    expect(summarizeChainEvent({ netuid: "not-a-number" }).netuid).toBeNull();
  });
});

describe("isNoiseEvent", () => {
  it("matches exactly the three high-volume plumbing events", () => {
    expect(NOISE_EVENTS.size).toBe(3);
    expect(isNoiseEvent("System", "ExtrinsicSuccess")).toBe(true);
    expect(isNoiseEvent("System", "ExtrinsicFailed")).toBe(true);
    expect(isNoiseEvent("TransactionPayment", "TransactionFeePaid")).toBe(true);
  });

  it("does not hide events that carry real information", () => {
    // Notably Balances.Deposit/Withdraw stay visible -- they move real value.
    expect(isNoiseEvent("SubtensorModule", "WeightsSet")).toBe(false);
    expect(isNoiseEvent("Commitments", "Commitment")).toBe(false);
    expect(isNoiseEvent("Balances", "Deposit")).toBe(false);
    expect(isNoiseEvent("Balances", "Transfer")).toBe(false);
  });

  it("is null-safe", () => {
    expect(isNoiseEvent(null, "ExtrinsicSuccess")).toBe(false);
    expect(isNoiseEvent("System", null)).toBe(false);
  });
});
