import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";
import { openapi } from "@/lib/openapi-source";

export const docsSource = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
  // Lets Fumadocs' page tree understand the `_openapi` frontmatter each
  // content/docs/api-reference/** generated page carries (see
  // scripts/generate-openapi-docs.mjs). The actual document resolution
  // (`_openapi.preload` -> a real bundled schema) happens per-request in
  // docs.$.tsx's server loader via openapi.preloadOpenAPIPage(page) --
  // this plugin alone doesn't do it, see that file's comment.
  plugins: [openapi.loaderPlugin()],
});
