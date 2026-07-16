import { createContext, useContext } from "react";

// Carries the current page's resolved OpenAPI schema data (from
// openapi.preloadOpenAPIPage(page) in docs.$.tsx's server loader) down to
// the APIPage component registered in mdx.tsx. A context, not a prop,
// because the generated content/docs/api-reference/**/*.mdx pages'
// <APIPage document="…" operations={…} /> JSX is auto-generated and doesn't
// (and per its own "do not edit" header, shouldn't) know about this --
// APIPage reads it off context and merges it in before delegating to
// fumadocs-openapi's real component, which requires a `preloaded` prop.
// A concrete recursive JSON type, not `unknown` -- this value round-trips
// through a TanStack Start createServerFn boundary (docs.$.tsx's
// serverLoader), whose type-level serializability check recursively walks
// leaf types against a known-safe set (string/number/boolean/null/...);
// `unknown` can never satisfy that (it doesn't structurally extend any of
// them), even though the runtime value is plain JSON.
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type OpenAPIPreloaded = { docs: Record<string, JsonValue>; proxyUrl?: string } | undefined;

const OpenAPIPreloadContext = createContext<OpenAPIPreloaded>(undefined);

export const OpenAPIPreloadProvider = OpenAPIPreloadContext.Provider;

export function useOpenAPIPreload(): OpenAPIPreloaded {
  return useContext(OpenAPIPreloadContext);
}
