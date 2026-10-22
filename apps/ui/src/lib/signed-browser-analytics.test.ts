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
const signatureFields = ["signature", "signature-input", "signature-agent"];

describe("signed browser analytics compatibility (#12890)", () => {
  it.each(["Signature", "sIgNaTuRe", "Signature-Input", "Signature-Agent"])(
    "prevents edge beacon injection when %s is present",
    (name) => {
      const response = applySignedBrowserAnalyticsPolicy(html(), request({ [name]: "test" }));
      expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
      expect(varyFields(response)).toEqual(signatureFields);
    },
  );

  it.each([
    ["Signature", ""],
    ["Signature-Agent", "   "],
  ])("prevents injection for an empty %s header that still requires CORS", (name, value) => {
    const response = applySignedBrowserAnalyticsPolicy(html(), request({ [name]: value }));
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(varyFields(response)).toEqual(signatureFields);
  });

  it("keeps ordinary visitor analytics eligible and varies both HTML variants", () => {
    const response = applySignedBrowserAnalyticsPolicy(html(), request());
    expect(response.headers.has("cache-control")).toBe(false);
    expect(varyFields(response)).toEqual(signatureFields);
  });

  it("preserves ordinary cache policy and existing Vary fields", () => {
    const response = applySignedBrowserAnalyticsPolicy(
      html({ "cache-control": "private, max-age=30", vary: "Accept-Encoding, SIGNATURE" }),
      request(),
    );
    expect(response.headers.get("cache-control")).toBe("private, max-age=30");
    expect(varyFields(response)).toEqual(["accept-encoding", ...signatureFields]);
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
    expect(response.headers.get("cache-control")).toBe("public, max-age=60, NO-TRANSFORM, No-Store");
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

  it.each(["application/json", "text/javascript", "text/plain", ""])(
    "leaves non-HTML %j responses untouched",
    (contentType) => {
      const response = new Response("data", { headers: { "content-type": contentType } });
      expect(applySignedBrowserAnalyticsPolicy(response, request({ Signature: "test" }))).toBe(
        response,
      );
      expect(response.headers.has("vary")).toBe(false);
    },
  );
});
