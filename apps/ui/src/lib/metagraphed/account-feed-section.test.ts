import { describe, expect, it } from "vitest";

import { accountFeedSectionPhase } from "./account-feed-section";

describe("accountFeedSectionPhase", () => {
  it("shows a skeleton while the first page is loading", () => {
    expect(accountFeedSectionPhase({ isPending: true, isError: false, rowCount: 0 })).toBe(
      "skeleton",
    );
  });

  it("prefers the error panel over stale cached rows", () => {
    expect(accountFeedSectionPhase({ isPending: false, isError: true, rowCount: 3 })).toBe("error");
  });

  it("renders the error panel when the feed fails with no cache", () => {
    expect(accountFeedSectionPhase({ isPending: false, isError: true, rowCount: 0 })).toBe("error");
  });

  it("hides the section when the feed succeeded with zero rows", () => {
    expect(accountFeedSectionPhase({ isPending: false, isError: false, rowCount: 0 })).toBe(
      "empty",
    );
  });

  it("renders table content when rows are available", () => {
    expect(accountFeedSectionPhase({ isPending: false, isError: false, rowCount: 2 })).toBe(
      "content",
    );
  });

  it("keeps showing content while a background refetch is pending", () => {
    expect(accountFeedSectionPhase({ isPending: true, isError: false, rowCount: 2 })).toBe(
      "content",
    );
  });
});
