import { describe, it, expect } from "vitest";
import {
  alphaLabel,
  bucketLabelValue,
  bucketTone,
  claimVsChain,
  evidenceNote,
  summariseDisposition,
  taoLabel,
  walletRows,
} from "./money-map-model";

// #10511: two rules with consequences, and they pull the same way — a gap in
// OUR coverage must never render as a finding about somebody else.

describe("`unresolved` is rendered plainly", () => {
  it("carries the same neutral tone as every other bucket", () => {
    // It is the majority state today. A warning colour would read as an
    // accusation across most of the network.
    expect(bucketTone()).toBe("muted");
  });

  it("says the unresolved state is about OUR coverage, not the owner", () => {
    const { allUnresolved, note } = summariseDisposition({
      accrued_alpha: 100,
      buckets: {
        "held-as-stake": null,
        unstaked: null,
        "transferred-out": null,
        burned: null,
        unresolved: 100,
      },
    });
    expect(allUnresolved).toBe(true);
    expect(note).toContain("not about the owner");
    expect(note).toContain("paid as stake rather than a liquid balance");
    expect(note).not.toMatch(/hidden|conceal|suspicious|missing funds/i);
  });

  it("switches to the residual note once something IS resolved", () => {
    const { allUnresolved, note } = summariseDisposition({
      accrued_alpha: 100,
      buckets: { "held-as-stake": 60, unresolved: 40 },
    });
    expect(allUnresolved).toBe(false);
    expect(note).toContain("not balanced to tie");
  });

  it("is not 'all unresolved' when nothing was accrued at all", () => {
    expect(summariseDisposition(null).allUnresolved).toBe(false);
    expect(summariseDisposition({}).allUnresolved).toBe(false);
  });
});

describe("null is not zero", () => {
  it('renders an unread bucket as "Not read", never as 0', () => {
    expect(bucketLabelValue(null)).toBe("Not read");
    expect(bucketLabelValue(undefined)).toBe("Not read");
    expect(bucketLabelValue("0")).toBe("Not read");
  });

  it("keeps a measured zero as a real zero", () => {
    expect(bucketLabelValue(0)).toBe("0.0000 α");
  });

  it("applies the same rule to the alpha and TAO figures", () => {
    expect(alphaLabel(null)).toBe("Not read");
    expect(taoLabel(null)).toBe("Not read");
    expect(alphaLabel(2_500_000)).toBe("2.50M α");
    expect(taoLabel(12.5)).toBe("12.50 τ");
  });
});

describe("claim against chain", () => {
  it("reports both sides and the arithmetic difference", () => {
    expect(claimVsChain(100, 60)).toEqual({
      claimed: 100,
      observed: 60,
      delta: -40,
    });
  });

  it("produces no delta when either side is unread", () => {
    // A delta against an unread number is not a discrepancy, it is a gap.
    expect(claimVsChain(100, null).delta).toBeNull();
    expect(claimVsChain(null, 60).delta).toBeNull();
  });
});

describe("wallet rows", () => {
  it("keeps chain-derived and declared distinguishable", () => {
    const [owner, treasury] = walletRows([
      { ss58: "5Owner", role: "owner", chain_derived: true, source_urls: [] },
      {
        ss58: "5Treasury",
        role: "treasury",
        chain_derived: false,
        source_urls: ["https://example.org/t"],
        name: "Example",
      },
    ]);
    expect(owner.chainDerived).toBe(true);
    expect(treasury.chainDerived).toBe(false);
    expect(treasury.sourceUrls).toEqual(["https://example.org/t"]);
    expect(treasury.name).toBe("Example");
  });

  it("drops a row with no ss58 or no role rather than half-rendering it", () => {
    expect(
      walletRows([{ ss58: "", role: "owner" }, { ss58: "5X" }, { role: "treasury" }, "nope", null]),
    ).toEqual([]);
    expect(walletRows(null)).toEqual([]);
  });

  it("distinguishes 'needs no evidence' from 'has none'", () => {
    // A chain read and an unevidenced human claim must not read the same.
    const [owner, declared] = walletRows([
      { ss58: "5Owner", role: "owner", chain_derived: true, source_urls: [] },
      { ss58: "5T", role: "treasury", source_urls: [] },
    ]);
    expect(evidenceNote(owner)).toMatch(/needs no evidence/);
    expect(evidenceNote(declared)).toBe("No evidence recorded");
  });

  it("says nothing extra when the evidence is present", () => {
    const [row] = walletRows([
      { ss58: "5T", role: "treasury", source_urls: ["https://example.org"] },
    ]);
    expect(evidenceNote(row)).toBeNull();
  });

  it("carries a burn's unspendability basis", () => {
    const [row] = walletRows([
      {
        ss58: "5B",
        role: "burn",
        source_urls: ["https://x"],
        unspendable_proof_basis: "known-black-hole",
      },
    ]);
    expect(row.unspendableProofBasis).toBe("known-black-hole");
  });
});
