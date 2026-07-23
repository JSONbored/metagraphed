import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { inspectAdapter } from "../scripts/validate-adapters.ts";

describe("validate-adapters inspectAdapter", () => {
  test("reports no issues for a fully captured adapter", () => {
    const adapter = {
      dimensions: {
        master_repositories: { status: "captured", status_code: 200 },
        repository_metadata: {
          status: "captured",
          captured_count: 18,
          html_fallback_count: 0,
        },
      },
    };
    assert.deepEqual(inspectAdapter(adapter), []);
  });

  test("flags a dimension that fell back to HTML scraping", () => {
    const issues = inspectAdapter({
      dimensions: { mirror_freshness: { status: "html-fallback" } },
    });
    assert.equal(issues.length, 1);
    assert.match(issues[0], /mirror_freshness: status=html-fallback/);
  });

  test("flags broken GitHub auth (401 / Bad credentials)", () => {
    const issues = inspectAdapter({
      dimensions: {
        mirror_freshness: { status_code: 401, error: "Bad credentials" },
      },
    });
    assert.equal(issues.length, 1);
    assert.match(issues[0], /auth failure/);
  });

  test("flags repository metadata degraded to all-HTML-fallback", () => {
    const issues = inspectAdapter({
      dimensions: {
        repository_metadata: {
          status: "captured",
          captured_count: 0,
          html_fallback_count: 18,
        },
      },
    });
    assert.equal(issues.length, 1);
    assert.match(issues[0], /all HTML-fallback/);
  });

  test("tolerates missing / malformed dimensions", () => {
    assert.deepEqual(inspectAdapter({}), []);
    assert.deepEqual(inspectAdapter({ dimensions: null }), []);
    assert.deepEqual(inspectAdapter(null), []);
    assert.deepEqual(inspectAdapter({ dimensions: { x: "nope" } }), []);
  });

  test("captured_count > 0 with some fallbacks is not flagged as all-fallback", () => {
    const issues = inspectAdapter({
      dimensions: {
        repository_metadata: {
          status: "captured",
          captured_count: 15,
          html_fallback_count: 3,
        },
      },
    });
    assert.deepEqual(issues, []);
  });
});
