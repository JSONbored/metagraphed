import { describe, expect, it } from "vitest";
import { normalizeProvider } from "./queries";

// normalizeProvider (the /providers/:slug detail normalizer) says it "mirrors
// normalizeProviderListItem". The list normalizer derives repo from github_url
// and notes from public_notes; the detail endpoint emits exactly those two
// snake_case fields (never a bare `repo`/`notes`). Before this fix the detail
// normalizer omitted repo entirely and dropped the public_notes fallback, so
// providers.$slug.tsx rendered no GitHub link (repoUrl={p?.repo}) and no
// description (description={p?.notes}) even though the list view showed both.

describe("normalizeProvider (detail) mirrors the list normalizer", () => {
  it("derives repo from github_url and notes from public_notes", () => {
    const out = normalizeProvider(
      {
        provider: {
          id: "404-gen",
          name: "404-GEN",
          github_url: "https://github.com/404-Repo/404-gen-subnet",
          public_notes: "Subnet 17 (404-GEN) team profile.",
        },
      },
      "404-gen",
    );
    expect(out.repo).toBe("https://github.com/404-Repo/404-gen-subnet");
    expect(out.notes).toBe("Subnet 17 (404-GEN) team profile.");
  });

  it("prefers an explicit repo/notes over the fallbacks and leaves them undefined when absent", () => {
    const withExplicit = normalizeProvider(
      { provider: { id: "x", repo: "https://example.com/x", notes: "n" } },
      "x",
    );
    expect(withExplicit.repo).toBe("https://example.com/x");
    expect(withExplicit.notes).toBe("n");

    const bare = normalizeProvider({ provider: { id: "y", name: "Y" } }, "y");
    expect(bare.repo).toBeUndefined();
    expect(bare.notes).toBeUndefined();
  });
});
