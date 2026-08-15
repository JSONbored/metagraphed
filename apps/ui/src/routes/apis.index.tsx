import { createFileRoute } from "@tanstack/react-router";
import { surfacesSearchSchema } from "@/lib/metagraphed/surface-filters";
import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { SurfacesPage } from "./-surfaces-page";
import { hubMeta } from "@/lib/metagraphed/hub-copy";

export const Route = createFileRoute("/apis/")({
  validateSearch: surfacesSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(surfacesSearchSchema)] },
  head: () => ({
    meta: hubMeta("/apis"),
  }),
  component: SurfacesPage,
});
