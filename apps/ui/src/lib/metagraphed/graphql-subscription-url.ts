/**
 * Convert an HTTP(S) GraphQL endpoint URL to the WebSocket URL used for
 * `graphql-transport-ws` subscriptions on the same path (#4983 / #7009).
 * Returns null for non-http(s) inputs so callers can skip wiring.
 */
export function toGraphqlSubscriptionUrl(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol === "http:") url.protocol = "ws:";
    else return null;
    return url.toString();
  } catch {
    return null;
  }
}
