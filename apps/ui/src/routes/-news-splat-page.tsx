import { Suspense } from "react";
import { useLoaderData } from "@tanstack/react-router";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { browser } from "fumadocs-mdx/runtime/browser";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import type * as SourceConfig from "../../source.config";
import { AppShell } from "@/components/metagraphed/app-shell";
import { getMDXComponents } from "@/components/metagraphed/mdx";
import { baseOptions } from "@/lib/docs-layout-shared";

// Keep the digest map independent from docs. Importing the generated combined
// browser collection makes this route carry every API-reference module too.
const newsCollection = browser<
  typeof SourceConfig,
  import("fumadocs-mdx/runtime/types").InternalTypeConfig
>().doc(
  "news",
  import.meta.glob(["./**/*.{mdx,md}"], {
    base: "../../content/news",
    query: { collection: "news" },
  }),
);

// #8705. Deliberately thinner than the docs splat page: no ViewOptionsPopover
// (a digest is not a doc you hand to an agent to work from), and no
// "Last updated" line -- these pages are immutable once written, so a modified
// date would only ever restate the generation date.
const clientLoader = newsCollection.createClientLoader({
  component({ toc, frontmatter, default: MDX }) {
    return (
      <DocsPage toc={toc}>
        <DocsTitle>{frontmatter.title}</DocsTitle>
        <DocsDescription>{frontmatter.description}</DocsDescription>
        <DocsBody className="mg-prose">
          {/* getMDXComponents rather than the useMDXComponents alias, for the
              same hooks-naming reason -docs-splat-page.tsx documents. */}
          <MDX components={getMDXComponents()} />
        </DocsBody>
      </DocsPage>
    );
  },
});

export function NewsSplatPage() {
  const data = useFumadocsLoader(useLoaderData({ from: "/news/$" }));

  return (
    // theme.enabled: false for the same reason the docs route sets it — the
    // app owns the .dark class via its own pre-hydration bootstrap.
    <RootProvider theme={{ enabled: false }}>
      <AppShell fullBleedMain>
        <DocsLayout {...baseOptions()} tree={data.pageTree}>
          <Suspense>{clientLoader.useContent(data.path)}</Suspense>
        </DocsLayout>
      </AppShell>
    </RootProvider>
  );
}
