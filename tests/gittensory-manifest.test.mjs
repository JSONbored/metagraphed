import { readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const MANIFEST_PATH = path.join(process.cwd(), ".gittensory.yml");

function loadManifest() {
  return yaml.load(readFileSync(MANIFEST_PATH, "utf8"));
}

describe(".gittensory.yml manifest", () => {
  it("blocks docs-site from community-data auto-adjudication scope", () => {
    const manifest = loadManifest();
    expect(manifest.blockedPaths).toEqual(
      expect.arrayContaining(["docs-site/**"]),
    );
  });

  it("documents docs-site slop context in the public review note", () => {
    const manifest = loadManifest();
    expect(manifest.review?.note).toMatch(/manifest\.json/);
    expect(manifest.review?.note).toMatch(/validate:docs-site/);
  });
});
