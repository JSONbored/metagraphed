import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { isGeneratedPublicArtifactRelativePath } from "../src/artifact-storage.mjs";

describe("isGeneratedPublicArtifactRelativePath", () => {
  test("matches the committed (dual-tier) public artifacts", () => {
    for (const relativePath of [
      "api-index.json",
      "r2-manifest.json",
      "contracts.json",
      "openapi.json",
      "schemas/index.json",
      "types.d.ts",
      "operational-surfaces.json",
    ]) {
      assert.equal(
        isGeneratedPublicArtifactRelativePath(relativePath),
        true,
        relativePath,
      );
    }
  });

  test("normalizes a leading slash and a /metagraph/ prefix first", () => {
    assert.equal(isGeneratedPublicArtifactRelativePath("/openapi.json"), true);
    assert.equal(
      isGeneratedPublicArtifactRelativePath("/metagraph/openapi.json"),
      true,
    );
    assert.equal(
      isGeneratedPublicArtifactRelativePath("/metagraph/contracts.json"),
      true,
    );
  });

  test("does not match partial, suffixed, or differently-scoped paths", () => {
    for (const relativePath of [
      "xopenapi.json", // not anchored at the start
      "openapi.jsonx", // not anchored at the end
      "openapi.json/", // trailing segment
      "schemas/other.json", // only schemas/index.json is dual
      "testnet/openapi.json", // secondary-network prefix is not stripped
      "subnets.json", // an R2/live artifact, not a committed one
      "",
    ]) {
      assert.equal(
        isGeneratedPublicArtifactRelativePath(relativePath),
        false,
        relativePath,
      );
    }
  });

  test("defaults a missing argument to a non-match", () => {
    assert.equal(isGeneratedPublicArtifactRelativePath(), false);
  });
});
