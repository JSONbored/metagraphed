import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { appendHtmlHead, MAX_HTML_HEAD_BYTES } from "./lib/html-head";
import server from "./server";

const ssr = vi.hoisted(() => ({ respond: () => new Response() }));
vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: () => ssr.respond() },
}));

let cloudflare: Miniflare;
beforeAll(() => {
  cloudflare = new Miniflare({
    modules: true,
    compatibilityDate: "2026-07-30",
    cf: false,
    script: `export default {
      async fetch(request) {
        const { html, additions } = await request.json();
        return new HTMLRewriter().on("head", {
          element(element) {
            for (const content of additions) element.append(content, { html: true });
          }
        }).transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
      }
    };`,
    outboundService() {
      throw new Error("Fixture attempted an origin request");
    },
  });
});
afterAll(async () => cloudflare.dispose());
afterEach(() => vi.unstubAllGlobals());

async function cloudflareHtml(html: string, additions: string[]): Promise<string> {
  const response = await cloudflare.dispatchFetch("https://fixture.invalid/", {
    method: "POST",
    body: JSON.stringify({ html, additions }),
  });
  return response.text();
}

function htmlResponse(body: BodyInit, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: { "content-type": "text/html; charset=utf-8", ...init.headers },
  });
}

const addition = '<meta name="fixture" content="appended">';
const documents = [
  '<!doctype html><html><head><title>Registry</title></head><body>Ready</body></html>',
  '<!doctype HTML><HTML><HEAD data-name="a > b"><TITLE>Registry</TITLE></HEAD><BODY>Ready</BODY></HTML>',
  '<html><head><!-- </head> --><script>const marker = "</head>";</script><style>body::before{content:"</head>"}</style></head><body>Ready</body></html>',
  '<html><head><title>é · 🧠 &amp; data</title></head><body>é &amp; 🧠</body></html>',
  '\ufeff<!doctype html><html><head></head><body>Ready</body></html>',
  '<html><head><meta name="existing" content="yes"><body>Implied head end</body></html>',
  '<html><head><meta name="existing" content="yes">',
  '<html><body>Head omitted</body></html>',
];

describe("native head transform", () => {
  it.each(documents)("matches the Cloudflare transform for %s", async (html) => {
    const response = await appendHtmlHead(htmlResponse(html), addition);
    expect(await response.text()).toBe(await cloudflareHtml(html, [addition]));
  });

  it("keeps UTF-8 and tag boundaries across one-byte chunks", async () => {
    const html = documents[3];
    const bytes = new TextEncoder().encode(html);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const response = await appendHtmlHead(htmlResponse(body), addition);
    expect(await response.text()).toBe(await cloudflareHtml(html, [addition]));
  });

  it("returns after the head closes and streams the original body bytes", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const head = new TextEncoder().encode('<html><head><title>Ready</title></head><body>');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        controller.enqueue(head);
      },
    });
    const response = await appendHtmlHead(htmlResponse(body), addition);
    const completed = response.arrayBuffer();
    const tail = Uint8Array.of(0xff, 0x00, 0x41);
    source.enqueue(tail);
    source.close();
    const actual = new Uint8Array(await completed);
    expect(actual.slice(-tail.length)).toEqual(tail);
    expect(new TextDecoder().decode(actual.slice(0, -tail.length))).toContain(addition);
  });

  it("propagates cancellation to the source", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<html><head></head><body>"));
      },
      cancel,
    });
    const response = await appendHtmlHead(htmlResponse(body), addition);
    await response.body!.cancel("client disconnected");
    expect(cancel).toHaveBeenCalledWith("client disconnected");
  });

  it("propagates a source failure after the head", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        controller.enqueue(new TextEncoder().encode("<html><head></head><body>"));
      },
    });
    const response = await appendHtmlHead(htmlResponse(body), addition);
    source.error(new Error("SSR stream failed"));
    await expect(response.text()).rejects.toThrow("SSR stream failed");
  });

  it("bounds an unfinished head and cancels its source on failure", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<html><head>" + " ".repeat(MAX_HTML_HEAD_BYTES)));
      },
      cancel,
    });
    await expect(appendHtmlHead(htmlResponse(body), addition)).rejects.toThrow("HTML head exceeds");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves bodyless responses", async () => {
    const response = new Response(null, { status: 204 });
    expect(await appendHtmlHead(response, addition)).toBe(response);
  });
});

describe("SSR entrypoint head parity", () => {
  function captureCloudflareAppends(): string[] {
    const additions: string[] = [];
    vi.stubGlobal("HTMLRewriter", class {
      private element!: (value: { append(content: string): void }) => void;
      on(_selector: string, handlers: { element: typeof this.element }) {
        this.element = handlers.element;
        return this;
      }
      transform(response: Response) {
        this.element({ append: (content) => additions.push(content) });
        return response;
      }
    });
    return additions;
  }

  it.each(["/", "/subnets?sort=health", "/subnets/64", "/docs/economics"])(
    "preserves the Cloudflare head and route-owned cards for %s",
    async (path) => {
      vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected origin request"); }));
      const routeCard = path === "/subnets/64" || path === "/docs/economics"
        ? '<meta property="og:image" content="https://fixture.invalid/entity.png">'
        : "";
      const html = `<html><head><title>SSR &amp; fixture</title>${routeCard}</head><body>Ready</body></html>`;
      ssr.respond = () => htmlResponse(html);
      const request = new Request(`https://metagraph.sh${path}`);
      const additions = captureCloudflareAppends();
      await server.fetch(request, {}, {});
      vi.stubGlobal("HTMLRewriter", undefined);
      const response = await server.fetch(request, {}, {});
      const actual = await response.text();
      expect(actual).toBe(await cloudflareHtml(html, additions));
      expect(actual.match(/<link rel="canonical"/g)).toHaveLength(1);
      expect(actual.match(/<meta property="og:image"/g)).toHaveLength(1);
      expect(actual).toContain('rel="preconnect"');
      expect(actual).toContain('type="application/ld+json"');
      expect(actual).toContain("web_vitals");
      expect(actual).not.toContain('href="https://metagraph.sh/subnets?');
      expect(response.headers.get("link")).toContain("api-catalog");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    },
  );

  it("escapes the request pathname in injected attributes", async () => {
    ssr.respond = () => htmlResponse(documents[0]);
    vi.stubGlobal("HTMLRewriter", undefined);
    const response = await server.fetch(new Request('https://metagraph.sh/subnets/a&b'), {}, {});
    expect(await response.text()).toContain('href="https://metagraph.sh/subnets/a&amp;b"');
  });

  it("preserves status and headers while removing the replaced content length", async () => {
    ssr.respond = () => htmlResponse(documents[0], {
      status: 404,
      statusText: "Missing entity",
      headers: { "content-length": String(documents[0].length), "x-fixture": "retained" },
    });
    vi.stubGlobal("HTMLRewriter", undefined);
    const response = await server.fetch(new Request("https://metagraph.sh/subnets/999"), {}, {});
    expect(response.status).toBe(404);
    expect(response.statusText).toBe("Missing entity");
    expect(response.headers.get("x-fixture")).toBe("retained");
    expect(response.headers.has("content-length")).toBe(false);
    expect(await response.text()).toContain('rel="canonical"');
  });

  it("passes non-HTML responses through without consuming them", async () => {
    const original = new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
    ssr.respond = () => original;
    const response = await server.fetch(new Request("https://metagraph.sh/"), {}, {});
    expect(response).toBe(original);
    expect(original.bodyUsed).toBe(false);
  });

  it("does not read the body for HEAD", async () => {
    const original = htmlResponse(documents[0], { headers: { "content-length": "123" } });
    ssr.respond = () => original;
    vi.stubGlobal("HTMLRewriter", undefined);
    const response = await server.fetch(new Request("https://metagraph.sh/", { method: "HEAD" }), {}, {});
    expect(original.bodyUsed).toBe(false);
    expect(response.headers.get("content-length")).toBe("123");
    await response.body!.cancel();
  });
});
