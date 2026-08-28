import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./directory.tsx", import.meta.url)), "utf8");

describe("the full subnet directory keeps logo loading bounded", () => {
  it("uses curated icons without probing two remote fallbacks per row", () => {
    expect(source).toContain("iconUrl={row.icon_url}");
    expect(source).not.toContain("url={row.website}");
    expect(source).not.toContain("repoUrl={row.repo}");
    expect(source).toContain("fallback={row.netuid}");
  });
});
