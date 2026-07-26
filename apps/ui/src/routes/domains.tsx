import { createFileRoute, redirect } from "@tanstack/react-router";

// #8311: /domains retired into /subnets. The page was a 32-line wrapper around
// <DomainsRollup>, and the taxonomy only means anything next to the subnets it
// classifies -- the rollup now sits under the registry table, below the domain
// filter chips that were already there.
export const Route = createFileRoute("/domains")({
  beforeLoad: () => {
    throw redirect({ to: "/subnets", hash: "domains", replace: true });
  },
});
