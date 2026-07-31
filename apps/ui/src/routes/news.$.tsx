import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { newsSource } from "@/lib/news-source";
import { ogImageMeta } from "@/lib/metagraphed/og-card";
import { NewsSplatPage } from "./-news-splat-page";

// #8705: the weekly digests, at /news/sn8/2026-w31 and /news/network/2026-w31,
// plus /news itself for the archive index. Mirrors the /docs splat route --
// same fumadocs loader shape, same reason RootProvider is scoped to the route
// rather than __root.tsx (see -docs-splat-page.tsx).
export const Route = createFileRoute("/news/$")({
  component: NewsSplatPage,
  loader: async ({ params }) => {
    const slugs = params._splat?.split("/").filter(Boolean) ?? [];
    return serverLoader({ data: slugs });
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData ? `${loaderData.title} — Metagraphed` : "Metagraphed" },
      { name: "description", content: loaderData?.description ?? "" },
      {
        property: "og:title",
        content: loaderData ? `${loaderData.title} — Metagraphed` : "Metagraphed",
      },
      { property: "og:description", content: loaderData?.description ?? "" },
      // #8624's discipline, same as /docs/*: server.ts builds its card from the
      // pathname alone, which would give every digest the identical brand card.
      // routeOwnsOgImage matches /news/.+ so exactly one og:image survives.
      ...ogImageMeta({
        title: loaderData?.title ?? "Weekly digests",
        subtitle:
          loaderData?.description || "What changed, week by week, for each Bittensor subnet",
        eyebrow: "Digest",
        // Ours, not an entity's — the avatar slot takes the Metagraphed mark
        // rather than a monogram of "Subnet 104 — 2026-W29".
        entity: false,
      }),
    ],
  }),
});

const serverLoader = createServerFn({ method: "GET" })
  .validator((slugs: string[]) => slugs)
  .handler(async ({ data: slugs }) => {
    const page = newsSource.getPage(slugs);
    if (!page) throw notFound();
    return {
      path: page.path,
      title: page.data.title,
      description: page.data.description ?? "",
      // serializePageTree, not the raw tree: a page tree's `name` is a
      // ReactNode, which createServerFn's serializability check rejects.
      // Same call docs.$.tsx makes for the same reason.
      pageTree: await newsSource.serializePageTree(newsSource.getPageTree()),
    };
  });
