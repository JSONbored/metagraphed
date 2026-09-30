import { createFileRoute, redirect } from "@tanstack/react-router";

// The website editor is retired. Existing API/MCP GraphQL consumers retain
// their handler; old editor links lead directly to the REST API reference.
export const Route = createFileRoute("/graphql/")({
  beforeLoad: () => {
    throw redirect({
      to: "/docs/$",
      params: { _splat: "api-reference" },
      replace: true,
      statusCode: 301,
    });
  },
});
