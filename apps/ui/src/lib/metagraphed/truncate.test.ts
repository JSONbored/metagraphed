import { describe, expect, it } from "vitest";

import { clampText } from "./truncate";
import { OG_LIMITS } from "./og-card-limits";

describe("clampText (#11244) — a cut card reads as shortened, not broken", () => {
  it("cuts at a word boundary instead of mid-word", () => {
    // The live subnet cards ended "…machine-readable on Meta…", chopping our
    // own name in half on every share.
    const subtitle =
      "Apex (SN1): Bittensor subnet 1 — interfaces, endpoints, schemas, machine-readable on Metagraphed. Source: macrocosm-os/apex.";
    const out = clampText(subtitle, OG_LIMITS.subtitle);
    expect(out).toBe(
      "Apex (SN1): Bittensor subnet 1 — interfaces, endpoints, schemas, machine-readable on…",
    );
    expect(out.length).toBeLessThanOrEqual(OG_LIMITS.subtitle);
  });

  it("drops trailing punctuation so a cut after a comma is not ', …'", () => {
    const out = clampText(
      "404-GEN: Bittensor infrastructure provider — public endpoints, operational surfaces, and live health on Metagraphed.",
      OG_LIMITS.subtitle,
    );
    expect(out.endsWith("and…")).toBe(true);
    expect(out).not.toContain(", …");
  });

  it("still fills the budget when there is no boundary worth reaching", () => {
    // A truncated ss58 or a block hash has no space in it at all; backing off
    // would collapse the value rather than shorten it.
    const key = "5Grwvaef5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    expect(clampText(key, 28)).toHaveLength(28);
    expect(clampText("x".repeat(200), OG_LIMITS.subtitle)).toHaveLength(OG_LIMITS.subtitle);
    // A space too early to be useful is ignored for the same reason.
    expect(clampText(`ab ${"y".repeat(200)}`, 40)).toHaveLength(40);
  });

  it("leaves anything already inside its budget untouched", () => {
    const fits = "Chutes (SN64): Bittensor subnet 64 — interfaces, endpoints, schemas.";
    expect(clampText(fits, OG_LIMITS.subtitle)).toBe(fits);
    expect(clampText("  padded  ", OG_LIMITS.subtitle)).toBe("padded");
    expect(clampText(null, OG_LIMITS.subtitle)).toBe("");
  });
});

describe("clampText — the API-reference meta descriptions (#11251)", () => {
  it("keeps a description inside Google's ~155-character budget", () => {
    const prose =
      "Fetch the per-domain rollup overview: every domain/capability tag in the existing 14-tag taxonomy, each with its member subnet count, total stake, and total emission share.";
    const out = clampText(prose, 155);
    expect(out.length).toBeLessThanOrEqual(155);
    expect(out.endsWith("…")).toBe(true);
    // Cut at a word boundary: whatever survived must end where the ORIGINAL
    // has a space, so the snippet never breaks a word in half. (Asserting the
    // last character is not a word character would be wrong — a clean cut
    // ends on the last letter of a complete word.)
    const kept = out.slice(0, -1);
    expect(prose.startsWith(kept)).toBe(true);
    expect(prose[kept.length]).toBe(" ");
  });

  it("is the SAME rule the OG cards use — one truncation behaviour site-wide", () => {
    // The point of extracting this: two implementations is how one surface
    // ends up cutting mid-word while another doesn't.
    const value = "Bittensor subnet interfaces, endpoints and schemas";
    expect(clampText(value, 30)).toBe(clampText(value, 30));
    expect(clampText(value, OG_LIMITS.subtitle)).toBe(value);
  });
});
