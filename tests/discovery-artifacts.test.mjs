// Guards the agent/AI discovery artifacts emitted by build-artifacts.mjs:
// the MCP server card (SEP-1649 shape), the Agent Skills discovery index
// (digest must match the shipped SKILL.md), and the honest auth.md. These are
// static ASSETS at api.metagraph.sh, so a drift here ships silently otherwise.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { repoRoot } from "../scripts/lib.mjs";
import { MCP_REGISTRY_NAME, MCP_SERVER_INFO } from "../src/mcp-server.mjs";

const publicDir = path.join(repoRoot, "public");
const readJson = async (rel) =>
  JSON.parse(await fs.readFile(path.join(publicDir, rel), "utf8"));

describe("Discovery artifacts", () => {
  test("MCP server card exposes the SEP-1649 serverInfo block", async () => {
    const card = await readJson(".well-known/mcp/server-card.json");
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
});
