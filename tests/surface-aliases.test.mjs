import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSurfaceAliasArtifact,
  resolveSurfaceAlias,
} from "../src/surface-aliases.mjs";

describe("surface alias artifact (#1005)", () => {
  test("maps renamed display ids to stable surface keys", () => {
    const artifact = buildSurfaceAliasArtifact({
      contractVersion: "2026-06-06.1",
      generatedAt: "1970-01-01T00:00:00.000Z",
      previousSurfaces: [
        {
          id: "7:subnet-api:old",
          key: "srf-stable00000000",
          netuid: 7,
          kind: "subnet-api",
          url: "https://api.example",
        },
      ],
      currentSurfaces: [
        {
          id: "7:subnet-api:new",
          key: "srf-stable00000000",
          netuid: 7,
          kind: "subnet-api",
          url: "https://api.example",
        },
      ],
    });

    assert.equal(artifact.summary.alias_count, 1);
    assert.deepEqual(artifact.aliases[0], {
      deprecated_id: "7:subnet-api:old",
      surface_key: "srf-stable00000000",
      current_id: "7:subnet-api:new",
      netuid: 7,
      kind: "subnet-api",
      url: "https://api.example",
    });
    assert.equal(
      resolveSurfaceAlias(artifact, "7:subnet-api:old")?.surface_key,
      "srf-stable00000000",
    );
  });

  test("carries prior aliases and drops aliases whose key disappeared", () => {
    const artifact = buildSurfaceAliasArtifact({
      previousAliases: {
        aliases: [
          {
            deprecated_id: "7:subnet-api:very-old",
            surface_key: "srf-stable00000000",
            current_id: "7:subnet-api:old",
          },
          {
            deprecated_id: "8:api:removed",
            surface_key: "srf-removed0000000",
            current_id: "8:api:old",
          },
        ],
      },
      previousSurfaces: [
        {
          surface_id: "7:subnet-api:old",
          surface_key: "srf-stable00000000",
        },
      ],
      currentSurfaces: [
        {
          surface_id: "7:subnet-api:new",
          surface_key: "srf-stable00000000",
        },
      ],
    });

    assert.deepEqual(
      artifact.aliases.map((entry) => [
        entry.deprecated_id,
        entry.current_id,
        entry.surface_key,
      ]),
      [
        ["7:subnet-api:old", "7:subnet-api:new", "srf-stable00000000"],
        ["7:subnet-api:very-old", "7:subnet-api:new", "srf-stable00000000"],
      ],
    );
  });

  test("does not alias unchanged or reverted ids", () => {
    const artifact = buildSurfaceAliasArtifact({
      previousAliases: {
        aliases: [
          {
            deprecated_id: "7:subnet-api:current",
            surface_key: "srf-stable00000000",
            current_id: "7:subnet-api:old",
          },
        ],
      },
      previousSurfaces: [
        {
          id: "7:subnet-api:current",
          key: "srf-stable00000000",
        },
      ],
      currentSurfaces: [
        {
          id: "7:subnet-api:current",
          key: "srf-stable00000000",
        },
      ],
    });

    assert.equal(artifact.summary.alias_count, 0);
    assert.equal(resolveSurfaceAlias(artifact, "missing"), null);
  });
});

describe("surface alias artifact — malformed-input invariants", () => {
  test("buildSurfaceAliasArtifact is schema-stable with NO inputs at all", () => {
    // No args object → every collection defaults to empty, summary counts are 0,
    // and aliases is an empty array (never undefined). A build must never throw
    // on a cold/first run.
    const artifact = buildSurfaceAliasArtifact();
    assert.deepEqual(artifact.aliases, []);
    assert.equal(artifact.summary.alias_count, 0);
    assert.equal(artifact.summary.carried_alias_count, 0);
    assert.equal(artifact.summary.new_alias_count, 0);
    assert.equal(artifact.summary.previous_surface_count, 0);
    assert.equal(artifact.summary.current_surface_count, 0);
    assert.equal(artifact.contract_version, null);
    assert.equal(artifact.generated_at, null);
  });

  test("non-array surface/alias collections are coerced to empty (never iterated)", () => {
    const artifact = buildSurfaceAliasArtifact({
      currentSurfaces: "not-an-array",
      previousSurfaces: { nope: true },
      previousAliases: { aliases: "also-not-an-array" },
    });
    assert.deepEqual(artifact.aliases, []);
    // The summary surface counts only count real arrays → 0 for non-arrays.
    assert.equal(artifact.summary.previous_surface_count, 0);
    assert.equal(artifact.summary.current_surface_count, 0);
  });

  test("surfaces/aliases missing an id OR a key are skipped, not aliased", () => {
    const artifact = buildSurfaceAliasArtifact({
      previousAliases: {
        aliases: [
          { deprecated_id: "x", surface_key: null }, // no key → skipped
          { deprecated_id: null, surface_key: "srf-k" }, // no id → skipped
        ],
      },
      previousSurfaces: [
        { id: "7:api:old" }, // no key → skipped
        { key: "srf-keyonly" }, // no id → skipped
      ],
      currentSurfaces: [
        { id: "7:api:new", key: "srf-real0000000000" },
        {}, // no id/key → skipped from the current map
      ],
    });
    assert.deepEqual(artifact.aliases, []);
    assert.equal(artifact.summary.alias_count, 0);
  });

  test("a new alias inherits netuid/kind/url from the PREVIOUS surface when the current lacks them", () => {
    // aliasEntry uses `?? previous` for netuid/kind/url, so a renamed surface
    // whose current row omits those still carries the old descriptive metadata.
    const artifact = buildSurfaceAliasArtifact({
      previousSurfaces: [
        {
          id: "7:api:old",
          key: "srf-carry0000000000",
          netuid: 7,
          kind: "subnet-api",
          url: "https://old.example",
        },
      ],
      currentSurfaces: [
        // Same key (a rename), but the current row carries no netuid/kind/url.
        { id: "7:api:new", key: "srf-carry0000000000" },
      ],
    });
    assert.equal(artifact.aliases.length, 1);
    assert.deepEqual(artifact.aliases[0], {
      deprecated_id: "7:api:old",
      surface_key: "srf-carry0000000000",
      current_id: "7:api:new",
      netuid: 7,
      kind: "subnet-api",
      url: "https://old.example",
    });
    assert.equal(artifact.summary.new_alias_count, 1);
  });

  test("resolveSurfaceAlias rejects a non-string id and a missing aliases array", () => {
    assert.equal(resolveSurfaceAlias({ aliases: [] }, 123), null);
    assert.equal(resolveSurfaceAlias({ aliases: [] }, ""), null);
    // No `aliases` array on the artifact → treated as empty, returns null.
    assert.equal(resolveSurfaceAlias({}, "anything"), null);
    assert.equal(resolveSurfaceAlias(null, "anything"), null);
  });
});
