import { describe, expect, it } from "vitest";
import { buildHarnessConfig, HARNESSES } from "./agent-harness";

const MCP = {
  endpoint: "https://api.metagraph.sh/mcp",
  install: "claude mcp add --transport http metagraphed https://api.metagraph.sh/mcp",
  transport: "streamable-http",
};

describe("HARNESSES", () => {
  it("lists exactly the five harnesses the issue names", () => {
    expect(HARNESSES.map((h) => h.id)).toEqual([
      "claude-code",
      "claude-desktop",
      "cursor",
      "chatgpt",
      "generic-mcp",
    ]);
  });
});

describe("buildHarnessConfig", () => {
  it("claude-code: echoes the live install command verbatim (not regenerated)", () => {
    const config = buildHarnessConfig("claude-code", MCP);
    expect(config).toEqual({
      kind: "command",
      label: "Terminal command",
      content: MCP.install,
    });
  });

  it("claude-desktop: a JSON mcpServers block using the endpoint", () => {
    const config = buildHarnessConfig("claude-desktop", MCP);
    expect(config.kind).toBe("json");
    expect(config.content).toBeDefined();
    const parsed = JSON.parse(config.content!);
    expect(parsed.mcpServers.metagraphed.transport).toEqual({
      type: "http",
      url: MCP.endpoint,
    });
  });

  it("cursor: a JSON mcpServers block with a bare url field", () => {
    const config = buildHarnessConfig("cursor", MCP);
    expect(config.kind).toBe("json");
    const parsed = JSON.parse(config.content!);
    expect(parsed.mcpServers.metagraphed).toEqual({ url: MCP.endpoint });
  });

  it("chatgpt: steps (no single copy-paste artifact), mentioning the endpoint", () => {
    const config = buildHarnessConfig("chatgpt", MCP);
    expect(config.kind).toBe("steps");
    expect(config.steps?.some((s) => s.includes(MCP.endpoint))).toBe(true);
  });

  it("generic-mcp: steps naming the transport and endpoint", () => {
    const config = buildHarnessConfig("generic-mcp", MCP);
    expect(config.kind).toBe("steps");
    expect(config.steps?.[0]).toContain(MCP.endpoint);
    expect(config.steps?.[0]).toContain(MCP.transport);
  });

  it("every generated config changes when the endpoint changes -- single source of truth", () => {
    const otherMcp = { ...MCP, endpoint: "https://staging.example/mcp" };
    for (const harness of HARNESSES) {
      const a = buildHarnessConfig(harness.id, MCP);
      const b = buildHarnessConfig(harness.id, otherMcp);
      const serialize = (c: typeof a) => c.content ?? c.steps?.join("\n") ?? "";
      if (harness.id === "claude-code") continue; // sourced from mcp.install directly, not the endpoint
      expect(serialize(a)).not.toBe(serialize(b));
    }
  });
});
