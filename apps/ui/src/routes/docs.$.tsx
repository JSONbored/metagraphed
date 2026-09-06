import { NotFoundComponent } from "./-root-views";
import { entityNotFoundMeta, isNotFoundMatch } from "@/lib/metagraphed/entity-not-found-meta";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { buildOgImageUrl, ogImageMeta } from "@/lib/metagraphed/og-card";
import { stringifyJsonLd, techArticleJsonLd } from "@/lib/metagraphed/json-ld";
import { SITE_ORIGIN } from "@/lib/metagraphed/identity";
import { rawMarkdownLink } from "@/lib/metagraphed/raw-markdown";
import { clampText } from "@/lib/metagraphed/truncate";
import type { OpenAPIPreloaded } from "@/lib/openapi-preload-context";
import { DocsSplatPage } from "./-docs-splat-page";

// RootProvider is scoped locally to this route rather than __root.tsx. The
// app has no single shared provider tree -- __root.tsx's RootComponent only
// wraps QueryClientProvider/Outlet/Toaster, and every other provider
// (DefinitionsProvider, ApiSourceProvider) is wrapped per-route inside AppShell,
// which each route renders itself. This follows that same convention:
// RootProvider only needs to be an ancestor of DocsLayout/DocsPage, not
// literally at the application root -- React context doesn't care where in
// the tree the provider sits. DocsLayout itself nests inside AppShell (same
// as every other route) so docs pages keep the real site header/footer;
// only the content area between them is Fumadocs' sidebar+TOC shell.
export const Route = createFileRoute("/docs/$")({
  notFoundComponent: NotFoundComponent,
  component: DocsSplatPage,
  // Deliberately does NOT call clientLoader.preload() here. TanStack
  // Router's automatic code-splitting only extracts the `component` field
  // into its own lazy chunk (?tsr-split=component) -- any OTHER route-config
  // field (loader, head, ...) that references a top-level binding forces
  // that binding, and everything it closes over, to stay in the route's
  // eager bundle (the one every page loads, since the route tree imports it
  // unconditionally to register the route). clientLoader's factory embeds
  // fumadocs-ui's <DocsPage>/<DocsTitle>/... JSX directly in its component
  // callback; referencing it from loader was pulling all of fumadocs-ui into
  // every page's initial load. Suspense inside the (already-lazy) component
  // still covers the loading state without it -- this only forgoes starting
  // the content fetch a beat earlier during route transition. clientLoader
  // itself now lives in -docs-splat-page.tsx alongside DocsSplatPage (its
  // only consumer, #7850) -- same split chunk either way, since what matters
  // is the `component:` field boundary, not which physical file defines it.
  loader: async ({ params }) => {
    const slugs = params._splat?.split("/") ?? [];
    return serverLoader({ data: slugs });
  },
  head: ({ loaderData, params, match }) => {
    if (isNotFoundMatch(match)) {
      return entityNotFoundMeta("Document", "No documentation page matches this path.");
    }
    return {
      meta: [
        { title: loaderData ? `${loaderData.title} — Metagraphed Docs` : "Metagraphed Docs" },
        { name: "description", content: loaderData?.description ?? "" },
        {
          property: "og:title",
          content: loaderData ? `${loaderData.title} — Metagraphed Docs` : "Metagraphed Docs",
        },
        { property: "og:description", content: loaderData?.description ?? "" },
        // #8624: every /docs/* page unfurled with the same generic
        // `og?title=Metagraphed` card. src/server.ts injects that card from the
        // PATHNAME alone and has no page data, so the only place the real title
        // is available is here -- the same reason the entity routes own their
        // cards (see routeOwnsOgImage, which now matches /docs/* so exactly one
        // og:image tag survives). Docs are the most link-worthy pages on the
        // site and they were the ones sharing a card.
        ...ogImageMeta({
          title: loaderData?.title ?? "Documentation",
          subtitle:
            loaderData?.description || "API reference and guides for the Bittensor registry",
          eyebrow: "Docs",
          // Ours, not an entity's: the avatar slot takes the Metagraphed mark
          // rather than a monogram of the page title ("EC" for /docs/economics).
          entity: false,
        }),
      ],
      // #11294: point at this page's markdown twin. Emitted unconditionally --
      // unlike the JSON-LD below, this claims nothing about the page's content,
      // only where its machine-readable form lives, and that URL is correct
      // whether or not the loader resolved.
      links: [rawMarkdownLink("docs", params._splat)],
      // #11204: docs are the pages an answer engine quotes, and they carried no
      // node of their own. TechArticle types the prose and, via `about`, ties it
      // to the catalog the prose documents -- so a quoted sentence leads back to
      // the machine-readable record, and from there to the REST and MCP
      // endpoints. Emitted only when the page actually loaded: a node built from
      // a missing title would assert a document that isn't there.
      scripts: loaderData
        ? [
            {
              type: "application/ld+json",
              children: stringifyJsonLd(
                techArticleJsonLd({
                  headline: loaderData.title,
                  description: loaderData.description,
                  url: `${SITE_ORIGIN}/docs/${params._splat ?? ""}`.replace(/\/+$/, ""),
                  dateModified: loaderData.lastModified,
                  // The page's own OG card. Article types want an image, and
                  // this is the one that already represents the page everywhere
                  // else it is shared.
                  image: buildOgImageUrl({
                    title: loaderData.title ?? "Documentation",
                    subtitle:
                      loaderData.description ||
                      "API reference and guides for the Bittensor registry",
                    eyebrow: "Docs",
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

// content/docs/api-reference/**/*.mdx pages (scripts/generate-openapi-docs.ts)
// carry an `_openapi.preload` frontmatter array of schema URLs -- this
// resolves those into real bundled schema data server-side, since
// fumadocs-openapi's <APIPage /> never fetches its `document` prop itself
// (it requires a pre-resolved `preloaded`/`payload` prop). Other docs pages
// have no `_openapi` field and this is a no-op for them.
function isOpenAPIFrontmatter(value: unknown): value is { preload: string[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { preload?: unknown }).preload)
  );
}

/**
 * Bound for the docs `<meta name="description">`.
 *
 * The generated API-reference pages are already written to 155 (#11258). The
 * 25 HAND-WRITTEN pages are not: their frontmatter `description` is also the
 * visible `<DocsDescription>` subtitle, deliberately written as prose, and the
 * longest runs to 256 characters. Google truncates around 160 either way; this
 * cuts at a word boundary so the snippet ends deliberately rather than wherever
 * the pixel budget happened to run out.
 *
 * Applied HERE and not to the frontmatter, so the page keeps the full sentence
 * on screen and only the head is bounded — the same split `metaDescription`
 * draws for the generated pages.
 */
const DOCS_META_DESCRIPTION_MAX = 160;

const serverLoader = createServerFn({ method: "GET" })
  .validator((slugs: string[]) => slugs)
  .handler(async ({ data: slugs }) => {
    // Keep the compiled MDX collection outside the shared router graph. Every
    // route definition is imported to register the route, while these 350+
    // documents are needed only after a /docs/* request reaches this loader.
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(slugs);
    if (!page) throw notFound();

    const openapiMeta = (page.data as { _openapi?: unknown })._openapi;
    // Cast: Fumadocs' Document type doesn't structurally match
    // OpenAPIPreloaded's recursive JsonValue constraint, needed only so this
    // return value satisfies createServerFn's type-level serializability
    // check. The loaded contract and the operation slice are plain JSON.
    let preloaded: OpenAPIPreloaded;
    if (isOpenAPIFrontmatter(openapiMeta)) {
      const [{ openapi }, { sliceOpenAPIDocumentForOperation }] = await Promise.all([
        import("@/lib/openapi-source"),
        import("@/lib/openapi-operation-slice"),
      ]);
      const loaded = await openapi.getSchema("metagraph");
      const operationSlug = slugs.at(-1) ?? "";
      const sliced = sliceOpenAPIDocumentForOperation(
        loaded.bundled as Record<string, unknown>,
        operationSlug,
      );
      // Keep the whole document only as a compatibility fallback if a
      // generated page and a newly deployed contract briefly drift. In the
      // normal case each page serializes its one operation plus transitive
      // component references instead of all ~300 operations.
      preloaded = {
        docs: { metagraph: sliced?.document ?? loaded.bundled },
        proxyUrl: openapi.options.proxyUrl,
      } as OpenAPIPreloaded;
    }

    const data = page.data as {
      description?: string;
      metaDescription?: string;
      lastModified?: Date | string;
    };
    return {
      path: page.path,
      pageTree: await docsSource.serializePageTree(docsSource.getPageTree()),
      title: page.data.title,
      // #11251: `metaDescription` is a SEPARATE frontmatter key from
      // `description`, and the fallback order matters. `description` is what
      // <DocsDescription> paints as a one-line subtitle, so the 290 generated
      // API-reference pages deliberately leave it empty (their prose is already
      // rendered in full inside <APIPage/>) -- and that left every one of them
      // shipping `<meta name="description" content="">`, an EMPTY description
      // on 83% of the docs. This reads the meta-only key when there is one, so
      // the head is correct without changing what the page looks like.
      description: clampText(
        page.data.description || data.metaDescription || "",
        DOCS_META_DESCRIPTION_MAX,
      ),
      // Git-derived at build time (source.config.ts docs.lastModified), and
      // already rendered on the page as "Last updated" -- so the structured
      // data below states a date the reader can see, which is the rule.
      lastModified:
        data.lastModified instanceof Date
          ? data.lastModified.toISOString()
          : (data.lastModified ?? null),
      preloaded,
    };
  });
