import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { resolveFixtureRedirectTarget } from "../scripts/lib.mjs";

describe("fixture redirect target guard", () => {
  test("blocks redirects into private addresses", () => {
    const result = resolveFixtureRedirectTarget(
      "https://api.example.com/v1/data",
      "http://127.0.0.1/private",
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, "redirect target is unsafe");
  });

  test("allows safe public redirect targets", () => {
    const result = resolveFixtureRedirectTarget(
      "https://api.example.com/v1/data",
      "https://cdn.example.com/v1/data",
    );
    assert.equal(result.ok, true);
    assert.equal(result.target, "https://cdn.example.com/v1/data");
  });
});
