import { createFileRoute } from "@tanstack/react-router";
import { OverviewPage } from "./-index-page";
import { hubMeta } from "@/lib/metagraphed/hub-copy";
import { API_DATA_ORIGIN } from "@/lib/metagraphed/identity";

/**
 * Start the optional desktop instrument while the document is still parsing.
 * `type` aligns the preload's Accept header with apiFetch, so the hydrated
 * React Query read reuses the same browser-cache entry. The media attribute is
 * load-bearing: the compact phone hero does not render this rail and therefore
 * must not pay for its feed.
 */
export const HOME_BLOCK_FEED_URL = `${API_DATA_ORIGIN}/api/v1/blocks?limit=12`;

export const Route = createFileRoute("/")({
  // Seed the same primary query the view suspends on, without moving its
  // optional feeds into the critical path or serializing a second loader copy.
  loader: async ({ context }) => {
    const { economicsQuery } = await import("@/lib/metagraphed/queries");
    await context.queryClient.ensureQueryData(economicsQuery({ fields: "identity" }));
  },
  head: () => ({
    meta: hubMeta("/"),
    links: [
      {
        rel: "preload",
        as: "fetch",
        type: "application/json",
        href: HOME_BLOCK_FEED_URL,
        crossOrigin: "anonymous",
        media: "(min-width: 640px)",
      },
    ],
  }),
  component: OverviewPage,
});
