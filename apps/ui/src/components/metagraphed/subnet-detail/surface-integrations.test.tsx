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
  it("copies a reviewed HEAD operation through the read tool", () => {
    const rows = surfaceIntegrationOperations({
      ...http,
      http: { operations: [{ method: "HEAD", path: "/health" }] },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe("call_subnet_surface");
    expect(rows[0].arguments.method).toBe("HEAD");
    expect(rows[0].arguments).not.toHaveProperty("body_artifact");
  });
  it("offers a compact artifact alternative for a required binary or multipart write", () => {
    for (const media of ["application/octet-stream", "multipart/form-data", "image/*"]) {
      const rows = surfaceIntegrationOperations({
        ...http,
        http: {
          operations: [
            {
              method: "PUT",
              path: "/upload",
              request_content_types: [media],
              request_body_required: true,
            },
          ],
        },
      });
      expect(rows).toHaveLength(2);
      expect(rows[0].arguments.body_base64).toBeDefined();
      expect(rows[1].kind).toBe("PUT from artifact");
      expect(rows[1].tool).toBe("write_subnet_surface");
      expect(rows[1].arguments).toEqual({
        surface_id: http.id,
        path: "/upload",
        method: "PUT",
        content_type: rows[0].arguments.content_type,
        body_artifact: {
          url: "<public raw.githubusercontent.com URL with a full 40-character commit>",
          sha256: "<lowercase SHA-256 of the complete request bytes>",
          bytes: "<exact complete request byte count, at most 10000000>",
        },
      });
      expect(rows[1].arguments).not.toHaveProperty("body_base64");
    }
  });
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

  it.each([
    [["text/plain", "application/json"], { json_body: {} }],
    [["application/problem+json"], { json_body: {}, content_type: "application/problem+json" }],
    [
      ["application/json; charset=utf-8"],
      { json_body: {}, content_type: "application/json; charset=utf-8" },
    ],
    [["Application/JSON"], { json_body: {}, content_type: "Application/JSON" }],
    [
      ["text/plain"],
      { content_type: "text/plain", body: "<replace with the provider's encoded request body>" },
    ],
    [
      ["application/xml"],
      {
        content_type: "application/xml",
        body: "<replace with the provider's encoded request body>",
      },
    ],
    [
      ["application/vendor+xml"],
      {
        content_type: "application/vendor+xml",
        body: "<replace with the provider's encoded request body>",
      },
    ],
    [
      ["application/x-www-form-urlencoded"],
      {
        content_type: "application/x-www-form-urlencoded",
        body: "<replace with the provider's encoded request body>",
      },
    ],
    [
      ["application/octet-stream"],
      {
        content_type: "application/octet-stream",
        body_base64: "<canonical base64 of the exact request bytes>",
      },
    ],
    [
      ["image/*"],
      {
        content_type: "<replace with a concrete declared content type>",
        body_base64: "<canonical base64 of the exact request bytes>",
      },
    ],
    [
      ["text/*"],
      {
        content_type: "<replace with a concrete declared content type>",
        body_base64: "<canonical base64 of the exact request bytes>",
      },
    ],
    [
      ["multipart/form-data"],
      {
        content_type: "multipart/form-data; boundary=REPLACE_WITH_YOUR_BOUNDARY",
        body_base64: "<canonical base64 of the complete multipart body with the matching boundary>",
      },
    ],
    [
      ["multipart/form-data; boundary=fixed"],
      {
        content_type: "multipart/form-data; boundary=fixed",
        body_base64: "<canonical base64 of the complete multipart body with the matching boundary>",
      },
    ],
  ])("makes a fill-in body template for declared media %j", (request_content_types, expected) => {
    for (const method of ["POST", "PUT", "PATCH"]) {
      const rows = surfaceIntegrationOperations({
        id: http.id,
        http: {
          operations: [
            { method, path: "/run", request_content_types, request_body_required: true },
          ],
        },
      });
      expect(rows).toHaveLength(Object.hasOwn(expected, "body_base64") ? 2 : 1);
      expect(rows[0].arguments).toEqual({ surface_id: http.id, method, path: "/run", ...expected });
      expect(rows[0].body_types).toEqual(request_content_types);
    }
  });

  it("does not invent optional bodies or add bodies to verbs that cannot carry them", () => {
    for (const operation of [
      { method: "POST", path: "/run" },
      { method: "PATCH", path: "/run", request_content_types: ["application/octet-stream"] },
      ...["GET", "DELETE"].map((method) => ({
        method,
        path: "/run",
        request_content_types: ["application/json"],
        request_body_required: true,
      })),
    ]) {
      const rows = surfaceIntegrationOperations({ id: http.id, http: { operations: [operation] } });
      expect(rows[0].tool).toBe(
        operation.method === "GET" ? "call_subnet_surface" : "write_subnet_surface",
      );
      expect(rows[0].arguments).toEqual({
        surface_id: http.id,
        method: operation.method,
        path: operation.path,
      });
    }
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
    expect(html).toContain("Templates with angle-bracket values need those values replaced");
    expect(html).toContain("multipart boundaries must match the encoded body");
  });

  it("keeps an empty or invalid declaration explicit", () => {
    const html = renderToStaticMarkup(<SurfaceIntegrations surfaces={[]} />);
    expect(html).toContain("No valid reviewed operation declarations were returned.");
  });

  it.each([undefined, false, true])(
    "distinguishes reviewed public discovery from execution authentication (%s)",
    (public_discovery) => {
      const source: Surface = {
        ...mcp,
        mcp: { ...(mcp.mcp as object), public_discovery },
      };
      const html = renderToStaticMarkup(
        <QueryClientProvider client={new QueryClient()}>
          <SurfaceIntegrations surfaces={[source]} />
        </QueryClientProvider>,
      );
      expect(html).toContain("Copy Source MCP MCP discovery");
      if (public_discovery === true) {
        expect(html).toContain("Public discovery; caller authentication required for execution");
      } else {
        expect(html).toContain("Caller authentication required");
        expect(html).not.toContain("Public discovery;");
      }
    },
  );

  it("does not label malformed MCP metadata as public discovery alongside HTTP operations", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <SurfaceIntegrations
          surfaces={[
            { ...http, auth_required: true, mcp: { public_discovery: true, read_tools: ["read"] } },
          ]}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("Caller authentication required");
    expect(html).not.toContain("Public discovery;");
    expect(html).not.toContain("Copy Source HTTP MCP discovery");
  });
});
