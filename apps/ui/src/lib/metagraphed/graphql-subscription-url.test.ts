import { describe, expect, it } from "vitest";

import { toGraphqlSubscriptionUrl } from "./graphql-subscription-url";

describe("toGraphqlSubscriptionUrl", () => {
  it("maps https GraphQL endpoints to wss on the same path", () => {
    expect(toGraphqlSubscriptionUrl("https://api.metagraph.sh/api/v1/graphql")).toBe(
      "wss://api.metagraph.sh/api/v1/graphql",
    );
  });

  it("maps http to ws (local/dev)", () => {
    expect(toGraphqlSubscriptionUrl("http://127.0.0.1:8787/api/v1/graphql")).toBe(
      "ws://127.0.0.1:8787/api/v1/graphql",
    );
  });

  it("returns null for non-http(s) or malformed URLs", () => {
    expect(toGraphqlSubscriptionUrl("ftp://example.com/api/v1/graphql")).toBeNull();
    expect(toGraphqlSubscriptionUrl("not a url")).toBeNull();
    expect(toGraphqlSubscriptionUrl("")).toBeNull();
  });
});
