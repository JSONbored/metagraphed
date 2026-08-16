import { createFileRoute, redirect } from "@tanstack/react-router";
import { stripDefaultSearchParams } from "@/lib/metagraphed/url-state";
import { z } from "zod";

export const leaderboardsSearchSchema = z.object({
  window: z.enum(["7d", "30d"]).catch("7d").default("7d"),
});

// #8311: /leaderboards retired into /subnets?section=rankings. Every board
// ranks subnets, so they belong on the subnets page rather than behind a
// separate top-level route. `window` is forwarded so an existing shared link
// lands on the same range it named.
export const Route = createFileRoute("/leaderboards")({
  validateSearch: leaderboardsSearchSchema,
  search: { middlewares: [stripDefaultSearchParams(leaderboardsSearchSchema)] },
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/subnets",
      search: { section: "rankings", window: search.window },
      replace: true,
      // 301, not the 307 default: this route is RETIRED, not temporarily
      // moved. A temporary redirect tells a search engine to keep the old URL
      // and re-check it; a permanent one transfers the signals to /subnets and
      // lets the old URL drop out.
      statusCode: 301,
    });
  },
});
