import { describe, expect, it } from "vitest";

import { repoSlugFrom, SITE_ORIGIN } from "./seo-meta";

describe("repoSlugFrom (#11204)", () => {
  it("reduces a repo URL to the owner/name a searcher would paste", () => {
    // Search Console shows queries that are literally a repo URL, so this slug
    // is what a description has to contain to match one.
    expect(repoSlugFrom("https://github.com/macrocosm-os/prompting")).toBe(
      "macrocosm-os/prompting",
    );
  });

  it("ignores everything below the repo root", () => {
    expect(repoSlugFrom("https://github.com/owner/name/tree/main/docs")).toBe("owner/name");
    expect(repoSlugFrom("https://github.com/owner/name.git")).toBe("owner/name");
    expect(repoSlugFrom("https://www.github.com/owner/name")).toBe("owner/name");
  });

  it("returns null rather than guessing at a non-repo URL", () => {
    // A wrong attribution in a search snippet is worse than an absent one --
    // the same rule the registry publishes its own claims under.
    for (const input of [
      "https://github.com", // no owner or repo
      "https://github.com/owner", // owner only
      "https://gitlab.com/owner/name", // another forge
      "https://example.com/owner/name", // not a forge at all
      "not-a-url",
      "",
      null,
      undefined,
    ]) {
      expect(repoSlugFrom(input), String(input)).toBeNull();
    }
  });

  it("does not mistake GitHub's own routes for repositories", () => {
    // `/orgs/x` and friends parse as owner/name but name no repo.
    for (const input of [
      "https://github.com/orgs/macrocosm-os",
      "https://github.com/sponsors/someone",
      "https://github.com/topics/bittensor",
    ]) {
      expect(repoSlugFrom(input), input).toBeNull();
    }
  });

  it("re-exports the one canonical site origin", () => {
    // Guards the consolidation: six modules used to hardcode this literal.
    expect(SITE_ORIGIN).toBe("https://metagraph.sh");
  });
});
