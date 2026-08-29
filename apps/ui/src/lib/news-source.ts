import { loader } from "fumadocs-core/source";
import { news } from "@/lib/news-collection.server";

// #8705: the weekly-digest pages, served at /news/**. Deliberately plainer
// than docsSource — no openapi loader plugin, because a digest page is prose
// and a source list, never a rendered schema.
export const newsSource = loader({
  baseUrl: "/news",
  source: news.toFumadocsSource(),
});
