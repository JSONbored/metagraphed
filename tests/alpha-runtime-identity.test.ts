import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { alphaRuntimeOriginalMatches } from "../src/alpha-runtime-identity.ts";

test("ingestion and historical reads share exact runtime/code/metadata qualification", () => {
  for (const spec of [454, 478]) {
    const { alpha_snapshot: original } = JSON.parse(
      readFileSync(
        new URL(
          `./fixtures/alpha-runtime/frozen-${spec}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const matches = (
      version: unknown,
      code: unknown,
      digest: unknown,
      scale?: unknown,
    ) => alphaRuntimeOriginalMatches(version, code, digest, scale);
    assert.equal(
      matches(spec, original.code_hash, original.metadata_sha256),
      true,
    );
    assert.equal(
      matches(
        spec,
        original.code_hash,
        original.metadata_sha256,
        original.metadata_scale_hex,
      ),
      true,
    );
    for (const version of [0, 477, "478", null]) {
      assert.equal(
        matches(
          version,
          original.code_hash,
          original.metadata_sha256,
          original.metadata_scale_hex,
        ),
        false,
      );
    }
    assert.equal(
      matches(spec, `0x${"00".repeat(32)}`, original.metadata_sha256),
      false,
    );
    assert.equal(matches(spec, original.code_hash, "0".repeat(64)), false);
    for (const scale of [
      null,
      [],
      "0x6d6574610e0",
      "0x6d6574610f00",
      "0x6d6574610e00",
      "0".repeat(2_097_155),
    ]) {
      assert.equal(
        matches(spec, original.code_hash, original.metadata_sha256, scale),
        false,
      );
    }
  }
});
