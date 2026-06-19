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
