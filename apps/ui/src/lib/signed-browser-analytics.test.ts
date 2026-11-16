import { describe, expect, it } from "vitest";
import { applySignedBrowserAnalyticsPolicy } from "./signed-browser-analytics";

const html = (headers: Record<string, string> = {}) =>
  new Response("<html><head></head><body>Registry</body></html>", {
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
const request = (headers: HeadersInit = {}) => new Request("https://metagraph.sh/", { headers });
const varyFields = (response: Response) =>
  response.headers
    .get("vary")
    ?.toLowerCase()
    .split(",")
    .map((field) => field.trim());
const variantFields = ["signature", "signature-input", "signature-agent", "accept"];

describe("signed browser analytics compatibility (#12890)", () => {
  it.each(["Signature", "sIgNaTuRe", "Signature-Input", "Signature-Agent"])(
    "prevents edge beacon injection when %s is present",
    (name) => {
      const response = applySignedBrowserAnalyticsPolicy(html(), request({ [name]: "test" }));
      expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
      expect(varyFields(response)).toEqual(variantFields);
    },
  );

  it.each([
    ["Signature", ""],
    ["Signature-Agent", "   "],
  ])("prevents injection for an empty %s header that still requires CORS", (name, value) => {
    const response = applySignedBrowserAnalyticsPolicy(html(), request({ [name]: value }));
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(varyFields(response)).toEqual(variantFields);
  });

  it("keeps ordinary visitor analytics eligible and varies both HTML variants", () => {
    const response = applySignedBrowserAnalyticsPolicy(html(), request());
    expect(response.headers.has("cache-control")).toBe(false);
    expect(varyFields(response)).toEqual(variantFields);
  });

  it("preserves ordinary cache policy and existing Vary fields", () => {
    const response = applySignedBrowserAnalyticsPolicy(
      html({ "cache-control": "private, max-age=30", vary: "Accept-Encoding, SIGNATURE" }),
      request(),
    );
    expect(response.headers.get("cache-control")).toBe("private, max-age=30");
    expect(varyFields(response)).toEqual(["accept-encoding", ...variantFields]);
  });

  it("retains signed cache directives while preventing browser and CDN storage", () => {
    const response = applySignedBrowserAnalyticsPolicy(
      html({
        "cache-control": "public, max-age=60, NO-TRANSFORM, No-Store",
        "cdn-cache-control": "max-age=600",
        "cloudflare-cdn-cache-control": "max-age=900, NO-STORE",
        vary: "*",
      }),
      request({ Signature: "test" }),
    );
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=60, NO-TRANSFORM, No-Store",
    );
    expect(response.headers.get("cdn-cache-control")).toBe("max-age=600, no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("max-age=900, NO-STORE");
    expect(response.headers.get("vary")).toBe("*");
  });

  it("keeps response status, HTML and unrelated headers, including error pages", async () => {
    const original = new Response("<html>Unavailable</html>", {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "content-type": "Text/Html", "x-frame-options": "DENY" },
    });
    const response = applySignedBrowserAnalyticsPolicy(original, request({ Signature: "test" }));
    expect(response.status).toBe(500);
    expect(response.statusText).toBe("Internal Server Error");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(await response.text()).toBe("<html>Unavailable</html>");
  });

  it.each(["Signature", "Signature-Input", "Signature-Agent"])(
    "allows native Markdown conversion for %s without permitting storage",
    (name) => {
      const response = applySignedBrowserAnalyticsPolicy(
        html({ vary: "Accept-Encoding, ACCEPT" }),
        request({ [name]: "test", accept: "text/markdown, text/html;q=0.001" }),
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(varyFields(response)).toEqual([
        "accept-encoding",
        "accept",
        "signature",
        "signature-input",
        "signature-agent",
      ]);
    },
  );

  it.each([
    "text/html;q=bad, text/markdown;q=0.5",
    "text/html;q=0.1234, text/markdown;q=0.01",
    "text/html;q=1;q=0, text/markdown",
    'text/html;q="1", text/markdown;q=0.5',
  ])("retains signed HTML protection for ambiguous Accept %j", (accept) => {
    const response = applySignedBrowserAnalyticsPolicy(
      html(),
      request({ Signature: "test", accept }),
    );
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
  });

  it("preserves an origin no-transform directive for a Markdown request", () => {
    const response = applySignedBrowserAnalyticsPolicy(
      html({ "cache-control": "private, no-transform" }),
      request({ Signature: "test", accept: "text/markdown" }),
    );
    expect(response.headers.get("cache-control")).toBe("private, no-transform, no-store");
  });

  it("allows native Markdown HEAD headers without creating a response body", () => {
    const response = applySignedBrowserAnalyticsPolicy(
      new Response(null, { headers: { "content-type": "text/html" } }),
      new Request("https://metagraph.sh/", {
        method: "HEAD",
        headers: { Signature: "test", accept: "text/markdown" },
      }),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.body).toBeNull();
  });

  it.each(["application/json", "text/javascript", "text/plain", "text/markdown", ""])(
    "leaves non-HTML %j responses untouched",
    (contentType) => {
      const response = new Response("data", { headers: { "content-type": contentType } });
      const req = request({ Signature: "test", accept: "text/markdown" });
      expect(applySignedBrowserAnalyticsPolicy(response, req)).toBe(response);
      expect(response.headers.has("vary")).toBe(false);
    },
  );
});
