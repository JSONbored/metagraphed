import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./app-shell-sources-line.tsx", import.meta.url)),
  "utf8",
);

describe("footer freshness line", () => {
  it("keeps unread or failed freshness counts unknown instead of rendering false zeroes", () => {
    expect(source).toContain("const loading = !hydrated || freshness.isPending;");
    expect(source).toContain("const unavailable = freshness.isError;");
    expect(source).toContain('loading || unavailable ? "—"');
    expect(source).not.toContain("stale_count ?? 0");
    expect(source).not.toContain("sources?.length ?? 0");
  });

  it("announces the deferred reading state without making the footer a new fetch on load", () => {
    expect(source).toContain("aria-busy={loading || undefined}");
    expect(source).toContain("Freshness data is loading.");
    expect(source).toContain("Freshness data is unavailable.");
  });
});
