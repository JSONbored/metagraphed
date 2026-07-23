import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { generateServiceSnippets } from "../src/integration-snippets.ts";
import type { Row } from "./row-type.ts";

describe("generateServiceSnippets (#351)", () => {
  test("no-auth service: plain GET in all three languages", () => {
    const out = generateServiceSnippets({
      base_url: "https://api.example.io/health",
      auth_required: false,
    }) as Row;
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
    }) as Row;
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
      }) as Row;
      assert.match(out.curl, /Authorization: Bearer YOUR_API_KEY/, scheme);
    }
  });

  test("auth required but scheme unknown → generic bearer placeholder", () => {
    const out = generateServiceSnippets({
      base_url: "https://api.example.io/v1",
      auth_required: true,
      auth_schemes: ["mutualTLS"],
    }) as Row;
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
      }) as Row;

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
    }) as Row;

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
    }) as Row;
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
    }) as Row;
    assert.match(out.curl, /\?api_key=YOUR_API_KEY/);
    assert.doesNotMatch(out.curl, /-H /);
    assert.match(out.python, /\?api_key=YOUR_API_KEY/);
  });

  test("appends with & when the base URL already has a query string", () => {
    const out = generateServiceSnippets({
      ...base,
      base_url: "https://api.example.com/v1?v=2",
      auth: { scheme: "api-key", location: "query", name: "key" },
    }) as Row;
    assert.match(out.curl, /\?v=2&key=YOUR_API_KEY/);
  });

  test("query auth with a spaced placeholder is encoded, not suppressed", () => {
    const out = generateServiceSnippets({
      ...base,
      auth: {
        scheme: "api-key",
        location: "query",
        name: "api key",
        value_format: "<your api key>",
      },
    }) as Row;
    // Before the fix the raw space tripped isSnippetSafeUrl → null (no snippets).
    assert.ok(out);
    assert.match(out.curl, /\?api%20key=%3Cyour%20api%20key%3E/);
    assert.match(out.python, /\?api%20key=%3Cyour%20api%20key%3E/);
  });

  test("query bearer default value (has a space) still yields snippets", () => {
    const out = generateServiceSnippets({
      ...base,
      auth: { scheme: "bearer", location: "query" },
    }) as Row;
    assert.ok(out);
    assert.match(out.curl, /\?api_key=Bearer%20YOUR_API_KEY/);
  });

  test("malformed UTF-16 in query auth is dropped without throwing", () => {
    let out: Row | undefined;
    assert.doesNotThrow(() => {
      out = generateServiceSnippets({
        ...base,
        auth: {
          scheme: "api-key",
          location: "query",
          name: "\uD800",
          value_format: "<api-key>",
        },
      }) as Row;
    });
    assert.equal(out!.curl, "curl -sS 'https://api.example.com/v1'");

    out = generateServiceSnippets({
      ...base,
      auth: {
        scheme: "api-key",
        location: "query",
        name: "api_key",
        value_format: "\uD800",
      },
    }) as Row;
    assert.ok(out);
    assert.equal(out.curl, "curl -sS 'https://api.example.com/v1'");
    assert.doesNotMatch(out.python, /api_key/);
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
    }) as Row;
    assert.match(out.curl, /X-Custom-Key/);
    assert.doesNotMatch(out.curl, /Authorization/);
  });

  test("scheme:none yields a plain GET even when auth_required is set", () => {
    const out = generateServiceSnippets({
      ...base,
      auth: { scheme: "none" },
    }) as Row;
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
    }) as Row;
    // unsafe placeholder is dropped → falls back to a plain GET, never injected
    assert.doesNotMatch(out.curl, /rm -rf/);
  });

  test("fills scheme-appropriate placeholders when value_format is omitted", () => {
    const bearer = generateServiceSnippets({
      ...base,
      auth: { scheme: "bearer" },
    }) as Row;
    assert.match(bearer.curl, /-H 'Authorization: Bearer YOUR_API_KEY'/);
    const basic = generateServiceSnippets({
      ...base,
      auth: { scheme: "basic" },
    }) as Row;
    assert.match(basic.curl, /Authorization: Basic <base64/);
    // query api-key with no name defaults the param to api_key
    const key = generateServiceSnippets({
      ...base,
      auth: { scheme: "api-key", location: "query" },
    }) as Row;
    assert.match(key.curl, /\?api_key=YOUR_API_KEY/);
  });

  test("structured cookie auth is sent via the Cookie header, not a same-named header", () => {
    const out = generateServiceSnippets({
      ...base,
      auth: {
        scheme: "api-key",
        location: "cookie",
        name: "session_id",
        value_format: "<token>",
      },
    }) as Row;
    // Correct: the credential travels in the Cookie request header as name=value.
    assert.match(out.curl, /-H 'Cookie: session_id=<token>'/);
    assert.match(out.python, /"Cookie": "session_id=<token>"/);
    assert.match(out.typescript, /"Cookie": "session_id=<token>"/);
    // Regression: must NOT emit an arbitrary header literally named after the cookie,
    // and must NOT smuggle the credential onto the URL as a query param.
    assert.doesNotMatch(out.curl, /-H 'session_id:/);
    assert.ok(!out.curl.includes("?session_id="));
  });
});
