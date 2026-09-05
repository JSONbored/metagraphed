import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ApiError } from "@/lib/metagraphed/client";
import { BlockDetailCatchupStatus, ErrorState } from "./states";

describe("ErrorState", () => {
  it("keeps recovery visible and technical diagnostics inside a closed disclosure", () => {
    const html = renderToStaticMarkup(
      <ErrorState
        context="API keys"
        error={
          new ApiError("provider-specific failure", {
            status: 503,
            url: "https://api.example.test/api/v1/keys",
          })
        }
        onRetry={vi.fn()}
      />,
    );
    const [recovery, diagnostics] = html.split("<details");
    expect(recovery).toContain("Couldn&#x27;t load API keys");
    expect(recovery).toContain('type="button"');
    expect(recovery).toContain("Retry");
    expect(recovery).not.toContain("HTTP 503");
    expect(recovery).not.toContain("provider-specific failure");
    expect(diagnostics).not.toMatch(/^[^>]*\bopen=/);
    expect(diagnostics).toContain("Technical details");
    expect(diagnostics).toContain("HTTP 503");
    expect(diagnostics).toContain("provider-specific failure");
    expect(diagnostics).toContain("https://api.example.test/api/v1/keys");
    expect(diagnostics).toContain("Open API URL");
  });

  it("never turns an unsafe diagnostic URL into an action", () => {
    const html = renderToStaticMarkup(
      <ErrorState
        error={new ApiError("bad request", { status: 500, url: "javascript:alert(1)" })}
      />,
    );
    expect(html).toContain("Request URL");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("Open API URL");
    expect(html).not.toContain("Retry");
  });

  it("preserves plain errors without inventing HTTP or request metadata", () => {
    for (const [error, message] of [
      [new Error("render failed"), "render failed"],
      ["plain failure", "plain failure"],
      [null, "Unknown error"],
      [{ message: {} }, "Unknown error"],
    ]) {
      const html = renderToStaticMarkup(<ErrorState error={error} />);
      expect(html).toContain(message);
      expect(html).not.toContain("HTTP ");
      expect(html).not.toContain("Request URL");
    }
  });

  it("preserves offline and throttled states as status notices without generic diagnostics", () => {
    for (const [status, message] of [
      [0, "offline"],
      [429, "Rate-limited"],
    ] as const) {
      const html = renderToStaticMarkup(
        <ErrorState
          error={
            new ApiError("provider detail", { status, url: "https://api.example.test/api/v1/data" })
          }
          onRetry={vi.fn()}
        />,
      );
      expect(html).toContain('role="status"');
      expect(html).toContain(message);
      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain("Technical details");
      expect(html).not.toContain("Retry");
    }
  });

  it("preserves a deliberate network-partition gap as a status notice", () => {
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ErrorState
          error={
            new ApiError("not on this network", {
              status: 404,
              code: "not_found",
              network: "testnet",
              url: "https://api.example.test/api/v1/testnet/data",
            })
          }
        />
      </QueryClientProvider>,
    );
    expect(html).toContain("Not published for");
    expect(html).toContain('role="status"');
    expect(html).not.toContain("Technical details");
    expect(html).not.toContain('role="alert"');
  });

  it("does not present an unavailable data tier as a measured empty result", () => {
    const html = renderToStaticMarkup(
      <ErrorState
        context="complete-day chain activity"
        error={
          new ApiError("unverified fallback", {
            status: 200,
            code: "data_tier_unavailable",
            url: "https://api.example.test/api/v1/chain/activity",
          })
        }
        onRetry={vi.fn()}
      />,
    );

    expect(html).toContain("Data source temporarily unavailable");
    expect(html).toContain("cannot verify its current source");
    expect(html).toContain("no zero or empty result is shown");
    expect(html).toContain("Retry");
    expect(html).not.toContain("Deep-history tier not enabled");
    expect(html).not.toContain("Couldn't load complete-day chain activity");
  });

  it("uses neutral copy when the unavailable response has no route context", () => {
    const html = renderToStaticMarkup(
      <ErrorState
        error={
          new ApiError("unverified fallback", {
            status: 200,
            code: "data_tier_unavailable",
            url: "https://api.example.test/api/v1/data",
          })
        }
      />,
    );

    expect(html).toContain("This view cannot verify its current source");
  });

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
