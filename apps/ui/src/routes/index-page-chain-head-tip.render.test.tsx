import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { blocksQuery } from "@/lib/metagraphed/queries";

// #8524: -index-page's ChainHeadTip must render `null` on SSR and the first
// client paint even when the shared `blocksQuery({ limit: 1 })` cache key is
// ALREADY populated (registry-ticker.tsx consumes the same key), because
// `enabled: hydrated` only blocks a new fetch, not a read of what's already
// cached. The guard `if (!hydrated) return null;` is what actually holds the
// two render passes in agreement (the #418 hydration mismatch). This suite
// pins that: with useHydrated() false AND the cache pre-populated, the tip is
// empty; flip useHydrated() true with the same cache and the live link appears
// -- proving the guard, not an empty cache, is what suppresses the first paint.

// The route's <Link> can't render outside a RouterProvider; swap it for a
// plain anchor. Everything else from the router module stays real.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { createElement: h } = await import("react");
  return {
    ...actual,
    Link: ({ children }: { children?: ReactNode }) => h("a", { href: "#" }, children),
  };
});

// Drive the hydration gate directly rather than depending on router internals.
const hydratedRef = { current: false };
vi.mock("@/hooks/use-hydrated", () => ({
  useHydrated: () => hydratedRef.current,
}));

// Imported after the mocks above are registered.
const { ChainHeadTip } = await import("./-index-page");

function renderWithPopulatedCache(): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Populate the exact shared key registry-ticker.tsx also uses -- keyed off
  // the real query options so the key can't drift from the component's read.
  client.setQueryData(blocksQuery({ limit: 1 }).queryKey, {
    data: [
      {
        block_number: 6_500_123,
        block_hash: "0xtest",
        observed_at: new Date(0).toISOString(),
      },
    ],
    meta: {},
    url: "https://api.metagraph.sh/test",
  });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(ChainHeadTip)),
  );
}

describe("ChainHeadTip hydration guard (#8524)", () => {
  it("renders null when not hydrated even though the shared blocks cache is populated", () => {
    hydratedRef.current = false;
    expect(renderWithPopulatedCache()).toBe("");
  });

  it("renders the head link once hydrated, from that same populated cache", () => {
    hydratedRef.current = true;
    const html = renderWithPopulatedCache();
    expect(html).not.toBe("");
    expect(html).toContain("6,500,123");
  });
});
