import { describe, expect, it } from "vitest";
import { entityNotFoundMeta } from "@/lib/metagraphed/entity-not-found-meta";

// #6429: accounts.$ss58.tsx and validators.$hotkey.tsx had no router-level
// identifier validation, so a junk id rendered a fully-formed page. Adding
// parseParams fixes the body — but NOT the metadata: head() still runs with the
// raw param. Verified against the routes that already validate: /blocks/not-a-ref
// titles "Block not-a-ref — Metagraphed" and /subnets/not-a-netuid titles
// "Subnet not-a-netuid — Metagraphed" today. This helper is what actually keeps
// the junk id out of the title, and both routes share it.
const find = (meta: Array<Record<string, unknown>>, key: string, value: string) =>
  meta.find((m) => m[key] === value);

describe("entityNotFoundMeta (#6429)", () => {
  it("titles the page not-found instead of echoing the bad identifier", () => {
    const { meta } = entityNotFoundMeta("Account", "not a valid ss58");
    expect(meta[0]).toEqual({ title: "Account not found — Metagraphed" });
    // The regression: the title must never carry the raw param.
    expect(JSON.stringify(meta)).not.toContain("not-an-ss58");
  });

  it("marks the page noindex — these URLs are unbounded", () => {
    // Any string is a URL here, so a crawler could otherwise index one page per
    // malformed id.
    const { meta } = entityNotFoundMeta("Validator", "not a valid hotkey");
    expect(find(meta, "name", "robots")).toEqual({
      name: "robots",
      content: "noindex",
    });
  });

  it("carries the caller's description into both description tags", () => {
    const detail = "This validator identifier is not a valid Bittensor ss58 hotkey.";
    const { meta } = entityNotFoundMeta("Validator", detail);
    expect(find(meta, "name", "description")).toEqual({
      name: "description",
      content: detail,
    });
    expect(find(meta, "property", "og:description")).toEqual({
      property: "og:description",
      content: detail,
    });
  });

  it("keeps og:title in step with the title", () => {
    const { meta } = entityNotFoundMeta("Account", "x");
    expect(find(meta, "property", "og:title")).toEqual({
      property: "og:title",
      content: "Account not found — Metagraphed",
    });
  });

  it("names the entity the route serves, so the two routes read differently", () => {
    expect(entityNotFoundMeta("Account", "x").meta[0]).toEqual({
      title: "Account not found — Metagraphed",
    });
    expect(entityNotFoundMeta("Validator", "x").meta[0]).toEqual({
      title: "Validator not found — Metagraphed",
    });
  });
});
