import { describe, expect, it } from "vitest";
import { SUBNET_SLOT_CAP } from "./bittensor";
import { HUB_COPY, HUB_DESCRIPTION_MAX, HUB_TITLE_MAX, hubMeta, type HubPath } from "./hub-copy";

const PATHS = Object.keys(HUB_COPY) as HubPath[];

describe("hub copy budgets", () => {
  it.each(PATHS)("%s has a title inside Google's truncation", (path) => {
    const { title } = HUB_COPY[path];
    expect(title.length).toBeGreaterThan(0);
    expect(title.length, `${path}: ${title.length} chars — "${title}"`).toBeLessThanOrEqual(
      HUB_TITLE_MAX,
    );
  });

  it.each(PATHS)("%s has a description inside the snippet budget", (path) => {
    const { description } = HUB_COPY[path];
    expect(description.length).toBeGreaterThan(0);
    expect(description.length, `${path}: ${description.length} chars`).toBeLessThanOrEqual(
      HUB_DESCRIPTION_MAX,
    );
  });
});

describe("hub copy targets the query, not the brand", () => {
  it.each(PATHS)("%s does not lead with the brand", (path) => {
    // The whole point of #11320. A brand search for this project returns the
    // Bittensor SDK's docs and not us, so the front of the tag has to earn the
    // click on terms. "Subnets — Metagraphed" was 21 characters aimed at
    // nothing.
    expect(HUB_COPY[path].title.startsWith("Metagraphed")).toBe(false);
  });

  it.each(PATHS)("%s names Bittensor, which every measured query includes", (path) => {
    // Every one of the 75 queries GSC records over 90 days is a Bittensor
    // query. A hub title that omits the word competes for nothing.
    expect(HUB_COPY[path].title).toContain("Bittensor");
  });

  it.each(PATHS)("%s keeps the brand at the end", (path) => {
    expect(HUB_COPY[path].title.endsWith("· Metagraphed")).toBe(true);
  });

  it("states the subnet count from the protocol cap, never a literal", () => {
    // A registration changes WHICH project holds a netuid, not how many exist,
    // so this is a constant rather than a fetch — and 128 rather than 129,
    // because root is governance rather than an application subnet. The title
    // names both groups because the directory intentionally renders both.
    // scripts/validate-subnet-slot-cap.ts fails CI if the registry stops matching.
    expect(HUB_COPY["/subnets"].title).toContain(String(SUBNET_SLOT_CAP));
    expect(HUB_COPY["/subnets"].title).toContain("application subnets + root");
    expect(HUB_COPY["/subnets"].title).not.toContain("129");
  });
});

describe("hubMeta", () => {
  it("gives the tab and the unfurl the same title, and one description", () => {
    // The two live defects this module was written for: /apis emitted
    // `title: "API catalog — Metagraphed"` with `og:title: "Surfaces —
    // Metagraphed"`, and /validators carried two different description strings.
    const meta = hubMeta("/apis");
    const title = meta.find((m) => "title" in m) as { title: string };
    const ogTitle = meta.find((m) => m.property === "og:title") as { content: string };
    const description = meta.find((m) => m.name === "description") as { content: string };
    const ogDescription = meta.find((m) => m.property === "og:description") as { content: string };

    expect(ogTitle.content).toBe(title.title);
    expect(ogDescription.content).toBe(description.content);
    expect(title.title).toBe(HUB_COPY["/apis"].title);
  });

  it.each(PATHS)("%s emits all four tags", (path) => {
    // A hub missing og:description falls back to whatever the platform scrapes,
    // which is how a link unfurl ends up quoting a table header.
    const meta = hubMeta(path);
    expect(meta).toHaveLength(4);
    expect(meta.some((m) => "title" in m)).toBe(true);
    for (const key of ["description"]) {
      expect(meta.some((m) => m.name === key)).toBe(true);
    }
    for (const key of ["og:title", "og:description"]) {
      expect(meta.some((m) => m.property === key)).toBe(true);
    }
  });
});
