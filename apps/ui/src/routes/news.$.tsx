import { NotFoundComponent } from "./-root-views";
import { entityNotFoundMeta, isNotFoundMatch } from "@/lib/metagraphed/entity-not-found-meta";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { buildOgImageUrl, ogImageMeta } from "@/lib/metagraphed/og-card";
import { stringifyJsonLd, techArticleJsonLd } from "@/lib/metagraphed/json-ld";
import { SITE_ORIGIN } from "@/lib/metagraphed/identity";
import { rawMarkdownLink } from "@/lib/metagraphed/raw-markdown";
import { clampText } from "@/lib/metagraphed/truncate";
import { NewsSplatPage } from "./-news-splat-page";

// #8705: the weekly digests, at /news/sn8/2026-w31 and /news/network/2026-w31,
// plus /news itself for the archive index. Mirrors the /docs splat route --
// same fumadocs loader shape, same reason RootProvider is scoped to the route
// rather than __root.tsx (see -docs-splat-page.tsx).
/**
 * Same budget the docs route applies (#11264). The index page's frontmatter
 * description runs to 175 characters, because it is also the visible subtitle.
 */
const NEWS_META_DESCRIPTION_MAX = 160;

export const Route = createFileRoute("/news/$")({
  notFoundComponent: NotFoundComponent,
  component: NewsSplatPage,
  loader: async ({ params }) => {
    const slugs = params._splat?.split("/").filter(Boolean) ?? [];
    return serverLoader({ data: slugs });
  },
  head: ({ loaderData, params, match }) => {
    if (isNotFoundMatch(match)) {
      return entityNotFoundMeta("Digest", "No news page matches this path.");
    }
    return {
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
      // #11294: this digest as plain markdown. These are the pages whose value is
      // a specific quotable claim, so they are exactly the ones worth handing to
      // an answer engine without HTML around it.
      links: [rawMarkdownLink("news", params._splat)],
      // #11279: a digest is editorial prose about a subnet's week, so Article --
      // not the TechArticle the reference docs use, which would claim these
      // document an interface. `about` points at the catalog, so a quoted
      // sentence leads back to the records the digest was written from.
      scripts: loaderData
        ? [
            {
              type: "application/ld+json",
              children: stringifyJsonLd(
                techArticleJsonLd({
                  type: "Article",
                  headline: loaderData.title,
                  description: loaderData.description,
                  url: `${SITE_ORIGIN}/news/${params._splat ?? ""}`.replace(/\/+$/, ""),
                  // The week the digest COVERS. There is no honest publication
                  // timestamp -- the store records the week, not the run -- so
                  // none is claimed. See generate-digest-pages.ts's weekInterval.
                  temporalCoverage: loaderData.temporalCoverage,
                  image: buildOgImageUrl({
                    title: loaderData.title ?? "Weekly digests",
                    subtitle:
                      loaderData.description ||
                      "What changed, week by week, for each Bittensor subnet",
                    eyebrow: "Digest",
                    entity: false,
                  }),
                }),
              ),
            },
          ]
        : [],
    };
  },
});

const serverLoader = createServerFn({ method: "GET" })
  .validator((slugs: string[]) => slugs)
  .handler(async ({ data: slugs }) => {
    // The route tree registers this module for every request. Load the 290+
    // compiled digests only when a /news/* page actually needs them.
    const { newsSource } = await import("@/lib/news-source");
    const page = newsSource.getPage(slugs);
    if (!page) throw notFound();
    const data = page.data as { description?: string; temporalCoverage?: string };
    return {
      path: page.path,
      title: page.data.title,
      description: clampText(page.data.description ?? "", NEWS_META_DESCRIPTION_MAX),
      temporalCoverage: data.temporalCoverage ?? null,
      // serializePageTree, not the raw tree: a page tree's `name` is a
      // ReactNode, which createServerFn's serializability check rejects.
      // Same call docs.$.tsx makes for the same reason.
      pageTree: await newsSource.serializePageTree(newsSource.getPageTree()),
    };
  });
