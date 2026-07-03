import { describe, expect, it } from "vitest";
import {
  GRAPHQL_SAMPLE_QUERY,
  buildPostCurl,
  samplePostBody,
} from "../scripts/lib/post-sample-bodies.mjs";
import { playgroundEntry } from "../scripts/generate-docs-site.mjs";

const graphqlRoute = {
  id: "graphql",
  method: "POST",
  path: "/api/v1/graphql",
  description: "GraphQL query endpoint",
  public: true,
  query_parameters: [],
};

describe("post-sample-bodies", () => {
  it("uses the quickstart GraphQL sample query", () => {
    const body = samplePostBody(graphqlRoute, { paths: {} });
    expect(body).toEqual({ query: GRAPHQL_SAMPLE_QUERY });
  });

  it("buildPostCurl never emits an empty object for body-required routes", () => {
    const curl = buildPostCurl(
      graphqlRoute,
      { paths: {} },
      "https://api.metagraph.sh",
      "/api/v1/graphql",
    );
    expect(curl).toContain('"query":');
    expect(curl).toContain("subnet(netuid: 7)");
    expect(curl).not.toContain("-d '{}'");
  });

  it("prefers OpenAPI requestBody examples when present", () => {
    const openapi = {
      paths: {
        "/api/v1/graphql": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  example: { query: "{ __typename }" },
                },
              },
            },
          },
        },
      },
    };
    expect(samplePostBody(graphqlRoute, openapi)).toEqual({
      query: "{ __typename }",
    });
  });

  it("playgroundEntry includes sample_body for POST routes", () => {
    const entry = playgroundEntry(graphqlRoute, { paths: {} });
    expect(entry.sample_body).toEqual({ query: GRAPHQL_SAMPLE_QUERY });
    expect(entry.curl).not.toContain("-d '{}'");
  });
});
