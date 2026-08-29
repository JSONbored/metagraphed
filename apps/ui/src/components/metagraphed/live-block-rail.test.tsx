import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { blockEconomicLabel, LIVE_BLOCK_LIMIT, LiveBlockRail } from "./live-block-rail";

async function render() {
  const blocks = Array.from({ length: LIVE_BLOCK_LIMIT }, (_, index) => ({
    block_number: 1_000 - index,
    block_hash: `hash-${index}`,
    extrinsic_count: index + 1,
    event_count: index + 2,
    observed_at: "2026-08-27T00:00:00.000Z",
  })).reverse();
  const rootRoute = createRootRoute({
    component: () => <LiveBlockRail compact blocks={blocks} updatedAt={blocks[0]?.observed_at} />,
  });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() });
  const queryClient = new QueryClient();
  await router.load();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("LiveBlockRail", () => {
  it("distinguishes pending, unavailable and measured economic activity", () => {
    const base = { block_number: 1, block_hash: "hash" };
    expect(blockEconomicLabel({ ...base, decode_status: "pending" })).toBe("Decoding value…");
    expect(blockEconomicLabel({ ...base, decode_status: "unavailable" })).toBe("Value unavailable");
    expect(
      blockEconomicLabel({
        ...base,
        decode_status: "complete",
        economic_activity_tao: 2.5,
        economic_activity_usd: 600,
      }),
    ).toBe("2.50 τ · $600");
  });

  it("renders the bounded twelve-block window newest-first, with every block inspectable", async () => {
    const html = await render();

    expect(html).toContain("12-block window");
    expect(html.indexOf('href="/blocks/1000"')).toBeLessThan(html.indexOf('href="/blocks/989"'));
    expect(html.match(/href="\/blocks\//g)).toHaveLength(LIVE_BLOCK_LIMIT);
    expect(html).toContain("newest at left");
  });
});
