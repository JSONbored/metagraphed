import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENT_MARKDOWN_URL, fetchAgentMarkdown } from "./agent-doc.functions";

describe("fetchAgentMarkdown", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the response body verbatim on a successful fetch", async () => {
    const markdown = "# Bittensor integration agent\n\nCopy everything below.\n";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => markdown }));

    await expect(fetchAgentMarkdown()).resolves.toBe(markdown);
    expect(fetch).toHaveBeenCalledWith(AGENT_MARKDOWN_URL);
  });

  it("targets the pinned default API origin, never a client-supplied base", () => {
    // The server fn must not fetch a URL that came from localStorage — see the
    // SSRF note on fetchAgentMarkdown.
    expect(AGENT_MARKDOWN_URL).toMatch(/^https:\/\/[^/]+\/agent\.md$/);
  });

  it("throws with the status when the asset 404s", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    await expect(fetchAgentMarkdown()).rejects.toThrow("agent.md returned 404");
  });

  it("propagates a transport failure rather than resolving empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(fetchAgentMarkdown()).rejects.toThrow("network down");
  });
});
