import { createOpenAPIPageBase } from "fumadocs-openapi/ui/base";
import type { OpenAPIPageProps_Preloaded } from "fumadocs-openapi/ui";
import type { GeneratedPageProps } from "fumadocs-openapi";
import { useOpenAPIPreload } from "@/lib/openapi-preload-context";
import { openapiShikiFactory } from "@/lib/openapi-shiki";

// Keep the OpenAPI renderer outside the shared MDX component module. News and
// hand-written guide pages never render it; loading this package tree for them
// added hundreds of kilobytes of API-schema UI and syntax-highlighting code.
// API-reference pages reach this module through React.lazy in mdx.tsx.
//
// createOpenAPIPageBase, rather than createOpenAPIPage, is intentional: the
// convenience wrapper keeps the full Shiki catalog reachable even when a
// scoped factory is supplied. This base entry is the supported escape hatch.
const RawAPIPage = createOpenAPIPageBase({ shiki: openapiShikiFactory });

// Generated MDX supplies the operation identity but not the resolved schema.
// The route loader slices and serializes that schema, then this wrapper reads
// it from context and completes the real Fumadocs component contract.
export function OpenAPIPage(props: GeneratedPageProps) {
  const preloaded = useOpenAPIPreload();
  if (!preloaded) return null;
  return <RawAPIPage {...props} preloaded={preloaded as OpenAPIPageProps_Preloaded["preloaded"]} />;
}
