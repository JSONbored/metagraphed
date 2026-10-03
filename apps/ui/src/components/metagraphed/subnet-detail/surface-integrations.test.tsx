import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Surface } from "@/lib/metagraphed/types";
import SurfaceIntegrations, { surfaceIntegrationOperations } from "./surface-integrations";

const mcp: Surface = {
  id: "sn-74-source-mcp",
  name: "Source MCP",
  auth_required: true,
  mcp: {
    transport: "streamable-http",
    read_tools: ["read"],
    write_tools: ["write"],
    read_prompts: ["plan"],
    read_resources: ["loopover://finding-taxonomy"],
  },
};
const http: Surface = {
  id: "sn-42-source-http",
  name: "Source HTTP",
  http: {
    operations: [
      {
        method: "POST",
        path: "/api/v1/search/live",
        request_content_types: ["application/json"],
        request_body_required: true,
      },
      { method: "GET", path: "/api/v1/search/live/result/{uuid}" },
    ],
  },
};

describe("reviewed integration details", () => {
  it("maps all MCP capability kinds without granting writes through the read tool", () => {
    const rows = surfaceIntegrationOperations(mcp);
    expect(rows.map((row) => row.tool)).toEqual([
      "read_subnet_mcp",
      "write_subnet_mcp",
      "get_subnet_mcp_prompt",
      "read_subnet_mcp_resource",
    ]);
    expect(rows.map((row) => row.arguments)).toEqual([
      { surface_id: mcp.id, tool_name: "read" },
      { surface_id: mcp.id, tool_name: "write" },
      { surface_id: mcp.id, prompt_name: "plan" },
      { surface_id: mcp.id, resource_uri: "loopover://finding-taxonomy" },
    ]);
  });

  it("preserves the HTTP verb split, body type and result path placeholder", () => {
    const rows = surfaceIntegrationOperations(http);
    expect(rows.map((row) => row.tool)).toEqual(["write_subnet_surface", "call_subnet_surface"]);
    expect(rows[0].arguments).toEqual({
      surface_id: http.id,
      method: "POST",
      path: "/api/v1/search/live",
      json_body: {},
    });
    expect(rows[0].body_types).toEqual(["application/json"]);
    expect(rows[1].arguments).toEqual({
      surface_id: http.id,
      method: "GET",
      path: "/api/v1/search/live/result/{uuid}",
    });
  });

  it("rejects malformed permissions rather than exposing callable templates", () => {
    expect(
      surfaceIntegrationOperations({
        ...mcp,
        mcp: { ...(mcp.mcp as object), write_tools: ["x".repeat(129)] },
      }),
    ).toEqual([]);
    expect(
      surfaceIntegrationOperations({
        ...http,
        http: { operations: [{ method: "POST", path: "//outside.example/run" }] },
      }),
    ).toEqual([]);
  });

  it("renders source operations, auth and copy actions without treating resource URIs as URLs", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <SurfaceIntegrations surfaces={[mcp, http]} />
      </QueryClientProvider>,
    );
    expect(html).toContain("Caller authentication required");
    expect(html).toContain("Source MCP reviewed operations");
    expect(html).toContain("Source HTTP reviewed operations");
    expect(html).toContain("Copy Source MCP MCP discovery");
    expect(html).toContain("loopover://finding-taxonomy");
    expect(html).not.toContain('href="loopover:');
    expect(html).toContain("replace path placeholders");
  });

  it("keeps an empty or invalid declaration explicit", () => {
    const html = renderToStaticMarkup(<SurfaceIntegrations surfaces={[]} />);
    expect(html).toContain("No valid reviewed operation declarations were returned.");
  });
});
