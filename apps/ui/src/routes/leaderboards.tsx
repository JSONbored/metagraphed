import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";

export const leaderboardsSearchSchema = z.object({
  window: fallback(z.enum(["7d", "30d"]), "7d").default("7d"),
});

// #8311: /leaderboards retired into /subnets?section=rankings. Every board
// ranks subnets, so they belong on the subnets page rather than behind a
// separate top-level route. `window` is forwarded so an existing shared link
// lands on the same range it named.
export const Route = createFileRoute("/leaderboards")({
  validateSearch: zodValidator(leaderboardsSearchSchema),
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/subnets",
      search: { section: "rankings", window: search.window },
      replace: true,
    });
  },
});
