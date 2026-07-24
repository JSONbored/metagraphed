import type { CodegenConfig } from "@graphql-codegen/cli";

// GraphQL codegen (types-epic D, #7862): schema points at src/graphql-sdl.ts
// (the SDL string extracted from src/graphql.ts specifically so codegen's
// module-import schema loader doesn't drag in that file's full resolver map
// as a side effect of every codegen run — see graphql-sdl.ts's own header).
// `generated/graphql/types.ts` is the ONLY output; nothing else is written.
const config: CodegenConfig = {
  schema: "src/graphql-sdl.ts",
  generates: {
    "generated/graphql/types.ts": {
      plugins: ["typescript", "typescript-resolvers"],
      config: {
        // JSON is the SDL's opaque-value scalar (incident by_kind maps,
        // Adapter's snapshot/extensions, etc.) — matches how the MCP mirror
        // and workers/data-api.ts treat the same shapes: unknown, not any.
        scalars: { JSON: "unknown" },
        // src/graphql.ts's `GqlContext` (exported for exactly this) — every
        // resolver's contextValue in the real rootValue object. Path is
        // relative to the OUTPUT file (generated/graphql/types.ts), so two
        // levels up to the repo root, then into src/.
        contextType: "../../src/graphql.ts#GqlContext",
        // We want exact generated types, not every field auto-wrapped in
        // Partial<T> (typescript-resolvers' default "loose" mapper).
        defaultMapper: "{T}",
        // rootValue is a plain object of resolver methods (graphql-js
        // default-field-resolver style), not an Apollo-style per-type
        // resolver map — makeResolverTypeUnion off keeps the generated
        // Resolvers shape matching that.
        useIndexSignature: true,
      },
    },
  },
};

export default config;
