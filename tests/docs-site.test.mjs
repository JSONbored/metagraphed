import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DOCS_SITE_ARTIFACTS,
  DOCS_SITE_OUTPUTS,
  buildManifest,
  buildMeta,
  buildResourceApiRoutes,
  exampleRouteUrl,
  generateDocsSiteContent,
  listUnexpectedGeneratedFiles,
  loadSubnetOverlays,
  renderApiReferenceMarkdown,
  renderCatalogMarkdown,
  renderResourcesMarkdown,
  routeGroup,
  sampleQueryParams,
  substituteRoutePlaceholders,
} from "../scripts/generate-docs-site.mjs";
import { DOCS_SAMPLE_DATE } from "../scripts/lib/route-samples.mjs";
import { apiRouteUrl } from "../scripts/smoke-live-api.mjs";
import { listToolDefinitions } from "../src/mcp-server.mjs";

const DOCS_ROOT = path.join(process.cwd(), "docs-site");
const GENERATED_DIR = path.join(DOCS_ROOT, "generated");
const OPENAPI_PATH = path.join(process.cwd(), "public/metagraph/openapi.json");
const API_INDEX_PATH = path.join(
  process.cwd(),
  "public/metagraph/api-index.json",
);

function publicRoutes() {
  return JSON.parse(readFileSync(API_INDEX_PATH, "utf8")).routes.filter(
    (route) => route.public !== false,
  );
}

function loadContractArtifacts() {
  const openapi = JSON.parse(readFileSync(OPENAPI_PATH, "utf8"));
  const apiIndex = JSON.parse(readFileSync(API_INDEX_PATH, "utf8"));
  return { openapi, apiIndex };
}

function urlPathAndQuery(url) {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

describe("generate-docs-site", () => {
  it("groups routes by api segment", () => {
    expect(routeGroup("/api/v1/subnets")).toBe("subnets");
    expect(routeGroup("/api/v1/subnets/7/health")).toBe("subnets");
    expect(routeGroup("/api/v1/blocks/123")).toBe("blocks");
    expect(routeGroup("/rpc/v1/finney")).toBe("rpc");
  });

  it("substitutes typed route placeholders for try-it examples", () => {
    expect(substituteRoutePlaceholders("/api/v1/subnets/{netuid}")).toBe(
      "/api/v1/subnets/7",
    );
    expect(substituteRoutePlaceholders("/api/v1/accounts/{ss58}")).toBe(
      "/api/v1/accounts/5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM",
    );
    expect(substituteRoutePlaceholders("/api/v1/extrinsics/{hash}")).toBe(
      `/api/v1/extrinsics/0x${"0".repeat(64)}`,
    );
    expect(exampleRouteUrl("/api/v1/blocks/{ref}")).toBe(
      "https://api.metagraph.sh/api/v1/blocks/0",
    );
    expect(exampleRouteUrl("/api/v1/compare")).toBe(
      "https://api.metagraph.sh/api/v1/compare?netuids=7%2C8",
    );
  });

  it("renders a catalog with subnet markers", () => {
    const overlays = loadSubnetOverlays().slice(0, 3);
    const markdown = renderCatalogMarkdown(overlays);
    expect(markdown).toContain("generated: true");
    expect(markdown).toContain("SN" + overlays[0].netuid);
    expect(markdown).toContain("metagraph.sh/subnets/");
  });

  it("escapes registry-derived catalog markdown", () => {
    const markdown = renderCatalogMarkdown([
      {
        netuid: 99,
        name: "Evil [link](http://bad/)",
        categories: ["tag]break", "tag`break", "a``b"],
        website_url: "https://example.com/path(with)parens",
      },
    ]);
    expect(markdown).toContain("Evil \\[link\\]");
    expect(markdown).toContain("`tag]break`");
    expect(markdown).toContain("``tag`break``");
    expect(markdown).toContain("```a``b```");
    expect(markdown).toContain("path(with%29parens");
  });

  it("docs-site/generated contains only expected committed outputs", () => {
    expect(listUnexpectedGeneratedFiles(GENERATED_DIR)).toEqual([]);
  });

  it("sampleQueryParams matches smoke-live-api list and compare routes", () => {
    expect(sampleQueryParams("/api/v1/subnets")).toEqual({
      limit: "3",
      sort: "netuid",
    });
    expect(sampleQueryParams("/api/v1/compare")).toEqual({ netuids: "7,8" });
    expect(sampleQueryParams("/api/v1/search")).toEqual({ limit: "3" });
    expect(sampleQueryParams("/api/v1/blocks/{ref}")).toEqual({});
  });

  it("renderApiReferenceMarkdown includes every public route", () => {
    const { openapi, apiIndex } = loadContractArtifacts();
    const markdown = renderApiReferenceMarkdown(apiIndex, openapi);
    for (const route of publicRoutes()) {
      expect(markdown).toContain(`\`${route.method} ${route.path}\``);
    }
  });

  it("renderResourcesMarkdown API table rows match buildResourceApiRoutes", () => {
    const routes = publicRoutes();
    const tools = listToolDefinitions();
    const markdown = renderResourcesMarkdown(tools, routes);
    const rows = buildResourceApiRoutes(routes);
    for (const row of rows) {
      expect(markdown).toContain(`| \`${row.path}\` | ${row.method} |`);
    }
    expect(markdown.match(/^\| `\/api\/v1\//gm)?.length).toBe(rows.length);
  });

  it("buildMeta records contract sources and route stats", () => {
    const { openapi, apiIndex } = loadContractArtifacts();
    const overlays = loadSubnetOverlays();
    const meta = buildMeta(apiIndex, openapi, overlays);
    expect(meta.sources.api_index).toBe("public/metagraph/api-index.json");
    expect(meta.stats.route_count).toBe(publicRoutes().length);
    expect(meta.stats.mcp_tool_count).toBe(listToolDefinitions().length);
  });

  it("validate:docs-site --check passes on committed outputs", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/generate-docs-site.mjs", "--check"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Docs site up to date");
  });

  it("builds resource API rows only from api-index routes", () => {
    const routes = publicRoutes();
    const rows = buildResourceApiRoutes(routes);
    const ids = rows.map((row) => row.id);
    expect(ids).toEqual(
      expect.arrayContaining(["agent-resources", "agent-catalog", "openapi"]),
    );
    expect(ids).not.toContain("graphql");
    for (const row of rows) {
      expect(
        routes.some((route) => route.id === row.id && route.path === row.path),
      ).toBe(true);
    }
  });

  it("resources markdown excludes uncontracted API paths", () => {
    const content = generateDocsSiteContent();
    const markdown = content["generated/resources.md"];
    expect(markdown).not.toContain("/api/v1/graphql");
    expect(markdown).not.toContain("/api/v1/search/semantic");
    expect(markdown).not.toContain("/api/v1/ask");
    expect(markdown).toContain("/api/v1/agent-resources");
    expect(markdown).toContain("api-index.json");
  });

  it("committed docs-site outputs match generator (validate:docs-site contract)", () => {
    const content = generateDocsSiteContent();
    for (const relativePath of DOCS_SITE_OUTPUTS) {
      const committed = readFileSync(
        path.join(DOCS_ROOT, relativePath),
        "utf8",
      );
      expect(committed).toBe(content[relativePath]);
    }
  });

  it("manifest pins large local-only generated artifacts", () => {
    const content = generateDocsSiteContent();
    const manifest = buildManifest(content);
    for (const relativePath of [
      "generated/api-reference.md",
      "generated/api-playground.json",
    ]) {
      expect(manifest.artifacts[relativePath].sha256).toHaveLength(64);
      expect(manifest.artifacts[relativePath].bytes).toBeGreaterThan(1000);
    }
    expect(JSON.parse(content["generated/manifest.json"])).toEqual(manifest);
  });

  it("try-it URLs stay aligned with smoke-live-api sample ids and query params", () => {
    const routes = publicRoutes();
    for (const route of routes) {
      if (route.path.includes("{date}")) continue;
      if (route.method !== "GET") continue;
      expect(urlPathAndQuery(exampleRouteUrl(route))).toBe(
        urlPathAndQuery(apiRouteUrl(route.path, DOCS_SAMPLE_DATE)),
      );
    }
  });

  it("every public GET route has a fully substituted try-it URL", () => {
    for (const route of publicRoutes()) {
      if (route.method !== "GET") continue;
      const url = exampleRouteUrl(route);
      expect(url, route.path).not.toMatch(/\{[^}]+\}/);
    }
  });

  it("api-playground entries cover every public api-index route", () => {
    const content = generateDocsSiteContent();
    const playground = JSON.parse(content["generated/api-playground.json"]);
    const routes = publicRoutes();
    expect(playground.routes).toHaveLength(routes.length);
    for (const route of routes) {
      expect(
        playground.routes.find(
          (entry) =>
            entry.id === route.id &&
            entry.method === route.method &&
            entry.path === route.path,
        ),
      ).toBeDefined();
    }
  });

  it("generates committed docs-site outputs with expected keys", () => {
    const content = generateDocsSiteContent();
    expect(Object.keys(content).sort()).toEqual(
      [...DOCS_SITE_ARTIFACTS, "generated/manifest.json"].sort(),
    );
    const meta = JSON.parse(content["meta.json"]);
    expect(meta.schema_version).toBe(1);
    expect(meta.site_url).toBe("https://docs.metagraph.sh");
    expect(meta.stats.route_count).toBeGreaterThan(50);
    expect(meta.stats.mcp_tool_count).toBeGreaterThan(10);

    const playground = JSON.parse(content["generated/api-playground.json"]);
    expect(playground.base_url).toBe("https://api.metagraph.sh");
    expect(playground.routes.length).toBe(meta.stats.route_count);
    expect(playground.routes[0]).toMatchObject({
      method: expect.any(String),
      path: expect.stringMatching(/^\//),
    });

    expect(content["generated/api-reference.md"]).toContain("# API reference");
    expect(content["generated/api-reference.md"]).toContain(
      "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM",
    );
    expect(content["generated/api-reference.md"]).toContain(
      "api/v1/compare?netuids=7",
    );
    const compareEntry = playground.routes.find(
      (route) => route.id === "compare",
    );
    expect(compareEntry?.sample_query).toEqual({ netuids: "7,8" });
    expect(compareEntry?.try_url).toContain("netuids=7");
    expect(content["generated/resources.md"]).toContain("MCP server");
  });
});
