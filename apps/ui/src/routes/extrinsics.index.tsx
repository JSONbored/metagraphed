import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /extrinsics moved into the Chain hub (#8290, part of #8244). Permanent
 * redirect with search params forwarded, so existing filtered links keep
 * working. The detail route (/extrinsics/$hash) keeps its own URL.
 */
export const Route = createFileRoute("/extrinsics/")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/chain/extrinsics", search, replace: true });
  },
});
