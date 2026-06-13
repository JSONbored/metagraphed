import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { generateServiceSnippets } from "../src/integration-snippets.mjs";

describe("generateServiceSnippets (#351)", () => {
  test("no-auth service: plain GET in all three languages", () => {
    const out = generateServiceSnippets({
      base_url: "https://api.example.io/health",
      auth_required: false,
    });
    assert.equal(out.curl, "curl -sS 'https://api.example.io/health'");
    assert.match(out.python, /import requests/);
    assert.match(
      out.python,
      /requests\.get\("https:\/\/api\.example\.io\/health"\)/,
    );
    assert.ok(!out.python.includes("headers="));
    assert.match(
      out.typescript,
      /await fetch\("https:\/\/api\.example\.io\/health"\)/,
    );
    assert.ok(!out.typescript.includes("headers"));
  });

  test("apiKey scheme → X-API-Key header placeholder", () => {
    const out = generateServiceSnippets({
      base_url: "https://api.example.io/v1",
      auth_required: true,
      auth_schemes: ["apiKey"],
    });
    assert.match(out.curl, /-H 'X-API-Key: YOUR_API_KEY'/);
    assert.match(out.python, /"X-API-Key": "YOUR_API_KEY"/);
    assert.match(out.typescript, /"X-API-Key": "YOUR_API_KEY"/);
  });

  test("http/bearer/oauth2 schemes → Authorization: Bearer placeholder", () => {
    for (const scheme of ["http", "bearer", "oauth2", "openIdConnect"]) {
      const out = generateServiceSnippets({
        base_url: "https://api.example.io/v1",
        auth_required: true,
        auth_schemes: [scheme],
      });
      assert.match(out.curl, /Authorization: Bearer YOUR_API_KEY/, scheme);
    }
  });

  test("auth required but scheme unknown → generic bearer placeholder", () => {
    const out = generateServiceSnippets({
      base_url: "https://api.example.io/v1",
      auth_required: true,
      auth_schemes: ["mutualTLS"],
    });
    assert.match(out.curl, /Authorization: Bearer YOUR_API_KEY/);
  });

  test("does not include credential placeholders for cleartext auth URLs", () => {
    for (const base_url of [
      "http://api.example.io/v1",
      "ws://api.example.io/socket",
    ]) {
      const out = generateServiceSnippets({
        base_url,
        auth_required: true,
        auth_schemes: ["apiKey"],
      });

      assert.equal(out.curl, `curl -sS '${base_url}'`);
      assert.ok(!out.curl.includes("YOUR_API_KEY"));
      assert.ok(!out.python.includes("YOUR_API_KEY"));
      assert.ok(!out.typescript.includes("YOUR_API_KEY"));
      assert.ok(!out.python.includes("headers="));
      assert.ok(!out.typescript.includes("headers"));
    }
  });

  test("allows credential placeholders for TLS-protected wss URLs", () => {
    const out = generateServiceSnippets({
      base_url: "wss://api.example.io/socket",
      auth_required: true,
      auth_schemes: ["bearer"],
    });

    assert.match(out.curl, /Authorization: Bearer YOUR_API_KEY/);
    assert.match(out.python, /Authorization/);
    assert.match(out.typescript, /Authorization/);
  });

  test("returns null for missing or unsafe base_url", () => {
    assert.equal(generateServiceSnippets({ base_url: null }), null);
    assert.equal(generateServiceSnippets({}), null);
    assert.equal(generateServiceSnippets(null), null);
    // a URL that could break out of the snippet quoting is rejected
    assert.equal(
      generateServiceSnippets({ base_url: "https://x.io/'; rm -rf /" }),
      null,
    );
    assert.equal(
      generateServiceSnippets({ base_url: "https://x.io/a b" }),
      null,
    );
  });
});
