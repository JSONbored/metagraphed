import { describe, expect, it } from "vitest";
import { feedAutodiscoveryLinks, registryFeedLinks, subnetFeedLinks } from "./feed-links";
import { API_BASE } from "./config";

describe("feedAutodiscoveryLinks (#8703)", () => {
  it("offers RSS and Atom, in that order", () => {
    const links = feedAutodiscoveryLinks("registry", "Test feed");
    expect(links.map((link) => link.type)).toEqual(["application/rss+xml", "application/atom+xml"]);
    expect(links.every((link) => link.rel === "alternate")).toBe(true);
  });

  it("pairs each media type with its own suffix", () => {
    // The bug this prevents: advertising one URL under two media types, so a
    // reader asking for Atom is handed RSS and fails to parse it.
    const [rss, atom] = feedAutodiscoveryLinks("registry", "Test feed");
    expect(rss.href).toBe(`${API_BASE}/api/v1/feeds/registry.rss`);
    expect(atom.href).toBe(`${API_BASE}/api/v1/feeds/registry.atom`);
  });

  it("gives the two links distinguishable titles", () => {
    // A reader that finds both shows these strings in its subscribe dialog;
    // two identical titles make the choice meaningless.
    const [rss, atom] = feedAutodiscoveryLinks("registry", "Test feed");
    expect(rss.title).not.toBe(atom.title);
    expect(atom.title).toContain("Atom");
  });

  it("points the registry links at the site-wide feed", () => {
    for (const link of registryFeedLinks()) {
      expect(link.href).toContain("/api/v1/feeds/registry.");
      expect(link.title).toMatch(/registry/i);
    }
  });

  it("points a subnet's links at that subnet's feed", () => {
    for (const link of subnetFeedLinks(8)) {
      expect(link.href).toContain("/api/v1/feeds/subnets/8.");
      expect(link.title).toContain("subnet 8");
    }
  });

  it("builds absolute URLs against the API origin, not the site origin", () => {
    // Feeds are served by the API worker; a site-relative href would 404 in
    // every reader.
    for (const link of [...registryFeedLinks(), ...subnetFeedLinks(64)]) {
      expect(() => new URL(link.href)).not.toThrow();
      expect(link.href.startsWith(API_BASE)).toBe(true);
    }
  });
});
