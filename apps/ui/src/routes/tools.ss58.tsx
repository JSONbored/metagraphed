import { createFileRoute, redirect } from "@tanstack/react-router";

// #8252: /tools/ss58 retired into /accounts as the "Inspect an address"
// utility — a dedicated route for one input box was the redesign's example of
// a page that should be a panel. The decoder itself is unchanged (see
// components/metagraphed/ss58-inspector.tsx).
export const Route = createFileRoute("/tools/ss58")({
  beforeLoad: () => {
    throw redirect({ to: "/accounts", replace: true });
  },
});
