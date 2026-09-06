import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { repoRoot } from "../scripts/lib.ts";
import { R2_STAGING_RELATIVE_ROOT } from "../src/artifact-storage.ts";
import { CARD_VERSION, OG_IMAGE_FILE_NAMES } from "../src/og-card-version.ts";

test("the real manifest publishes only current/compatibility preview PNGs with exact content hashes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "api-og-manifest-"));
  try {
    const staging = path.join(root, R2_STAGING_RELATIVE_ROOT);
    mkdirSync(path.join(root, "public/metagraph"), { recursive: true });
    mkdirSync(path.join(staging, "nested"), { recursive: true });
    const png = readFileSync(
      new URL("../public/brand/og-fallback.png", import.meta.url),
    );
    const excluded = [
      "other.png",
      `og-image-v${Number(CARD_VERSION) + 1}.png`,
      `og-image-v${CARD_VERSION}.png.pending`,
      `nested/og-image-v${CARD_VERSION}.png`,
      "nested/og-image.png",
    ];
    for (const name of [...OG_IMAGE_FILE_NAMES, ...excluded])
      writeFileSync(path.join(staging, name), png);
    execFileSync(process.execPath, ["scripts/r2-manifest.ts", "--write"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        METAGRAPH_REPO_ROOT: root,
        METAGRAPH_BUILD_TIMESTAMP: "2026-01-01T00:00:00.000Z",
      },
      stdio: "pipe",
    });
    const manifest = JSON.parse(
      readFileSync(path.join(staging, "r2-manifest.json"), "utf8"),
    );
    const artifacts = manifest.artifacts as {
      path: string;
      key: string;
      content_type: string;
      sha256: string;
      storage_tier: string;
    }[];
    assert.deepEqual(
      artifacts.map((entry) => entry.path).sort(),
      OG_IMAGE_FILE_NAMES.map((name) => `/metagraph/${name}`).sort(),
    );
    const sha256 = createHash("sha256").update(png).digest("hex");
    for (const entry of artifacts) {
      assert.equal(entry.content_type, "image/png");
      assert.equal(entry.storage_tier, "r2");
      assert.equal(entry.sha256, sha256);
      assert.equal(entry.key, `by-hash/${sha256}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
