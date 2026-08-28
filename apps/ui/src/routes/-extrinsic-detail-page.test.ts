import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  fileURLToPath(new URL("./-extrinsic-detail-page.tsx", import.meta.url)),
  "utf8",
);

describe("extrinsic event-record completeness", () => {
  it("keeps a continuation affordance for a partial paginated raw event record", () => {
    expect(page).toContain(
      "events.hasNextPage || ((events.error || eventCursorInvalid) && eventRows.length > 0)",
    );
    expect(page).toContain("onLoadMore={() => void events.fetchNextPage()}");
    expect(page).toContain("shown={eventRows.length}");
  });

  it("does not render repeated event rows if a backend cursor repeats a page", () => {
    expect(page).toContain("const seen = new Set<string>()");
    expect(page).toContain("if (seen.has(key)) return false");
    expect(page).toContain("cursorInvalid={eventCursorInvalid}");
  });
});
