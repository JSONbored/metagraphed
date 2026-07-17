import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #6426: the "Related Multisig calls" section had no isError branch. A failed
// fetch leaves data undefined, so relatedCalls becomes [] and the section
// rendered "No other extrinsics reference this call_hash yet." — a failure and a
// genuine empty result were indistinguishable, and the copy asserts something
// the app doesn't actually know.
//
// Source assertions rather than a render: this section lives inside a route that
// needs a router and live data, and this suite is node-environment. The repo
// already tests this way (ui-kit's list-shell.test.ts).
const source = readFileSync(
  fileURLToPath(new URL("./extrinsics.$hash.tsx", import.meta.url)),
  "utf8",
);

const EMPTY_COPY = "No other extrinsics reference this call_hash yet.";

describe("Related Multisig calls distinguishes a fetch error from empty (#6426)", () => {
  it("has an isError branch for the related-calls query", () => {
    expect(source).toContain("relatedQuery.isError");
  });

  it("renders TableState variant=error with a retry, per the accounts.$ss58 pattern", () => {
    const at = source.indexOf("relatedQuery.isError");
    const branch = source.slice(at, source.indexOf(EMPTY_COPY));
    expect(branch).toContain('variant="error"');
    expect(branch).toContain("error={relatedQuery.error}");
    expect(branch).toContain("relatedQuery.refetch()");
  });

  it("checks isError BEFORE the empty copy, so a failure can't fall through to it", () => {
    // Order is the whole fix: if the empty branch were reachable first, a failed
    // fetch would still claim there are no related calls.
    const isError = source.indexOf("relatedQuery.isError");
    const rows = source.indexOf("relatedCalls.length > 0");
    const empty = source.indexOf(EMPTY_COPY);
    expect(isError).toBeGreaterThan(-1);
    expect(isError).toBeLessThan(rows);
    expect(rows).toBeLessThan(empty);
  });

  it("keeps the loading branch ahead of both, so a pending fetch isn't an error", () => {
    expect(source.indexOf("relatedQuery.isLoading")).toBeLessThan(
      source.indexOf("relatedQuery.isError"),
    );
  });

  it("still shows the empty copy — it is not replaced, only made unreachable on failure", () => {
    expect(source).toContain(EMPTY_COPY);
  });
});
