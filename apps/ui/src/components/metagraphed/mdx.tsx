import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { createOpenAPIPage } from "fumadocs-openapi/ui";
import type { OpenAPIPageProps_Preloaded } from "fumadocs-openapi/ui";
import type { GeneratedPageProps } from "fumadocs-openapi";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { useOpenAPIPreload } from "@/lib/openapi-preload-context";

// The component fumadocs-openapi's generateFiles() output references as
// `props.components.APIPage` (or its old v10 name, OpenAPIPage) -- every
// generated content/docs/api-reference/**/*.mdx file's default export reads
// this off `components` rather than importing it directly, since the
// generated files are meant to stay framework-agnostic. One shared instance
// here (not per-page) keeps its internal caches/shiki highlighter warm
// across operation pages.
const RawAPIPage = createOpenAPIPage();

// fumadocs-openapi's real component requires a `preloaded` (or `payload`)
// prop with the actual bundled schema -- it never fetches `document` (a
// plain URL string) itself. The generated MDX's own <APIPage document="…"
// operations={…} /> JSX has no way to carry that (it's auto-generated,
// framework-agnostic output), so this wrapper reads the current page's
// already-resolved schema off context instead -- see docs.$.tsx, which
// populates it from openapi.preloadOpenAPIPage(page) in its server loader.
function APIPage(props: GeneratedPageProps) {
  const preloaded = useOpenAPIPreload();
  if (!preloaded) return null;
  // Cast: OpenAPIPreloaded's JsonValue-typed `docs` (see that type's own
  // comment) doesn't structurally match the SDK's real Record<string,
  // Document> -- same data, different type at this one boundary.
  return <RawAPIPage {...props} preloaded={preloaded as OpenAPIPageProps_Preloaded["preloaded"]} />;
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    // Registers a page's canonical data-source paths with the global
    // ApiSourceProvider (powers the header's API drawer) -- same component
    // every hand-rolled docs page already used, now usable directly in MDX:
    // <ApiSourceFooter paths={["/api/v1/..."]} />.
    ApiSourceFooter,
    APIPage,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
