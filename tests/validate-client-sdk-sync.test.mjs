// Unit tests for the client-SDK drift gate's diff decision logic. The pure
// `evaluateClientSdkSync` function is exercised directly with synthetic
// changed-file lists, so no git/network is touched.

import { describe, expect, it } from "vitest";
import {
  CONTRACT_PATHS,
  CLIENT_MANIFEST_PATH,
  evaluateClientSdkSync,
  resolveDiffBase,
} from "../scripts/validate-client-sdk-sync.ts";

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
        "scripts/lib.ts",
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
      changedFiles: ["", "  ", "packages\\contract\\index.d.ts"],
      versionChanged: false,
    });
    expect(result.contractChanged).toBe(true);
    expect(result.contractFiles).toContain("packages/contract/index.d.ts");
  });

  it("treats a contract change with a version bump as in-sync regardless of order", () => {
    const result = evaluateClientSdkSync({
      changedFiles: ["public/metagraph/openapi.json"],
      versionChanged: true,
    });
    expect(result.ok).toBe(true);
  });
});

describe("client-SDK drift gate (git range resolution)", () => {
  it("resolves an explicit PR base tip to the merge base before diffing", () => {
    const calls = [];
    const result = resolveDiffBase({
      explicitBase: "base-tip",
      baseRef: "main",
      headRef: "pr-head",
      gitFn(args) {
        calls.push(args);
        return "common-ancestor";
      },
    });

    expect(result).toBe("common-ancestor");
    expect(calls).toEqual([["merge-base", "base-tip", "pr-head"]]);
  });

  it("falls back from origin/base-ref to the local base ref", () => {
    const calls = [];
    const result = resolveDiffBase({
      explicitBase: undefined,
      baseRef: "feature-base",
      headRef: "HEAD",
      gitFn(args) {
        calls.push(args);
        if (args[1] === "origin/feature-base")
          throw new Error("missing remote");
        return "local-common-ancestor";
      },
    });

    expect(result).toBe("local-common-ancestor");
    expect(calls).toEqual([
      ["merge-base", "origin/feature-base", "HEAD"],
      ["merge-base", "feature-base", "HEAD"],
    ]);
  });

  it("uses the head ref as a no-op local fallback when no base ref exists", () => {
    const result = resolveDiffBase({
      explicitBase: undefined,
      baseRef: "main",
      headRef: "HEAD",
      gitFn() {
        throw new Error("missing base");
      },
    });

    expect(result).toBe("HEAD");
  });
});
