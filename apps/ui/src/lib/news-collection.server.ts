import { server } from "fumadocs-mdx/runtime/server";
import type * as SourceConfig from "../../source.config";

// See docs-collection.server.ts. A dedicated import map prevents a digest
// request from evaluating the much larger generated API-reference collection.
const create = server<
  typeof SourceConfig,
  import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
    DocData: { docs: { lastModified?: Date } };
  }
>();

export const news = await create.docs(
  "news",
  "content/news",
  import.meta.glob(["./**/*.{json,yaml}"], {
    base: "./../../content/news",
    query: { collection: "news" },
    import: "default",
    eager: true,
  }),
  import.meta.glob(["./**/*.{mdx,md}"], {
    base: "./../../content/news",
    query: { collection: "news" },
    eager: true,
  }),
);
