// Cloudflare's external RUM script server rejects Signature preflights.
// no-transform prevents that edge injection for signed browsers; their existing
// first-party PostHog analytics still run. This is compatibility, not signature
// verification. Ordinary browsers retain Cloudflare RUM.
// https://developers.cloudflare.com/web-analytics/get-started/#sites-proxied-through-cloudflare
const SIGNATURE_HEADERS = ["Signature", "Signature-Input", "Signature-Agent"] as const;

function appendCacheDirective(headers: Headers, name: string, directive: string): void {
  const existing = (headers.get(name) ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase());
  if (!existing.includes(directive)) headers.append(name, directive);
}

export function applySignedBrowserAnalyticsPolicy(response: Response, request: Request): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.split(";", 1)[0].trim().toLowerCase() !== "text/html") return response;

  const headers = new Headers(response.headers);
  const vary = new Set(
    (headers.get("vary") ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase()),
  );
  // Both variants must declare the same inputs so a browser cannot reuse an
  // unsigned page (with the injected script) for a signed navigation.
  if (!vary.has("*")) {
    for (const name of SIGNATURE_HEADERS) {
      if (!vary.has(name.toLowerCase())) headers.append("vary", name);
    }
  }

  if (SIGNATURE_HEADERS.some((name) => request.headers.get(name)?.trim())) {
    // Cloudflare does not honor arbitrary Vary fields by default. HTML is
    // uncached there by default; do not let a signed response enter a cache.
    appendCacheDirective(headers, "cache-control", "no-store");
    appendCacheDirective(headers, "cache-control", "no-transform");
    for (const name of ["cdn-cache-control", "cloudflare-cdn-cache-control"]) {
      if (headers.has(name)) appendCacheDirective(headers, name, "no-store");
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
