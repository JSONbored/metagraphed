import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ApiError } from "@/lib/metagraphed/client";
import { BlockDetailCatchupStatus, ErrorState } from "./states";

describe("ErrorState", () => {
  it("keeps a block-detail coverage gap distinct from an empty or generic error", () => {
    const html = renderToStaticMarkup(
      <ErrorState
        context="block extrinsics"
        error={
          new ApiError("coverage gap", {
            status: 503,
            code: "block_detail_unavailable",
            url: "https://api.example.test/api/v1/blocks/42/extrinsics",
          })
        }
        onRetry={vi.fn()}
      />,
    );

    expect(html).toContain("Decoded block detail is catching up");
    expect(html).toContain("This block is indexed");
    expect(html).toContain("not an empty block");
    expect(html).toContain("Retry");
    expect(html).not.toContain("Couldn't load block extrinsics");
  });

  it("announces a bounded automatic newest-block recovery without calling it an error", () => {
    const html = renderToStaticMarkup(
      <BlockDetailCatchupStatus detail="extrinsics" attempt={2} total={6} />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Decoding this new block");
    expect(html).toContain("decoded extrinsics are catching up");
    expect(html).toContain("Attempt 2 of 6");
    expect(html).not.toContain('role="alert"');
  });
});
