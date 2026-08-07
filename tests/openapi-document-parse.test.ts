import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { parseOpenApiDocument } from "../scripts/snapshot-adapters.ts";

// #9893: the capture only ever called JSON.parse, so a subnet publishing a
// spec-legal YAML OpenAPI document was recorded as content-mismatch and
// /api/v1/schemas published `status: "not-found"` about it. SN10's
// https://taofi-doc.web.app/openapi.yaml serves 44 KB of valid OpenAPI 3.0.4
// as text/yaml; the registry told the world it had no machine-readable API.

// A real third-party document, captured verbatim from SN10 on 2026-08-07. Its
// `3.0.4` is TAOFI'S spec version, not ours -- metagraphed publishes 3.1.0 with
// draft-2020-12 components. The capture must take whatever a subnet publishes:
// refusing a 3.0.x document because we prefer 3.1 would recreate exactly the
// bug this fixes, one version-check later.
const YAML_DOC = `openapi: 3.0.4
info:
  title: TaoFi - OpenAPI 3.0
  version: 1.0.0
paths:
  /quote:
    get:
      summary: Get a quote
`;

describe("parseOpenApiDocument", () => {
  test("JSON still parses, regardless of how it is labelled", () => {
    const doc = parseOpenApiDocument(
      '{"openapi":"3.1.0","info":{"title":"X"}}',
      "application/json",
      "https://example.dev/openapi.json",
    );
    assert.equal(doc?.openapi, "3.1.0");
    // JSON is tried first and unconditionally -- the YAML gate must never be
    // able to reject a JSON body, whatever its content-type says.
    const odd = parseOpenApiDocument(
      '{"openapi":"3.1.0"}',
      "text/plain",
      "https://example.dev/spec",
    );
    assert.equal(odd?.openapi, "3.1.0");
  });

  test("YAML parses when the content-type says so", () => {
    const doc = parseOpenApiDocument(
      YAML_DOC,
      "text/yaml; charset=utf-8",
      "https://taofi-doc.web.app/openapi.yaml",
    );
    assert.equal(doc?.openapi, "3.0.4");
    assert.equal(
      (doc?.info as Record<string, unknown>)?.title,
      "TaoFi - OpenAPI 3.0",
    );
  });

  test("YAML parses on a .yaml URL even when served as text/plain", () => {
    // A server that mislabels the type should not cost the subnet its schema.
    const doc = parseOpenApiDocument(
      YAML_DOC,
      "text/plain",
      "https://example.dev/openapi.yaml",
    );
    assert.equal(doc?.openapi, "3.0.4");
    assert.equal(
      parseOpenApiDocument(
        YAML_DOC,
        "text/plain",
        "https://example.dev/spec.yml",
      )?.openapi,
      "3.0.4",
    );
  });

  test("YAML is NOT attempted for a body with no YAML signal", () => {
    // The gate matters: YAML's parser accepts a great deal of plain text, so
    // always-trying would turn error pages into captured schemas.
    assert.equal(
      parseOpenApiDocument(YAML_DOC, "text/html", "https://example.dev/spec"),
      null,
    );
  });

  test("an HTML error page served as YAML is not a captured schema", () => {
    // The specific hazard the object check exists for: this parses cleanly as a
    // YAML scalar, and returning that string would sail through as `captured`.
    assert.equal(
      parseOpenApiDocument(
        "<html><body>404 Not Found</body></html>",
        "text/yaml",
        "https://example.dev/openapi.yaml",
      ),
      null,
    );
  });

  test("a YAML scalar or list is not an OpenAPI document", () => {
    assert.equal(
      parseOpenApiDocument("just a string", "text/yaml", "x.yaml"),
      null,
    );
    assert.equal(
      parseOpenApiDocument("- a\n- b\n", "text/yaml", "x.yaml"),
      null,
    );
  });

  test("an alias bomb is bounded rather than expanded", () => {
    // Untrusted third-party input: unbounded anchor/alias expansion is the
    // billion-laughs shape. maxAliasCount makes this throw, which the parser
    // reports as "did not parse" rather than hanging the capture.
    const bomb = [
      "a: &a [x,x,x,x,x,x,x,x,x]",
      "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]",
      "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]",
      "d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]",
      "e: [*d,*d,*d,*d,*d,*d,*d,*d,*d]",
    ].join("\n");
    assert.equal(parseOpenApiDocument(bomb, "text/yaml", "x.yaml"), null);
  });

  test("empty and malformed bodies are null, not a capture", () => {
    assert.equal(parseOpenApiDocument("", "text/yaml", "x.yaml"), null);
    assert.equal(parseOpenApiDocument(null, "text/yaml", "x.yaml"), null);
    assert.equal(
      parseOpenApiDocument("{ unclosed", "text/yaml", "x.yaml"),
      null,
    );
  });
});
