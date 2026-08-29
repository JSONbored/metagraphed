import { server } from "fumadocs-mdx/runtime/server";
import type * as SourceConfig from "../../source.config";

// Fumadocs' generated `collections/server` module eagerly creates every
// configured collection. That is convenient for small sites, but it couples
// the documentation corpus to all weekly digests: asking for either source
// evaluates both sets of compiled MDX modules. Keep the server-side import map
// collection-specific so /docs/* pays only for documentation.
const create = server<
  typeof SourceConfig,
  import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
    DocData: { docs: { lastModified?: Date } };
  }
>();

export const docs = await create.docs(
  "docs",
  "content/docs",
  import.meta.glob(["./**/*.{json,yaml}"], {
    base: "./../../content/docs",
    query: { collection: "docs" },
    import: "default",
    eager: true,
  }),
  import.meta.glob(["./**/*.{mdx,md}"], {
    base: "./../../content/docs",
    query: { collection: "docs" },
    eager: true,
  }),
);
