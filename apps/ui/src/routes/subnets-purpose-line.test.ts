import { describe, expect, it } from "vitest";
import { subnetPurpose } from "./-subnets-index-page";

// #11520: Browse leads with a plain-language answer to "what is this?". These
// pin the trimming, because the registry's strings run to full paragraphs and a
// table row is not where a paragraph belongs.

describe("subnetPurpose", () => {
  it("prefers the subnet's own copy over the registry's enrichment", () => {
    expect(
      subnetPurpose({
        description: "Verified inference for frontier open models.",
        derived_description: "A Bittensor subnet.",
      }),
    ).toBe("Verified inference for frontier open models.");
  });

  it("falls back to the enrichment when the subnet publishes none", () => {
    expect(subnetPurpose({ description: null, derived_description: "Reason Mining" })).toBe(
      "Reason Mining",
    );
  });

  it("stays quiet rather than printing a placeholder", () => {
    // A row with nothing to say must render nothing — an em dash under every
    // name is noise pretending to be content.
    expect(subnetPurpose({})).toBeNull();
    expect(subnetPurpose({ description: "   ", derived_description: null })).toBeNull();
  });

  it("keeps only the first sentence of a paragraph", () => {
    expect(
      subnetPurpose({
        description:
          "Incentivized compute marketplace. It also runs a validator programme and publishes weekly reports.",
      }),
    ).toBe("Incentivized compute marketplace.");
  });

  it("truncates a long single sentence on a word boundary", () => {
    const long =
      "A decentralized heterogeneous inference network providing verifiable low latency model serving across many independent operators";
    const result = subnetPurpose({ description: long })!;
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(97);
    // Never mid-word: the character before the ellipsis ends a real word.
    expect(result.slice(0, -1)).toBe(result.slice(0, -1).trimEnd());
    expect(long.startsWith(result.slice(0, -1))).toBe(true);
  });

  it("leaves a sentence that already fits completely alone", () => {
    const short = "Making every camera intelligent";
    expect(subnetPurpose({ description: short })).toBe(short);
  });
});
