import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { BlockActivityWindow } from "./block-activity-window";

async function render() {
  const rootRoute = createRootRoute({
    component: () => (
      <BlockActivityWindow
        blocks={[
          { block_number: 12, block_hash: "0xc", extrinsic_count: 16, event_count: 3 },
          { block_number: 11, block_hash: "0xb", extrinsic_count: 0, event_count: 0 },
        ]}
      />
    ),
  });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("BlockActivityWindow", () => {
  it("keeps exact counts, keyboard direction, and a block-detail link beside the visual", async () => {
    const html = await render();

    expect(html).toContain("Latest indexed block activity");
    expect(html).toContain("#12");
    expect(html).toContain("16 extrinsics");
    expect(html).toContain("3 events");
    expect(html).toContain('data-activity-level="4"');
    expect(html).toContain('data-activity-level="0"');
    expect(html).toContain('href="/blocks/12"');
    expect(html).toContain('aria-label="Open block #12: 16 extrinsics, 3 events"');
    expect(html).toContain("Mint intensity is a relative, square-root reading");
    expect(html).toContain("select a mark to inspect it");
  });
});
