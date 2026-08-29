import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/search")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const [{ createFromSource }, { docsSource }] = await Promise.all([
          import("fumadocs-core/search/server"),
          import("@/lib/docs-source"),
        ]);
        return createFromSource(docsSource, { language: "english" }).GET(request);
      },
    },
  },
});
