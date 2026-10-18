import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/metagraphed/client";
import { accountPositionsQuery } from "@/lib/metagraphed/queries";
import { PositionsSection } from "./positions";

vi.mock("@/lib/metagraphed/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/metagraphed/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const SS58 = "5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9";
const NOTICE = "Refresh failed; showing the last recorded response.";

async function render(client: QueryClient) {
  const rootRoute = createRootRoute({
    component: () => <PositionsSection ss58={SS58} nameOf={(netuid) => `Subnet ${netuid}`} />,
  });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() });
  await router.load();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("PositionsSection refresh failures", () => {
  for (const positions of [[], [{ hotkey: "5A", netuid: 1 }]]) {
    it(`labels a failed refresh while retaining ${positions.length} recorded relationships`, async () => {
      const client = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
      });
      const query = { ...accountPositionsQuery(SS58), staleTime: 0 };
      const response = {
        data: {
          ss58: SS58,
          captured_at: "2026-07-05T00:00:00Z",
          position_count: positions.length,
          positions,
        },
        meta: {},
        url: "/fixture",
      };
      const fetch = vi.mocked(apiFetch);
      try {
        fetch.mockResolvedValue(response);
        const recorded = await client.fetchQuery(query);
        expect(await render(client)).not.toContain(NOTICE);

        fetch.mockRejectedValue(new Error("refresh failed"));
        await expect(client.fetchQuery(query)).rejects.toThrow("refresh failed");
        expect(client.getQueryData(query.queryKey)).toEqual(recorded);
        const failed = await render(client);
        expect(failed).toContain(`role="status">${NOTICE}`);
        expect(failed).toContain("Retry refresh");
        expect(failed).toContain("7/5/2026");
        expect(failed).toContain("do not establish wallet holdings");
        expect(failed).not.toContain("Position snapshots unavailable");
        expect(failed).toContain(
          positions.length
            ? 'href="/subnets/1"'
            : "No position relationships recorded in this response.",
        );

        fetch.mockResolvedValue(response);
        await client.fetchQuery(query);
        const recovered = await render(client);
        expect(recovered).not.toContain(NOTICE);
        expect(recovered).not.toContain("Retry refresh");
      } finally {
        client.clear();
        fetch.mockReset();
      }
    });
  }
});
