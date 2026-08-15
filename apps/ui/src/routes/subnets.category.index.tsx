import { createFileRoute, redirect } from "@tanstack/react-router";

// #11342: `/subnets/category` is an intermediate path segment of every category
// URL, and #11283's gate is what caught it 404ing — a linked breadcrumb crumb
// pointing at nothing, which is the exact defect that put 129 dead prefixes on
// the site (#11303).
//
// 301 rather than a listing page: the categories are already listed on
// /subnets, and a second index of them would compete with the hub for the same
// query. Permanent, because this segment will never be a page — the same answer
// /graphql, /tools and /design give.
export const Route = createFileRoute("/subnets/category/")({
  beforeLoad: () => {
    throw redirect({ to: "/subnets", statusCode: 301 });
  },
});
