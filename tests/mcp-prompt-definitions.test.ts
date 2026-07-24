import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { listPromptDefinitions } from "../src/mcp-server.ts";

describe("listPromptDefinitions", () => {
  test("returns a non-empty list of well-shaped prompt definitions", () => {
    const prompts = listPromptDefinitions();
    assert.ok(Array.isArray(prompts) && prompts.length > 0);
    for (const prompt of prompts) {
      assert.equal(typeof prompt.name, "string");
      assert.ok(prompt.name.length > 0, "name must be non-empty");
      assert.equal(typeof prompt.title, "string");
      assert.equal(typeof prompt.description, "string");
      assert.ok(Array.isArray(prompt.arguments), `${prompt.name} arguments`);
    }
  });

  test("prompt names are unique", () => {
    const names = listPromptDefinitions().map((prompt) => prompt.name);
    assert.equal(names.length, new Set(names).size);
  });

  test("exposes only the four public fields (no internal handler leakage)", () => {
    for (const prompt of listPromptDefinitions()) {
      assert.deepEqual(Object.keys(prompt).sort(), [
        "arguments",
        "description",
        "name",
        "title",
      ]);
    }
  });

  test("is a deterministic, fresh array on each call", () => {
    const a = listPromptDefinitions();
    const b = listPromptDefinitions();
    assert.notEqual(a, b); // a fresh array (map), not a shared reference
    assert.deepEqual(a, b); // …with identical content
  });
});
