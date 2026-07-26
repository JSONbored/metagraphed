import { describe, expect, it } from "vitest";
import { normalizeAgentResources } from "./queries";

describe("normalizeAgentResources", () => {
  it("passes a resource's install command through when present", () => {
    const res = normalizeAgentResources({
      mcp: { endpoint: "https://api.metagraph.sh/mcp", install: "claude mcp add ..." },
      resources: [
        {
          id: "skill",
          kind: "skill",
          title: "Bittensor skill",
          url: "https://api.metagraph.sh/skills/bittensor/SKILL.md",
          install: "gh skill install JSONbored/metagraphed bittensor",
        },
      ],
    });
    expect(res.resources).toHaveLength(1);
    expect(res.resources[0]?.install).toBe("gh skill install JSONbored/metagraphed bittensor");
  });

  it("omits install when the source resource doesn't have one", () => {
    const res = normalizeAgentResources({
      resources: [
        { id: "llms", kind: "index", title: "llms.txt", url: "https://api.metagraph.sh/llms.txt" },
      ],
    });
    expect(res.resources).toHaveLength(1);
    expect(res.resources[0]?.install).toBeUndefined();
  });

  it("drops a resource missing title or url, keeps the rest", () => {
    const res = normalizeAgentResources({
      resources: [
        { id: "broken", kind: "skill", title: "", url: "https://example.com" },
        { id: "ok", kind: "skill", title: "OK", url: "https://example.com/ok" },
      ],
    });
    expect(res.resources).toHaveLength(1);
    expect(res.resources[0]?.id).toBe("ok");
  });

  it("degrades a cold/junk store to a schema-stable shape, never throwing", () => {
    for (const raw of [{}, null, "x", { resources: "nope" }]) {
      const res = normalizeAgentResources(raw);
      expect(res.resources).toEqual([]);
      expect(res.mcp.tools).toEqual([]);
    }
  });
});
