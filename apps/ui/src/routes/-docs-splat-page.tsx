import { Suspense } from "react";
import { useLoaderData, useParams } from "@tanstack/react-router";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  ViewOptionsPopover,
} from "fumadocs-ui/layouts/docs/page";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import { TimeAgo } from "@jsonbored/ui-kit";
import browserCollections from "collections/browser";
import { AppShell } from "@/components/metagraphed/app-shell";
import { getMDXComponents } from "@/components/metagraphed/mdx";
import { baseOptions } from "@/lib/docs-layout-shared";
import { OpenAPIPreloadProvider } from "@/lib/openapi-preload-context";

const clientLoader = browserCollections.docs.createClientLoader<{ markdownUrl: string }>({
  component({ toc, frontmatter, default: MDX, lastModified }, { markdownUrl }) {
    return (
      <DocsPage toc={toc}>
        <DocsTitle>{frontmatter.title}</DocsTitle>
        <DocsDescription>{frontmatter.description}</DocsDescription>
        {/* Anchored to "Last updated," not the title -- floating this next
            to a (potentially multi-line, especially on mobile) H1 read as
            misplaced. Metadata + page actions belong in the same row. */}
        <div className="flex items-center justify-between gap-4">
          {/* lastModified comes from local `git log` at build/dev-compile
              time (source.config.ts's docs.lastModified: true), not a live
              GitHub API call -- this app deploys to a Cloudflare Worker with
              no .git directory at runtime, so a runtime call would need its
              own caching/token and could rate-limit. Baked in at compile
              time instead, same as frontmatter/toc already are. */}
          {lastModified ? (
            <p className="mg-type-caption text-ink-muted">
              Last updated <TimeAgo at={lastModified.toISOString()} />
            </p>
          ) : (
            <span />
          )}
          {/* Fumadocs' own page-actions component (fumadocs.dev/docs/integrations/llms#page-actions)
              -- Copy Page / View as Markdown / Open in ChatGPT, Claude, Cursor,
              Scira AI. markdownUrl points at docs.raw.$.ts, a real per-page
              route -- a client-built data: URI doesn't work here: Chrome
              silently blocks target="_blank" navigation to data: URLs, which
              breaks the popover's "View as Markdown" link (a plain <a href>)
              even though its "Copy" action (fetch-based) would've been fine
              with one. The "Open in ChatGPT/Claude/..." items don't use
              markdownUrl at all -- they send the *page's own* URL for that
              service to fetch itself. */}
          <ViewOptionsPopover markdownUrl={markdownUrl} />
        </div>
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

export function DocsSplatPage() {
  const data = useFumadocsLoader(useLoaderData({ from: "/docs/$" }));
  // Same splat docsSource.getPage() already resolved this page from --
  // docs.raw.$.ts re-resolves it the same way, so this always points at a
  // real page.
  const { _splat } = useParams({ from: "/docs/$" });
  const markdownUrl = `/docs/raw/${_splat ?? ""}`;

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
            <Suspense>{clientLoader.useContent(data.path, { markdownUrl })}</Suspense>
          </OpenAPIPreloadProvider>
        </DocsLayout>
      </AppShell>
    </RootProvider>
  );
}
