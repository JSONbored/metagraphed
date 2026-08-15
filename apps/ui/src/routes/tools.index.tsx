import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/tools` is a container, not a page (#11283).
 *
 * The breadcrumb links every path segment, so a reader on /accounts was
 * offered a parent link that 404'd. This sends them to the account tools, which is
 * what the segment means.
 */
export const Route = createFileRoute("/tools/")({
  beforeLoad: () => {
    // 301: the segment will never be a page of its own.
    throw redirect({ to: "/accounts", replace: true, statusCode: 301 });
  },
});
