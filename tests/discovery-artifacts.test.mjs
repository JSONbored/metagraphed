// Guards the agent/AI discovery artifacts emitted by build-artifacts.ts:
// the Agent Skills discovery index (digest must match the shipped SKILL.md)
// and the honest auth.md. The MCP server card (SEP-1649) is now worker-computed
// and tested via mcpServerCardResponse rather than read from a committed file.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { repoRoot, loadSubnets } from "../scripts/lib.ts";
import { PRIMARY_DOMAIN } from "../src/contracts.mjs";
import { MCP_REGISTRY_NAME, MCP_SERVER_INFO } from "../src/mcp-server.mjs";
import { mcpServerCardResponse } from "../workers/request-handlers/discovery.ts";

const publicDir = path.join(repoRoot, "public");
const readJson = async (rel) =>
  JSON.parse(await fs.readFile(path.join(publicDir, rel), "utf8"));

describe("Discovery artifacts", () => {
  test("MCP server card exposes the SEP-1649 serverInfo block", async () => {
    // Card is now worker-computed; test via the handler (no committed file).
    const res = await mcpServerCardResponse(
      new Request("https://api.metagraph.sh/.well-known/mcp/server-card.json"),
      {},
    );
    assert.equal(res.status, 200);
    const card = await res.json();
    assert.deepEqual(card.serverInfo, {
      name: MCP_SERVER_INFO.name,
      version: MCP_SERVER_INFO.version,
    });
    assert.equal(card.endpoint, "https://api.metagraph.sh/mcp");
    assert.equal(card.transport, "streamable-http");
    assert.ok(card.capabilities?.tools, "card must advertise tool capability");
    // Bidirectional registry backlink, under our own domain namespace (not the
    // registry-reserved io.modelcontextprotocol.registry/* namespace).
    assert.equal(
      card._meta?.["io.github.JSONbored/registry-name"],
      MCP_REGISTRY_NAME,
    );
  });

  test("mcp.json mirrors the registry backlink", async () => {
    const doc = await readJson(".well-known/mcp.json");
    assert.equal(
      doc.servers?.[0]?._meta?.["io.github.JSONbored/registry-name"],
      MCP_REGISTRY_NAME,
    );
  });

  test("agent-skills index matches the discovery shape", async () => {
    const index = await readJson(".well-known/agent-skills/index.json");
    // Self-hosted, dereferenceable schema (the official agentskills.io spec has
    // no discovery-index schema; the old schemas.agentskills.io host is dead).
    assert.equal(
      index.$schema,
      "https://api.metagraph.sh/.well-known/agent-skills/schema.json",
    );
    assert.ok(Array.isArray(index.skills) && index.skills.length > 0);
    for (const skill of index.skills) {
      assert.match(skill.name, /^[a-z0-9-]+$/);
      assert.equal(skill.type, "skill-md");
      assert.ok(skill.description.length > 0);
      assert.match(skill.url, /^https:\/\/api\.metagraph\.sh\/skills\//);
      assert.match(skill.digest, /^sha256:[0-9a-f]{64}$/);
      // The digest must be the real hash of the shipped SKILL.md.
      const rel = new URL(skill.url).pathname.replace(/^\//, "");
      const body = await fs.readFile(path.join(publicDir, rel), "utf8");
      const expected = createHash("sha256").update(body).digest("hex");
      assert.equal(skill.digest, `sha256:${expected}`, skill.name);
    }
  });

  test("agent-skills index validates against its self-hosted schema", async () => {
    const schema = await readJson(".well-known/agent-skills/schema.json");
    const index = await readJson(".well-known/agent-skills/index.json");
    // The schema is served at the exact URL the index's $schema points to, so a
    // validator that dereferences $schema fetches this file and succeeds.
    assert.equal(schema.$id, index.$schema);
    assert.equal(
      schema.$schema,
      "https://json-schema.org/draft/2020-12/schema",
    );
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    assert.ok(
      validate(index),
      `index must validate: ${JSON.stringify(validate.errors)}`,
    );
  });

  test("auth.md states the API is unauthenticated", async () => {
    const authMd = await fs.readFile(path.join(publicDir, "auth.md"), "utf8");
    assert.match(authMd, /public and read-only/i);
    assert.match(authMd, /No authentication/i);
  });

  test("security.txt follows RFC 9116 (contact, expires, canonical)", async () => {
    const txt = await fs.readFile(
      path.join(publicDir, ".well-known/security.txt"),
      "utf8",
    );
    const field = (name) =>
      txt.match(new RegExp(`^${name}:\\s*(.+)$`, "mi"))?.[1]?.trim();
    // Contact is REQUIRED by RFC 9116; it must be the private advisory channel
    // documented in SECURITY.md (never a public issue / personal address).
    assert.equal(
      field("Contact"),
      "https://github.com/JSONbored/metagraphed/security/advisories/new",
    );
    // Expires is REQUIRED and must be a valid future ISO-8601 instant. Compared
    // against a fixed baseline (not wall-clock) so the gate stays deterministic;
    // renewing the date before it lapses is a calendar maintenance task.
    const expires = field("Expires");
    assert.ok(expires, "security.txt must declare Expires");
    assert.ok(
      !Number.isNaN(Date.parse(expires)),
      "Expires must be ISO-8601 parseable",
    );
    assert.ok(
      Date.parse(expires) > Date.parse("2026-06-13T00:00:00.000Z"),
      "Expires must be in the future",
    );
    // Canonical must point at this backend's served copy.
    assert.equal(
      field("Canonical"),
      "https://api.metagraph.sh/.well-known/security.txt",
    );
  });

  test("sitemap.xml is well-formed and namespaced", async () => {
    const xml = await fs.readFile(path.join(publicDir, "sitemap.xml"), "utf8");
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(
      xml,
      /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/,
    );
    assert.match(xml, /<\/urlset>\s*$/);
    // Every <loc> is an absolute https URL under the API's primary domain.
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    assert.ok(locs.length > 0, "sitemap must contain <url> entries");
    for (const loc of locs) {
      assert.ok(
        loc.startsWith(`https://${PRIMARY_DOMAIN}/`),
        `sitemap loc is off-domain: ${loc}`,
      );
      assert.doesNotThrow(() => new URL(loc), `sitemap loc not a URL: ${loc}`);
    }
  });

  test("sitemap.xml lists the fixed machine-surface URLs", async () => {
    const xml = await fs.readFile(path.join(publicDir, "sitemap.xml"), "utf8");
    const base = `https://${PRIMARY_DOMAIN}`;
    for (const surface of [
      "llms.txt",
      "llms-full.txt",
      "agent.md",
      "agent-workflows.md",
      "auth.md",
      "metagraph/openapi.json",
    ]) {
      assert.ok(
        xml.includes(`<loc>${base}/${surface}</loc>`),
        `sitemap missing machine surface: ${surface}`,
      );
    }
  });

  test("sitemap.xml has exactly one agent-catalog entry per registered subnet", async () => {
    const xml = await fs.readFile(path.join(publicDir, "sitemap.xml"), "utf8");
    const base = `https://${PRIMARY_DOMAIN}`;
    const subnets = await loadSubnets();
    // Per-subnet locs are agent-catalog/{netuid}; the bare /api/v1/agent-catalog
    // index entry (no trailing netuid) is deliberately excluded here.
    const perSubnet = [
      ...xml.matchAll(/<loc>[^<]*\/api\/v1\/agent-catalog\/(\d+)<\/loc>/g),
    ]
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    const expected = subnets.map((s) => s.netuid).sort((a, b) => a - b);
    // One entry per subnet, no duplicates, no orphaned/off-registry netuid.
    assert.deepEqual(perSubnet, expected);
    for (const netuid of expected) {
      assert.ok(
        xml.includes(`<loc>${base}/api/v1/agent-catalog/${netuid}</loc>`),
        `sitemap missing agent-catalog entry for SN${netuid}`,
      );
    }
  });

  test("robots.txt Sitemap points at sitemap.xml under the primary domain", async () => {
    const txt = await fs.readFile(path.join(publicDir, "robots.txt"), "utf8");
    const sitemapLine = txt.match(/^Sitemap:\s*(.+)$/im)?.[1]?.trim();
    // Catches robots.txt and sitemap.xml drifting out of sync with each other.
    assert.equal(sitemapLine, `https://${PRIMARY_DOMAIN}/sitemap.xml`);
  });
});
