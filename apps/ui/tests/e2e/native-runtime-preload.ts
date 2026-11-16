import { readFileSync } from "node:fs";

// Only the child of native-runtime.check uses this preload. Every external
// request is either a declared fixture or fails before any network connection.
const realFetch = globalThis.fetch;
const font = readFileSync(
  new URL("../../../../tests/fixtures/og-logo/Abel-Regular.ttf", import.meta.url),
);
const rejectedFonts = new Set<string>();
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "127.0.0.1") return realFetch(input, init);
  if (url.hostname === "api.metagraph.sh" && url.pathname === "/llms.txt") {
    return new Response("Native UI fixture discovery\n", {
      headers: { "content-type": "text/plain" },
    });
  }
  if (url.hostname === "fonts.googleapis.com") {
    if (!rejectedFonts.has(url.href)) {
      rejectedFonts.add(url.href);
      return new Response("fixture font outage", { status: 503 });
    }
    return new Response(
      "src: url(https://fonts.gstatic.com/native-fixture.ttf) format('truetype')",
      {
        headers: { "content-type": "text/css" },
      },
    );
  }
  if (url.hostname === "fonts.gstatic.com" && url.pathname === "/native-fixture.ttf") {
    return new Response(Uint8Array.from(font), { headers: { "content-type": "font/ttf" } });
  }
  console.error("Unexpected native fixture fetch", url.origin, url.pathname);
  throw new Error("Native UI fixture has no external network access");
};
