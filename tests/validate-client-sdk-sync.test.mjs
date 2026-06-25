// Unit tests for the client-SDK drift gate's diff decision logic. The pure
// `evaluateClientSdkSync` function is exercised directly with synthetic
// changed-file lists, so no git/network is touched.

import { describe, expect, it } from "vitest";
import {
  CONTRACT_PATHS,
  CLIENT_MANIFEST_PATH,
  evaluateClientSdkSync,
} from "../scripts/validate-client-sdk-sync.mjs";

describe("client-SDK drift gate (diff logic)", () => {
  it("fails when a contract file changed but the client version did not", () => {
    const result = evaluateClientSdkSync({
      changedFiles: [
        "public/metagraph/openapi.json",
        "schemas/components.yaml",
      ],
      versionChanged: false,
    });
    expect(result.contractChanged).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.contractFiles).toContain("public/metagraph/openapi.json");
  });

  it("passes when a contract file changed and the client version was bumped", () => {
    const result = evaluateClientSdkSync({
      changedFiles: ["generated/metagraphed-client.ts", CLIENT_MANIFEST_PATH],
      versionChanged: true,
    });
    expect(result.contractChanged).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("does not fire on a non-contract PR (no contract file changed)", () => {
    const result = evaluateClientSdkSync({
      changedFiles: [
        "registry/subnets/example.json",
        "README.md",
        "scripts/lib.mjs",
      ],
      versionChanged: false,
    });
    expect(result.contractChanged).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.contractFiles).toEqual([]);
  });

  it("detects every declared contract path", () => {
    for (const contract of CONTRACT_PATHS) {
      const result = evaluateClientSdkSync({
        changedFiles: [contract],
        versionChanged: false,
      });
      expect(result.contractChanged, `${contract} should be gated`).toBe(true);
      expect(result.ok).toBe(false);
    }
  });

  it("normalizes Windows-style separators and ignores blanks", () => {
    const result = evaluateClientSdkSync({
      changedFiles: ["", "  ", "generated\\metagraphed-api.d.ts"],
      versionChanged: false,
    });
    expect(result.contractChanged).toBe(true);
    expect(result.contractFiles).toContain("generated/metagraphed-api.d.ts");
  });

  it("treats a contract change with a version bump as in-sync regardless of order", () => {
    const result = evaluateClientSdkSync({
      changedFiles: ["public/metagraph/openapi.json"],
      versionChanged: true,
    });
    expect(result.ok).toBe(true);
  });
});
