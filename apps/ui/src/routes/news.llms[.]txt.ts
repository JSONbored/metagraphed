import { createFileRoute } from "@tanstack/react-router";
import { llmsIndexBody, llmsIndexHeaders } from "@/lib/metagraphed/llms-index";

// #11294: the digests' own index, the mirror of /docs/llms.txt.
//
// 285 pages, each a dated claim about one subnet's week, and until now they
// appeared in no llms.txt at all -- not this host's (there wasn't one) and not
// the repo-wide public/llms.txt, which indexes the API and nothing on
// metagraph.sh. An agent asking "what changed on SN38 in June" had the answer
// published and no way to find it.
export const Route = createFileRoute("/news/llms.txt")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const [{ llms }, { newsSource }] = await Promise.all([
          import("fumadocs-core/source/llms"),
          import("@/lib/news-source"),
        ]);
        const { origin } = new URL(request.url);
        return new Response(
          llmsIndexBody({
            index: llms(newsSource).index(),
            section: "news",
            origin,
            // NOT the loader's own H1: `llms()` hardcodes "# Docs" whatever
            // collection it is given, so this index introduced 285 weekly
            // digests as the documentation.
            title: "Metagraphed weekly subnet digests",
            example: "sn38/2026-w25",
          }),
          { headers: llmsIndexHeaders() },
        );
      },
    },
  },
});
