import { describe, expect, it } from "vitest";
import { ogImageMeta } from "./og-card";
import { cardTitleLayout } from "../og-image";
import {
  blockOgContent,
  eventOgContent,
  extrinsicOgContent,
  providerOgContent,
  subnetOgContent,
  validatorOgContent,
} from "./og-entity-content";

describe("entity preview content", () => {
  it("keeps a qualified record label intact when it fits above the minimum title size", () => {
    for (const title of [
      "Balances.Issued",
      "System.ExtrinsicSuccess",
      "SubtensorModule.register_limit",
    ]) {
      const layout = cardTitleLayout(title, false, false, "Record details on Bittensor.");
      expect(layout.fontSize).toBeGreaterThanOrEqual(42);
      expect(layout.lines).toEqual([title]);
    }
  });
  it("keeps every standard description fully visible in the bounded two-line layout", () => {
    const cards = [
      subnetOgContent(1),
      validatorOgContent("address"),
      providerOgContent("provider"),
      blockOgContent("123", 123),
      extrinsicOgContent("123-0", "Balances.transfer"),
      eventOgContent(123, "0", "System.Success"),
    ];
    for (const card of cards) {
      const layout = cardTitleLayout(card.title, true, true, card.subtitle!);
      expect(layout.subtitleLines.join(" ")).toBe(card.subtitle);
    }
  });
  it("keeps subnet identity outside supported facts and omits derived voting stake", () => {
    const data = {
      name: "Example subnet",
      alphaPriceTao: 0.08,
      emissionShare: 0.03,
      totalStakeAlpha: 1200,
    };
    const card = subnetOgContent(19, data);
    expect(card.identifier).toBe("Subnet 19");
    expect(card.stats?.map((stat) => stat.label)).toEqual(["Price", "Emission"]);
    expect(card.status).toBeUndefined();
    expect(card.subtitle).not.toMatch(/live|healthy|failed/);
    expect(subnetOgContent(0)).toMatchObject({ title: "Subnet 0", identifier: null, stats: [] });
  });

  it("preserves declared names and their hotkey rather than replacing identity with a count", () => {
    const hotkey = "5" + "a".repeat(46) + "z";
    const card = validatorOgContent(hotkey, {
      name: "Declared name",
      logoPath: "/logos/example.png",
      logoHost: "example.com",
      subnetCount: 0,
    });
    expect(card).toMatchObject({
      title: "Declared name",
      identifier: "Hotkey 5aaaaa…aaaaaz",
      logoPath: "/logos/example.png",
    });
    expect(card.stats).toEqual([{ label: "Subnets", value: "0" }]);
    expect(validatorOgContent(hotkey)).toMatchObject({ identifier: null, stats: [] });
  });

  it("omits absent and malformed values while retaining observed zero", () => {
    for (const value of [null, undefined, NaN, Infinity, -1]) {
      expect(subnetOgContent(1, { alphaPriceTao: value, emissionShare: value }).stats).toEqual([]);
      expect(
        providerOgContent("example", { endpoints: value, surfaces: value, subnets: value }).stats,
      ).toEqual([]);
      expect(validatorOgContent("address", { subnetCount: value }).stats).toEqual([]);
    }
    expect(
      providerOgContent("example", { endpoints: 0, surfaces: 0, subnets: 0 }).stats,
    ).toHaveLength(3);
    expect(providerOgContent("example", { endpoints: 1.5 }).stats).toEqual([]);
    expect(subnetOgContent(1, { alphaPriceTao: 0, emissionShare: 0 }).stats).toHaveLength(2);
    expect(subnetOgContent(1, { emissionShare: 1.01 }).stats).toEqual([]);
    expect(subnetOgContent(1, { emissionShare: 1 }).stats).toEqual([
      { label: "Emission", value: "100.00%" },
    ]);
  });

  it("retains curated logo paths and external-host fallback without current-health claims", () => {
    const data = {
      iconUrl: "https://metagraph.sh/logos/example.png",
      website: "https://example.com",
      name: "Example",
    };
    for (const card of [subnetOgContent(1, data), providerOgContent("example", data)]) {
      expect(card).toMatchObject({ logoPath: "/logos/example.png", logoHost: "example.com" });
      expect(card.status).toBeUndefined();
      expect(card.subtitle).not.toContain("live");
    }
  });

  it("uses an already-resolved block number while retaining a supplied hash", () => {
    const hash = "0x" + "a".repeat(64);
    expect(blockOgContent(hash, 0)).toMatchObject({
      title: "Block #0",
      identifier: "0xaaaa…aaaaaa",
    });
    expect(blockOgContent("123", 123)).toMatchObject({ title: "Block #123", identifier: null });
    expect(blockOgContent(hash)).toMatchObject({ title: "Block 0xaaaa…aaaaaa", identifier: null });
  });

  it("uses the resolved call with its extrinsic reference, and degrades to identity only", () => {
    expect(extrinsicOgContent("123-0", "Balances.transfer")).toMatchObject({
      title: "Balances.transfer",
      identifier: "Extrinsic 123-0",
    });
    for (const call of [null, undefined, "—", " "]) {
      expect(extrinsicOgContent("123-0", call)).toMatchObject({
        title: "Extrinsic 123-0",
        identifier: null,
      });
    }
  });

  it("preserves event zero and block zero as coordinates rather than statistics", () => {
    expect(eventOgContent(0, "0", "System.Success")).toMatchObject({
      title: "System.Success",
      identifier: "Block #0 · Event #0",
    });
    expect(eventOgContent(0, "0").title).toBe("Event #0");
    expect(eventOgContent(0, "0").stats).toBeUndefined();
  });

  it("includes the actual bounded identifier in matching image captions", () => {
    const meta = ogImageMeta(eventOgContent(0, "0", "System.Success"));
    const image = meta.find((tag) => "property" in tag && tag.property === "og:image");
    const params = new URL(image!.content).searchParams;
    const alt = `${params.get("title")} — ${params.get("identifier")} — ${params.get("subtitle")}`;
    expect(meta).toContainEqual({ property: "og:image:alt", content: alt });
    expect(meta).toContainEqual({ name: "twitter:image:alt", content: alt });
    const redundant = ogImageMeta({ title: "Subnet 1", identifier: "Subnet 1", entity: true });
    expect(redundant).toContainEqual({ property: "og:image:alt", content: "Subnet 1" });
  });
});
