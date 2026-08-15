import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/design` is a container, not a page (#11283).
 *
 * The breadcrumb links every path segment, so a reader on /design/primitives was
 * offered a parent link that 404'd. This sends them to the primitives gallery, which is
 * what the segment means.
 */
export const Route = createFileRoute("/design/")({
  beforeLoad: () => {
    // 301: the segment will never be a page of its own.
    throw redirect({ to: "/design/primitives", replace: true, statusCode: 301 });
  },
});
