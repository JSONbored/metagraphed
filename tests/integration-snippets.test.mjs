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

describe("generateServiceSnippets structured auth (#746)", () => {
  const base = { base_url: "https://api.example.com/v1", auth_required: true };

  test("structured header auth uses the exact header name + placeholder", () => {
    const out = generateServiceSnippets({
      ...base,
      auth: {
        scheme: "api-key",
        location: "header",
        name: "X-API-Key",
        value_format: "<api-key>",
      },
    });
    assert.match(out.curl, /-H 'X-API-Key: <api-key>'/);
    assert.match(out.python, /"X-API-Key": "<api-key>"/);
    assert.match(out.typescript, /"X-API-Key": "<api-key>"/);
  });

  test("structured query auth puts the credential on the URL, not a header", () => {
    const out = generateServiceSnippets({
      ...base,
      auth: {
        scheme: "api-key",
        location: "query",
        name: "api_key",
        value_format: "YOUR_API_KEY",
      },
    });
    assert.match(out.curl, /\?api_key=YOUR_API_KEY/);
    assert.doesNotMatch(out.curl, /-H /);
    assert.match(out.python, /\?api_key=YOUR_API_KEY/);
  });

  test("appends with & when the base URL already has a query string", () => {
    const out = generateServiceSnippets({
      ...base,
      base_url: "https://api.example.com/v1?v=2",
      auth: { scheme: "api-key", location: "query", name: "key" },
    });
    assert.match(out.curl, /\?v=2&key=YOUR_API_KEY/);
  });

  test("structured auth wins over the scheme-type guess", () => {
    const out = generateServiceSnippets({
      ...base,
      auth_schemes: ["http"], // would guess Authorization: Bearer
      auth: {
        scheme: "api-key",
        location: "header",
        name: "X-Custom-Key",
        value_format: "<key>",
      },
    });
    assert.match(out.curl, /X-Custom-Key/);
    assert.doesNotMatch(out.curl, /Authorization/);
  });

  test("scheme:none yields a plain GET even when auth_required is set", () => {
    const out = generateServiceSnippets({
      ...base,
      auth: { scheme: "none" },
    });
    assert.doesNotMatch(out.curl, /-H /);
  });

  test("rejects a placeholder that could break snippet quoting", () => {
    const out = generateServiceSnippets({
      ...base,
      auth: {
        scheme: "api-key",
        location: "header",
        name: "X-API-Key",
        value_format: "x'; rm -rf /",
      },
    });
    // unsafe placeholder is dropped → falls back to a plain GET, never injected
    assert.doesNotMatch(out.curl, /rm -rf/);
  });

  test("fills scheme-appropriate placeholders when value_format is omitted", () => {
    const bearer = generateServiceSnippets({
      ...base,
      auth: { scheme: "bearer" },
    });
    assert.match(bearer.curl, /-H 'Authorization: Bearer YOUR_API_KEY'/);
    const basic = generateServiceSnippets({
      ...base,
      auth: { scheme: "basic" },
    });
    assert.match(basic.curl, /Authorization: Basic <base64/);
    // query api-key with no name defaults the param to api_key
    const key = generateServiceSnippets({
      ...base,
      auth: { scheme: "api-key", location: "query" },
    });
    assert.match(key.curl, /\?api_key=YOUR_API_KEY/);
  });
});
