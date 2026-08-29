import { lazy, Suspense } from "react";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import type { GeneratedPageProps } from "fumadocs-openapi";
import { Skeleton } from "@jsonbored/ui-kit";
import { ApiSources } from "@/components/metagraphed/api-sources";

const LazyOpenAPIPage = lazy(() =>
  import("./openapi-page").then(({ OpenAPIPage }) => ({ default: OpenAPIPage })),
);

function APIPage(props: GeneratedPageProps) {
  return (
    <Suspense fallback={<OpenAPIPageSkeleton />}>
      <LazyOpenAPIPage {...props} />
    </Suspense>
  );
}

function OpenAPIPageSkeleton() {
  return (
    <div
      className="grid gap-[var(--mg-space-lg)] py-[var(--mg-space-lg)]"
      aria-busy="true"
      aria-label="Loading endpoint reference"
    >
      <div className="flex items-center gap-3">
        <Skeleton className="h-7 w-16 rounded" />
        <Skeleton className="h-7 max-w-md flex-1 rounded" />
      </div>
      <Skeleton className="h-4 w-full max-w-2xl" />
      <Skeleton className="h-4 w-4/5 max-w-xl" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
        <Skeleton className="h-48 rounded" />
        <Skeleton className="h-48 rounded" />
      </div>
    </div>
  );
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    APIPage,
    // A docs page declares the endpoints it documents; the shell footer draws
    // them, and the HAR-coverage gate reads the declaration. This was
    // `ApiSourceFooter`, which also drew its own copy of the list at the
    // bottom of the page -- the same list twice, once the footer started
    // showing it on every route (#11628).
    ApiSources,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
