// Developer docs site content generator (#1652).
//
// Produces version-controlled markdown + JSON under docs-site/ for
// docs.metagraph.sh (rendering lives in metagraphed-ui). Generated sections
// are derived from committed contract artifacts so they cannot drift:
//   - API reference + playground metadata ← api-index.json + openapi.json
//   - Subnet catalog ← registry/subnets/*.json (same source as README catalog)
//   - Agent/MCP/resources ← MCP tool list + api-index agent/discovery routes
//
//   node scripts/generate-docs-site.mjs           # write docs-site/
//   node scripts/generate-docs-site.mjs --check   # verify up-to-date (CI gate)

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listToolDefinitions } from "../src/mcp-server.mjs";
import {
  escapeMarkdownCodeSpan,
  markdownLink,
} from "./lib/markdown-escape.mjs";
import {
  DOCS_SAMPLE_DATE,
  buildSampleRouteUrl,
  sampleQueryParams,
  substituteRoutePlaceholders,
} from "./lib/route-samples.mjs";
import { repoRoot } from "./lib.mjs";

const API_BASE = "https://api.metagraph.sh";
const SITE = "https://metagraph.sh";
const DOCS_SITE = "https://docs.metagraph.sh";
const DOCS_ROOT = path.join(repoRoot, "docs-site");
const GENERATED_DIR = path.join(DOCS_ROOT, "generated");
const OPENAPI_PATH = path.join(repoRoot, "public/metagraph/openapi.json");
const API_INDEX_PATH = path.join(repoRoot, "public/metagraph/api-index.json");
const OVERLAYS_DIR = path.join(repoRoot, "registry/subnets");

const PROVENANCE_PREFIX = /^(official|baseline|identity)-/;
const PROVENANCE_EXACT = new Set([
  "pilot",
  "root",
  "system",
  "native-only",
  "macrocosmos",
]);

const ARTIFACT_PATHS = [
  "meta.json",
  "generated/api-reference.md",
  "generated/catalog.md",
  "generated/resources.md",
  "generated/api-playground.json",
];

// Committed to git — large api-reference + api-playground are hash-pinned in
// generated/manifest.json instead (keeps PR diffs reviewable; #1652 slop gate).
const COMMITTED_OUTPUTS = [
  "meta.json",
  "generated/catalog.md",
  "generated/resources.md",
  "generated/manifest.json",
];

const LOCAL_GENERATED_OUTPUTS = [
  "generated/api-reference.md",
  "generated/api-playground.json",
];

export {
  COMMITTED_OUTPUTS as DOCS_SITE_OUTPUTS,
  ARTIFACT_PATHS as DOCS_SITE_ARTIFACTS,
};

export function expectedGeneratedFilenames() {
  return [
    "catalog.md",
    "resources.md",
    "manifest.json",
    ...LOCAL_GENERATED_OUTPUTS.map((relativePath) =>
      relativePath.slice("generated/".length),
    ),
  ];
}

export function listUnexpectedGeneratedFiles(generatedDir = GENERATED_DIR) {
  if (!existsSync(generatedDir)) {
    return [];
  }
  const expected = new Set(expectedGeneratedFilenames());
  return readdirSync(generatedDir).filter((name) => !expected.has(name));
}

export {
  sampleQueryParams,
  substituteRoutePlaceholders,
} from "./lib/route-samples.mjs";

export function exampleRouteUrl(routeOrPath, base = API_BASE) {
  const routePath =
    typeof routeOrPath === "string" ? routeOrPath : routeOrPath.path;
  return buildSampleRouteUrl(routePath, base, { date: DOCS_SAMPLE_DATE });
}

export function routeGroup(routePath) {
  if (routePath.startsWith("/rpc/")) {
    return "rpc";
  }
  const parts = routePath.split("/").filter(Boolean);
  if (parts[0] === "api" && parts[1] === "v1") {
    return parts[2] || "meta";
  }
  return parts[0] || "other";
}

export function loadSubnetOverlays() {
  return readdirSync(OVERLAYS_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) =>
      JSON.parse(readFileSync(path.join(OVERLAYS_DIR, file), "utf8")),
    )
    .filter((overlay) => Number.isInteger(overlay?.netuid))
    .sort((a, b) => a.netuid - b.netuid);
}

function focusTags(overlay) {
  return (overlay.categories || [])
    .filter((tag) => !PROVENANCE_PREFIX.test(tag) && !PROVENANCE_EXACT.has(tag))
    .sort();
}

function subnetLinks(overlay) {
  const out = [];
  if (overlay.website_url) out.push(markdownLink("site", overlay.website_url));
  if (overlay.docs_url) out.push(markdownLink("docs", overlay.docs_url));
  if (overlay.source_repo) out.push(markdownLink("repo", overlay.source_repo));
  return out.join(" · ") || "—";
}

export function renderCatalogMarkdown(overlays) {
  const focusCounts = new Map();
  for (const overlay of overlays) {
    for (const tag of focusTags(overlay)) {
      focusCounts.set(tag, (focusCounts.get(tag) || 0) + 1);
    }
  }
  const topFocus = [...focusCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([tag, count]) => `\`${escapeMarkdownCodeSpan(tag)}\` ${count}`)
    .join(" · ");

  const withSite = overlays.filter((o) => o.website_url).length;
  const withDocs = overlays.filter((o) => o.docs_url).length;
  const withRepo = overlays.filter((o) => o.source_repo).length;

  const items = overlays.map((overlay) => {
    const name = overlay.name || `Subnet ${overlay.netuid}`;
    const focus = focusTags(overlay)
      .map((tag) => `\`${escapeMarkdownCodeSpan(tag)}\``)
      .join(" ");
    const linkStr = subnetLinks(overlay);
    return (
      `- **${markdownLink(name, `${SITE}/subnets/${overlay.netuid}`)}** \`SN${overlay.netuid}\`` +
      (focus ? ` — ${focus}` : "") +
      (linkStr !== "—" ? ` · ${linkStr}` : "")
    );
  });

  return [
    "---",
    "title: Subnet catalog",
    "description: Curated Bittensor subnet overlays from the committed registry.",
    "generated: true",
    "source: registry/subnets/",
    "---",
    "",
    `# Subnet catalog`,
    "",
    `**${overlays.length} curated subnets** — ${withSite} with a site, ${withDocs} with docs, ${withRepo} with a public repo. Live health, search, and the full list at **[metagraph.sh](${SITE})**; per-subnet JSON at \`${API_BASE}/api/v1/subnets/{netuid}\`.`,
    "",
    `**Focus areas:** ${topFocus}`,
    "",
    ...items,
    "",
    `<sub>Auto-generated from \`registry/subnets/\` by \`scripts/generate-docs-site.mjs\`. Enrich a subnet in one PR and it appears here.</sub>`,
    "",
  ].join("\n");
}

function formatQueryParam(param) {
  const schema = param.schema || {};
  const type = schema.enum ? "enum" : schema.type || "string";
  return `- \`${param.name}\` (${type})${param.description ? ` — ${param.description}` : ""}`;
}

function playgroundEntry(route) {
  const samplePath = substituteRoutePlaceholders(route.path);
  const sampleQuery = sampleQueryParams(route.path);
  const tryUrl = route.method === "GET" ? exampleRouteUrl(route) : null;
  return {
    id: route.id,
    method: route.method,
    path: route.path,
    sample_path: samplePath,
    sample_query: sampleQuery,
    description: route.description || null,
    public: route.public !== false,
    query_parameters: (route.query_parameters || []).map((param) => ({
      name: param.name,
      schema: param.schema || {},
      description: param.description || null,
    })),
    try_url: tryUrl,
    curl:
      route.method === "GET"
        ? `curl -s '${tryUrl}'`
        : route.method === "POST"
          ? `curl -s -X POST '${API_BASE}${samplePath}' -H 'content-type: application/json' -d '{}'`
          : null,
  };
}

export function renderApiReferenceMarkdown(apiIndex, openapi) {
  const contractVersion =
    apiIndex.contract_version ||
    openapi["x-metagraphed"]?.contract_version ||
    "unknown";
  const routes = (apiIndex.routes || []).filter(
    (route) => route.public !== false,
  );
  const grouped = new Map();
  for (const route of routes) {
    const group = routeGroup(route.path);
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push(route);
  }

  const groupOrder = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
  const lines = [
    "---",
    "title: API reference",
    "description: Generated from the committed OpenAPI contract and api-index.",
    "generated: true",
    `contract_version: ${contractVersion}`,
    `openapi_url: ${API_BASE}/metagraph/openapi.json`,
    "playground_base: https://api.metagraph.sh",
    "---",
    "",
    "# API reference",
    "",
    `Every route below is generated from \`public/metagraph/api-index.json\` and \`public/metagraph/openapi.json\` (contract \`${contractVersion}\`). Responses use the standard envelope \`{ ok, data, meta, error }\` — see [Auth & rate limits](../guides/auth-and-rate-limits.md).`,
    "",
    `Download the machine contract: [openapi.json](${API_BASE}/metagraph/openapi.json) · typed clients: [@jsonbored/metagraphed](https://www.npmjs.com/package/@jsonbored/metagraphed) · [metagraphed on PyPI](https://pypi.org/project/metagraphed/)`,
    "",
  ];

  for (const group of groupOrder) {
    const groupRoutes = grouped.get(group).sort((a, b) => {
      const pathCmp = a.path.localeCompare(b.path);
      return pathCmp !== 0 ? pathCmp : a.method.localeCompare(b.method);
    });
    lines.push(`## ${group}`, "");
    for (const route of groupRoutes) {
      lines.push(`### \`${route.method} ${route.path}\``, "");
      if (route.description) {
        lines.push(route.description, "");
      }
      if (route.query_parameters?.length) {
        lines.push("**Query parameters**", "");
        for (const param of route.query_parameters) {
          lines.push(formatQueryParam(param));
        }
        lines.push("");
      }
      if (route.method === "GET") {
        const tryUrl = exampleRouteUrl(route);
        lines.push(
          "**Try it**",
          "",
          "```bash",
          `curl -s '${tryUrl}'`,
          "```",
          "",
        );
      } else if (route.method === "POST") {
        const samplePath = substituteRoutePlaceholders(route.path);
        lines.push(
          "**Try it**",
          "",
          "```bash",
          `curl -s -X POST '${API_BASE}${samplePath}' \\`,
          "  -H 'content-type: application/json' \\",
          "  -d '{}'",
          "```",
          "",
        );
      }
      lines.push(
        "<!-- playground:",
        JSON.stringify({
          id: route.id,
          method: route.method,
          path: route.path,
        }),
        "-->",
        "",
      );
    }
  }

  lines.push(
    `<sub>Auto-generated by \`scripts/generate-docs-site.mjs\`. Do not edit — run \`npm run docs-site:generate\` after contract changes.</sub>`,
    "",
  );
  return lines.join("\n");
}

// Agent/discovery routes listed on the resources page — must exist in api-index.
const AGENT_RESOURCE_ROUTE_IDS = new Set([
  "agent-resources",
  "agent-catalog",
  "agent-catalog-subnet",
  "search",
  "search-index",
  "openapi",
  "contracts",
]);

export function resourceRouteTitle(route) {
  if (route.description) {
    const sentence = route.description.split(/[.!]/)[0]?.trim();
    if (sentence) return sentence;
  }
  return route.id;
}

export function buildResourceApiRoutes(routes) {
  const seen = new Set();
  const rows = [];
  for (const route of routes) {
    if (route.public === false || !AGENT_RESOURCE_ROUTE_IDS.has(route.id)) {
      continue;
    }
    if (seen.has(route.id)) continue;
    seen.add(route.id);
    rows.push({
      id: route.id,
      title: resourceRouteTitle(route),
      kind: "api",
      method: route.method,
      path: route.path,
      url:
        route.method === "GET"
          ? exampleRouteUrl(route)
          : `${API_BASE}${substituteRoutePlaceholders(route.path)}`,
    });
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export function renderResourcesMarkdown(tools, routes) {
  const apiResources = buildResourceApiRoutes(routes);
  const agentResources = apiResources.find(
    (resource) => resource.id === "agent-resources",
  );

  const lines = [
    "---",
    "title: Agent & MCP resources",
    "description: Machine-readable surfaces for AI agents and integrators.",
    "generated: true",
    "source: public/metagraph/api-index.json",
    "---",
    "",
    "# Agent & MCP resources",
    "",
    "Metagraphed exposes a rich AI-native layer alongside the REST API. Use these URLs from agents, IDE plugins, and automation.",
    "",
    "## MCP server",
    "",
    `- **Endpoint:** \`${API_BASE}/mcp\` (Streamable HTTP)`,
    `- **Install:** \`claude mcp add --transport http metagraphed ${API_BASE}/mcp\``,
    `- **Server card:** [/.well-known/mcp/server-card.json](${API_BASE}/.well-known/mcp/server-card.json)`,
    "",
    `**${tools.length} tools** (from the committed MCP server — cannot drift from \`POST /mcp\`):`,
    "",
    ...tools.map(
      (tool) => `- \`${tool.name}\`${tool.title ? ` — ${tool.title}` : ""}`,
    ),
    "",
    "## Contract API routes",
    "",
    "Every API URL below is derived from [`public/metagraph/api-index.json`](../../public/metagraph/api-index.json) — the same contract source as the [API reference](./api-reference.md) freshness gate.",
    agentResources
      ? `For copyable agent prompts, skills, llms.txt, and other discovery URLs, fetch [${agentResources.url}](${agentResources.url}) (\`GET ${agentResources.path}\`).`
      : "",
    "",
    "| Route | Method | URL |",
    "| --- | --- | --- |",
    ...apiResources.map(
      (resource) =>
        `| \`${resource.path}\` | ${resource.method} | [${resource.url}](${resource.url}) |`,
    ),
    "",
    `<sub>Auto-generated by \`scripts/generate-docs-site.mjs\`. MCP tools from \`listToolDefinitions()\`; API rows from \`api-index.json\` route ids: ${[...AGENT_RESOURCE_ROUTE_IDS].sort().join(", ")}.</sub>`,
    "",
  ];
  return lines.join("\n");
}

export function buildMeta(apiIndex, openapi, overlays) {
  const contractVersion =
    apiIndex.contract_version ||
    openapi["x-metagraphed"]?.contract_version ||
    "unknown";
  return {
    schema_version: 1,
    site_url: DOCS_SITE,
    api_base: API_BASE,
    product_url: SITE,
    contract_version: contractVersion,
    sources: {
      openapi: "public/metagraph/openapi.json",
      api_index: "public/metagraph/api-index.json",
      registry: "registry/subnets/",
      mcp: "src/mcp-server.mjs",
    },
    nav: [
      { title: "Quickstart", path: "guides/quickstart.md", generated: false },
      {
        title: "Contributing surfaces",
        path: "guides/contributing.md",
        generated: false,
      },
      {
        title: "Auth & rate limits",
        path: "guides/auth-and-rate-limits.md",
        generated: false,
      },
      { title: "Data model", path: "guides/data-model.md", generated: false },
      {
        title: "API reference",
        path: "generated/api-reference.md",
        generated: true,
      },
      {
        title: "API playground data",
        path: "generated/api-playground.json",
        generated: true,
      },
      {
        title: "Subnet catalog",
        path: "generated/catalog.md",
        generated: true,
      },
      {
        title: "Agent & MCP resources",
        path: "generated/resources.md",
        generated: true,
      },
    ],
    stats: {
      route_count: (apiIndex.routes || []).filter((r) => r.public !== false)
        .length,
      subnet_overlay_count: overlays.length,
      mcp_tool_count: listToolDefinitions().length,
    },
  };
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function buildManifest(contentByRelativePath) {
  const artifacts = {};
  for (const relativePath of ARTIFACT_PATHS) {
    const content = contentByRelativePath[relativePath];
    artifacts[relativePath] = {
      sha256: sha256(content),
      bytes: Buffer.byteLength(content, "utf8"),
    };
  }
  return {
    schema_version: 1,
    generator: "scripts/generate-docs-site.mjs",
    artifacts,
  };
}

export function generateDocsSiteContent() {
  const openapi = JSON.parse(readFileSync(OPENAPI_PATH, "utf8"));
  const apiIndex = JSON.parse(readFileSync(API_INDEX_PATH, "utf8"));
  const overlays = loadSubnetOverlays();
  const tools = listToolDefinitions();
  const routes = (apiIndex.routes || []).filter(
    (route) => route.public !== false,
  );

  const content = {
    "meta.json": `${JSON.stringify(buildMeta(apiIndex, openapi, overlays), null, 2)}\n`,
    "generated/api-reference.md": renderApiReferenceMarkdown(apiIndex, openapi),
    "generated/catalog.md": renderCatalogMarkdown(overlays),
    "generated/resources.md": renderResourcesMarkdown(tools, routes),
    "generated/api-playground.json": `${JSON.stringify(
      {
        schema_version: 1,
        base_url: API_BASE,
        contract_version:
          apiIndex.contract_version ||
          openapi["x-metagraphed"]?.contract_version ||
          "unknown",
        routes: routes.map(playgroundEntry),
      },
      null,
      2,
    )}\n`,
  };
  content["generated/manifest.json"] =
    `${JSON.stringify(buildManifest(content), null, 2)}\n`;
  return content;
}

function writeOutputs(contentByRelativePath) {
  mkdirSync(GENERATED_DIR, { recursive: true });
  for (const relativePath of [...ARTIFACT_PATHS, "generated/manifest.json"]) {
    const fullPath = path.join(DOCS_ROOT, relativePath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, contentByRelativePath[relativePath], "utf8");
  }
}

function readCommittedOutputs() {
  const current = {};
  for (const relativePath of COMMITTED_OUTPUTS) {
    const fullPath = path.join(DOCS_ROOT, relativePath);
    try {
      current[relativePath] = readFileSync(fullPath, "utf8");
    } catch {
      return null;
    }
  }
  return current;
}

function manifestMatches(contentByRelativePath, manifestText) {
  const manifest = JSON.parse(manifestText);
  for (const relativePath of ARTIFACT_PATHS) {
    const expected = manifest.artifacts?.[relativePath];
    const content = contentByRelativePath[relativePath];
    if (!expected || expected.sha256 !== sha256(content)) {
      return relativePath;
    }
  }
  return null;
}

function main() {
  const check = process.argv.includes("--check");
  const next = generateDocsSiteContent();

  if (check) {
    const unexpected = listUnexpectedGeneratedFiles();
    if (unexpected.length) {
      console.error(
        `Unexpected files in docs-site/generated/: ${unexpected.join(", ")}. Remove them or add them to DOCS_SITE_OUTPUTS.`,
      );
      process.exit(1);
    }
    const current = readCommittedOutputs();
    if (!current) {
      console.error(
        "Docs site is missing committed files. Run `npm run docs-site:generate` and commit docs-site/ (meta.json, generated/catalog.md, generated/resources.md, generated/manifest.json).",
      );
      process.exit(1);
    }
    const staleCommitted = COMMITTED_OUTPUTS.filter(
      (relativePath) => current[relativePath] !== next[relativePath],
    );
    if (staleCommitted.length) {
      console.error(
        `Docs site is stale (${staleCommitted.join(", ")}). Run \`npm run docs-site:generate\` and commit docs-site/.`,
      );
      for (const relativePath of staleCommitted) {
        console.error(
          `  ${relativePath}: current=${sha256(current[relativePath]).slice(0, 12)} next=${sha256(next[relativePath]).slice(0, 12)}`,
        );
      }
      process.exit(1);
    }
    const manifestMismatch = manifestMatches(
      next,
      current["generated/manifest.json"],
    );
    if (manifestMismatch) {
      console.error(
        `Docs site manifest is stale for ${manifestMismatch}. Run \`npm run docs-site:generate\` and commit generated/manifest.json.`,
      );
      process.exit(1);
    }
    console.log(
      `Docs site up to date (${next["meta.json"] ? JSON.parse(next["meta.json"]).stats.route_count : "?"} routes, ${JSON.parse(next["meta.json"]).stats.subnet_overlay_count} subnet overlays).`,
    );
    return;
  }

  writeOutputs(next);
  const meta = JSON.parse(next["meta.json"]);
  console.log(
    `Wrote docs site: ${meta.stats.route_count} routes, ${meta.stats.subnet_overlay_count} subnets, ${meta.stats.mcp_tool_count} MCP tools.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
