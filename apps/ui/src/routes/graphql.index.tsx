import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/graphql` is a container, not a page (#11283).
 *
 * The breadcrumb links every path segment, so a reader on /graphql/explorer was
 * offered a parent link that 404'd. This sends them to the GraphQL explorer, which is
 * what the segment means.
 */
export const Route = createFileRoute("/graphql/")({
  beforeLoad: () => {
    // 301: the segment will never be a page of its own.
    throw redirect({ to: "/graphql/explorer", replace: true, statusCode: 301 });
  },
});
