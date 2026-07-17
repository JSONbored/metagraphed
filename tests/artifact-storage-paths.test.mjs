import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  ARTIFACT_STORAGE_TIERS,
  artifactRelativePath,
  artifactStorageTierForPath,
  artifactStorageTierForRelativePath,
  isGeneratedPublicArtifactRelativePath,
  isR2OnlyArtifactPath,
  isR2PreferredDualArtifactPath,
  isR2StableKeyArtifactPath,
  schemaDetailArtifactRelativePath,
  stableR2Key,
} from "../src/artifact-storage.mjs";

const SS58 = "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM";

describe("artifactRelativePath", () => {
  test("strips a leading slash and /metagraph/ prefix for absolute paths", () => {
    assert.equal(
      artifactRelativePath("/metagraph/openapi.json"),
      "openapi.json",
    );
    assert.equal(artifactRelativePath("/openapi.json"), "openapi.json");
    assert.equal(
      artifactRelativePath("/metagraph/subnets/7/metagraph.json"),
      "subnets/7/metagraph.json",
    );
  });

  test("leaves relative paths unchanged, including unprefixed metagraph/ segments", () => {
    assert.equal(artifactRelativePath("contracts.json"), "contracts.json");
    assert.equal(
      artifactRelativePath("metagraph/latest.json"),
      "metagraph/latest.json",
    );
    assert.equal(
      artifactRelativePath("testnet/openapi.json"),
      "testnet/openapi.json",
    );
  });

  test("defaults a missing argument to an empty string", () => {
    assert.equal(artifactRelativePath(), "");
    assert.equal(artifactRelativePath(""), "");
  });
});

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
      "xopenapi.json",
      "openapi.jsonx",
      "openapi.json/",
      "schemas/other.json",
      "testnet/openapi.json",
      "subnets.json",
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

describe("artifactStorageTierForRelativePath", () => {
  test("classifies live-computed artifacts as R2-only", () => {
    assert.equal(
      artifactStorageTierForRelativePath(`accounts/${SS58}.json`),
      ARTIFACT_STORAGE_TIERS.r2,
    );
    assert.equal(
      artifactStorageTierForRelativePath("subnets/7/metagraph.json"),
      ARTIFACT_STORAGE_TIERS.r2,
    );
    assert.equal(
      artifactStorageTierForRelativePath("subnets.json"),
      ARTIFACT_STORAGE_TIERS.r2,
    );
  });

  test("classifies committed contract artifacts as dual", () => {
    assert.equal(
      artifactStorageTierForRelativePath("contracts.json"),
      ARTIFACT_STORAGE_TIERS.dual,
    );
    assert.equal(
      artifactStorageTierForRelativePath("openapi.json"),
      ARTIFACT_STORAGE_TIERS.dual,
    );
    assert.equal(
      artifactStorageTierForRelativePath("operational-surfaces.json"),
      ARTIFACT_STORAGE_TIERS.dual,
    );
  });

  test("falls back to git for paths outside both pattern lists", () => {
    assert.equal(
      artifactStorageTierForRelativePath("robots.txt"),
      ARTIFACT_STORAGE_TIERS.git,
    );
    assert.equal(
      artifactStorageTierForRelativePath("not-a-real-artifact.json"),
      ARTIFACT_STORAGE_TIERS.git,
    );
  });

  test("forces R2 for secondary-network prefixes regardless of mainnet tier", () => {
    assert.equal(
      artifactStorageTierForRelativePath("testnet/openapi.json"),
      ARTIFACT_STORAGE_TIERS.r2,
    );
    assert.equal(
      artifactStorageTierForRelativePath("local/contracts.json"),
      ARTIFACT_STORAGE_TIERS.r2,
    );
    assert.equal(
      artifactStorageTierForRelativePath("testnet/subnets/7/metagraph.json"),
      ARTIFACT_STORAGE_TIERS.r2,
    );
  });

  test("defaults a missing argument to git", () => {
    assert.equal(
      artifactStorageTierForRelativePath(),
      ARTIFACT_STORAGE_TIERS.git,
    );
    assert.equal(
      artifactStorageTierForRelativePath(""),
      ARTIFACT_STORAGE_TIERS.git,
    );
  });
});

describe("artifactStorageTierForPath", () => {
  test("normalizes absolute /metagraph/ paths before tiering", () => {
    assert.equal(
      artifactStorageTierForPath("/metagraph/contracts.json"),
      ARTIFACT_STORAGE_TIERS.dual,
    );
    assert.equal(
      artifactStorageTierForPath("/metagraph/subnets/7/metagraph.json"),
      ARTIFACT_STORAGE_TIERS.r2,
    );
    assert.equal(
      artifactStorageTierForPath("/metagraph/robots.txt"),
      ARTIFACT_STORAGE_TIERS.git,
    );
  });

  test("classifies secondary-network absolute paths as R2-only", () => {
    assert.equal(
      artifactStorageTierForPath("/metagraph/testnet/openapi.json"),
      ARTIFACT_STORAGE_TIERS.r2,
    );
  });

  test("defaults a missing argument to git", () => {
    assert.equal(artifactStorageTierForPath(), ARTIFACT_STORAGE_TIERS.git);
  });
});

describe("isR2OnlyArtifactPath", () => {
  test("returns true for live-computed artifact paths", () => {
    assert.equal(
      isR2OnlyArtifactPath(`/metagraph/accounts/${SS58}.json`),
      true,
    );
    assert.equal(
      isR2OnlyArtifactPath("/metagraph/subnets/7/metagraph.json"),
      true,
    );
    assert.equal(isR2OnlyArtifactPath("subnets.json"), true);
  });

  test("returns false for committed dual-tier artifacts", () => {
    assert.equal(isR2OnlyArtifactPath("/metagraph/contracts.json"), false);
    assert.equal(isR2OnlyArtifactPath("openapi.json"), false);
    assert.equal(
      isR2OnlyArtifactPath("/metagraph/operational-surfaces.json"),
      false,
    );
  });

  test("returns false for git-tier paths and the default empty argument", () => {
    assert.equal(isR2OnlyArtifactPath("/metagraph/robots.txt"), false);
    assert.equal(isR2OnlyArtifactPath(), false);
    assert.equal(isR2OnlyArtifactPath(""), false);
  });
});

describe("isR2PreferredDualArtifactPath", () => {
  test("returns false for dual artifacts because the preferred-dual set is empty", () => {
    assert.equal(
      isR2PreferredDualArtifactPath("/metagraph/contracts.json"),
      false,
    );
    assert.equal(
      isR2PreferredDualArtifactPath("/metagraph/openapi.json"),
      false,
    );
  });

  test("returns false for non-dual artifacts", () => {
    assert.equal(
      isR2PreferredDualArtifactPath("/metagraph/subnets/7/metagraph.json"),
      false,
    );
    assert.equal(isR2PreferredDualArtifactPath("/metagraph/robots.txt"), false);
  });

  test("defaults a missing argument to false", () => {
    assert.equal(isR2PreferredDualArtifactPath(), false);
    assert.equal(isR2PreferredDualArtifactPath(""), false);
  });
});

describe("isR2StableKeyArtifactPath", () => {
  test("returns true for a dated health-history artifact", () => {
    assert.equal(
      isR2StableKeyArtifactPath("/metagraph/health/history/2026-06-01.json"),
      true,
    );
  });

  test("returns false for the health-history route's unresolved {date} template", () => {
    assert.equal(
      isR2StableKeyArtifactPath("/metagraph/health/history/{date}.json"),
      false,
    );
  });

  test("returns false for other R2-only artifacts", () => {
    assert.equal(isR2StableKeyArtifactPath("/metagraph/subnets.json"), false);
    assert.equal(
      isR2StableKeyArtifactPath("/metagraph/health/latest.json"),
      false,
    );
  });

  test("defaults a missing argument to false", () => {
    assert.equal(isR2StableKeyArtifactPath(), false);
    assert.equal(isR2StableKeyArtifactPath(""), false);
  });
});

describe("stableR2Key", () => {
  test("prefixes the relative artifact path with latest/", () => {
    assert.equal(
      stableR2Key("/metagraph/health/history/2026-06-01.json"),
      "latest/health/history/2026-06-01.json",
    );
  });

  test("handles a bare relative path the same as a /metagraph/-prefixed one", () => {
    assert.equal(
      stableR2Key("health/history/2026-06-01.json"),
      "latest/health/history/2026-06-01.json",
    );
  });
});

describe("schemaDetailArtifactRelativePath", () => {
  test("returns the relative path for a valid schema detail artifact", () => {
    assert.equal(
      schemaDetailArtifactRelativePath(
        "/metagraph/schemas/sn-6-numinous-openapi-schema.json",
      ),
      "schemas/sn-6-numinous-openapi-schema.json",
    );
    assert.equal(
      schemaDetailArtifactRelativePath("schemas/allways-swagger.json"),
      "schemas/allways-swagger.json",
    );
  });

  test("rejects the index, non-schema paths, traversal, and malformed segments", () => {
    assert.equal(
      schemaDetailArtifactRelativePath("/metagraph/schemas/index.json"),
      null,
    );
    assert.equal(
      schemaDetailArtifactRelativePath("/metagraph/schema-drift.json"),
      null,
    );
    assert.equal(
      schemaDetailArtifactRelativePath("/metagraph/../../package.json"),
      null,
    );
    assert.equal(
      schemaDetailArtifactRelativePath("/metagraph/schemas/../package.json"),
      null,
    );
    assert.equal(
      schemaDetailArtifactRelativePath("schemas/sn-7\\openapi.json"),
      null,
    );
  });

  test("defaults a missing or empty argument to null", () => {
    assert.equal(schemaDetailArtifactRelativePath(), null);
    assert.equal(schemaDetailArtifactRelativePath(""), null);
  });
});
