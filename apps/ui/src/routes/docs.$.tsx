import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { docsSource } from "@/lib/docs-source";
import { openapi } from "@/lib/openapi-source";
import type { OpenAPIPreloaded } from "@/lib/openapi-preload-context";
import { DocsSplatPage } from "./-docs-splat-page";

// RootProvider is scoped locally to this route rather than __root.tsx. The
// app has no single shared provider tree -- __root.tsx's RootComponent only
// wraps QueryClientProvider/Outlet/Toaster, and every other provider
// (TooltipProvider, ApiSourceProvider) is wrapped per-route inside AppShell,
// which each route renders itself. This follows that same convention:
// RootProvider only needs to be an ancestor of DocsLayout/DocsPage, not
// literally at the application root -- React context doesn't care where in
// the tree the provider sits. DocsLayout itself nests inside AppShell (same
// as every other route) so docs pages keep the real site header/footer;
// only the content area between them is Fumadocs' sidebar+TOC shell.
export const Route = createFileRoute("/docs/$")({
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
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData ? `${loaderData.title} — Metagraphed Docs` : "Metagraphed Docs" },
      { name: "description", content: loaderData?.description ?? "" },
      {
        property: "og:title",
        content: loaderData ? `${loaderData.title} — Metagraphed Docs` : "Metagraphed Docs",
      },
      { property: "og:description", content: loaderData?.description ?? "" },
    ],
  }),
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

const serverLoader = createServerFn({ method: "GET" })
  .validator((slugs: string[]) => slugs)
  .handler(async ({ data: slugs }) => {
    const page = docsSource.getPage(slugs);
    if (!page) throw notFound();

    const openapiMeta = (page.data as { _openapi?: unknown })._openapi;
    // Cast: openapi.preloadOpenAPIPage's real return type (Record<string,
    // Document>) doesn't structurally match OpenAPIPreloaded's JsonValue
    // constraint, needed only so this return value satisfies createServerFn's
    // type-level serializability check -- see that type's own comment.
    const preloaded = isOpenAPIFrontmatter(openapiMeta)
      ? ((await openapi.preloadOpenAPIPage(page)).preloaded as OpenAPIPreloaded)
      : undefined;

    return {
      path: page.path,
      pageTree: await docsSource.serializePageTree(docsSource.getPageTree()),
      title: page.data.title,
      description: page.data.description ?? "",
      preloaded,
    };
  });
