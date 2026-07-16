import { Suspense } from "react";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import { TimeAgo } from "@jsonbored/ui-kit";
import browserCollections from "collections/browser";
import { AppShell } from "@/components/metagraphed/app-shell";
import { CopyMarkdownButton } from "@/components/metagraphed/copy-markdown-button";
import { getMDXComponents } from "@/components/metagraphed/mdx";
import { baseOptions } from "@/lib/docs-layout-shared";
import { docsSource } from "@/lib/docs-source";
import { openapi } from "@/lib/openapi-source";
import { OpenAPIPreloadProvider, type OpenAPIPreloaded } from "@/lib/openapi-preload-context";

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
  component: Page,
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
  // the content fetch a beat earlier during route transition.
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

// content/docs/api-reference/**/*.mdx pages (scripts/generate-openapi-docs.mjs)
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

const clientLoader = browserCollections.docs.createClientLoader({
  component({ toc, frontmatter, default: MDX, _markdown, lastModified }, _props: undefined) {
    return (
      <DocsPage toc={toc}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <DocsTitle>{frontmatter.title}</DocsTitle>
            <DocsDescription>{frontmatter.description}</DocsDescription>
          </div>
          <CopyMarkdownButton markdown={_markdown} />
        </div>
        {/* lastModified comes from local `git log` at build/dev-compile time
            (source.config.ts's docs.lastModified: true), not a live GitHub
            API call -- this app deploys to a Cloudflare Worker with no .git
            directory at runtime, so a runtime call would need its own
            caching/token and could rate-limit. Baked in at compile time
            instead, same as frontmatter/toc already are. */}
        {lastModified ? (
          <p className="text-[12px] text-ink-muted -mt-4">
            Last updated <TimeAgo at={lastModified.toISOString()} />
          </p>
        ) : null}
        <DocsBody>
          {/* getMDXComponents, not the useMDXComponents alias -- this
              `component` callback is a plain object method (fumadocs'
              createClientLoader API contract fixes that name), so
              eslint-plugin-react-hooks doesn't recognize it as a component
              and flags a `use*`-prefixed call inside it as a hooks-rules
              violation. Same function underneath; this alias just doesn't
              trip the naming heuristic. */}
          <MDX components={getMDXComponents()} />
        </DocsBody>
      </DocsPage>
    );
  },
});

function Page() {
  const data = useFumadocsLoader(Route.useLoaderData());

  return (
    // theme.enabled: false -- the app already manages the .dark class itself
    // (a pre-hydration bootstrap script in lib/theme.ts, synced to the
    // SettingsPopover toggle). Fumadocs' CSS reads that same ambient .dark
    // class regardless of who set it; running next-themes here too would
    // just be a second, independent theme manager that could drift out of
    // sync with the app's real state instead of following it.
    <RootProvider theme={{ enabled: false }}>
      <AppShell fullBleedMain>
        <DocsLayout {...baseOptions()} tree={data.pageTree}>
          <OpenAPIPreloadProvider value={data.preloaded}>
            <Suspense>{clientLoader.useContent(data.path)}</Suspense>
          </OpenAPIPreloadProvider>
        </DocsLayout>
      </AppShell>
    </RootProvider>
  );
}
