import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    // Registers a page's canonical data-source paths with the global
    // ApiSourceProvider (powers the header's API drawer) -- same component
    // every hand-rolled docs page already used, now usable directly in MDX:
    // <ApiSourceFooter paths={["/api/v1/..."]} />.
    ApiSourceFooter,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
