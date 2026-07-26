import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callSubnetSurface, isExecutable } from "./surface-call";

const panel = readFileSync(
  fileURLToPath(new URL("../../components/metagraphed/surface-playground.tsx", import.meta.url)),
  "utf8",
);

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const fn = vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("callSubnetSurface (#8258)", () => {
  it("sends only a surface_id — there is no way to pass an arbitrary URL", () => {
    const fetchMock = stubFetch({ result: { structuredContent: { status_code: 200 } } });
    void callSubnetSurface("sn-64-chutes-bounties-api");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    const sent = JSON.parse(init.body) as {
      params: { name: string; arguments: Record<string, unknown> };
    };
    expect(sent.params.name).toBe("call_subnet_surface");
    // Exactly one argument. Omitting `path`/`method` is what confines the call
    // to the surface's own curated url with its declared probe method; sending
    // them would open up other routes on the host.
    expect(Object.keys(sent.params.arguments)).toEqual(["surface_id"]);
    expect(sent.params.arguments.surface_id).toBe("sn-64-chutes-bounties-api");
  });

  it("never sends a credential", () => {
    const fetchMock = stubFetch({ result: { structuredContent: {} } });
    void callSubnetSurface("sn-1-example");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(init.body).not.toContain("credential");
  });

  it("surfaces a tool-level failure as an error, not a thrown exception", async () => {
    stubFetch({
      result: {
        isError: true,
        structuredContent: { error: { code: "auth_required", message: "Needs a credential." } },
      },
    });
    const out = await callSubnetSurface("sn-64-locked");
    expect(out).toEqual({
      ok: false,
      error: { code: "auth_required", message: "Needs a credential." },
    });
  });

  it("returns a network failure as an outcome rather than rejecting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const out = await callSubnetSurface("sn-1-example");
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error.code).toBe("network_error");
  });

  it("passes through status, latency and the truncation flag", async () => {
    stubFetch({
      result: {
        structuredContent: {
          surface_id: "s",
          url: "https://example.test/",
          status_code: 200,
          content_type: "application/json",
          latency_ms: 198,
          truncated: true,
          body: { ok: true },
        },
      },
    });
    const out = await callSubnetSurface("s");
    expect(out.ok).toBe(true);
    expect(out.ok === true && out.result.latency_ms).toBe(198);
    expect(out.ok === true && out.result.truncated).toBe(true);
  });
});

describe("isExecutable", () => {
  it("refuses auth-required and non-public-safe surfaces", () => {
    expect(isExecutable({ id: "a" })).toBe(true);
    expect(isExecutable({ id: "a", auth_required: true })).toBe(false);
    expect(isExecutable({ id: "a", public_safe: false })).toBe(false);
    // No id means nothing to address the call to.
    expect(isExecutable({})).toBe(false);
  });
});

describe("untrusted response rendering", () => {
  it("renders a response body as text, never as markup", () => {
    // Bodies come from third-party subnet APIs. A body containing
    // `<script>alert(1)</script>` must render as those literal characters.
    expect(panel).not.toContain("dangerouslySetInnerHTML");
    expect(panel).not.toContain("innerHTML");
    // The body reaches the DOM only through a JSX text child of <pre>.
    expect(panel).toContain("{renderBody(r.body)}");
    expect(panel).toContain("JSON.stringify(body, null, 2)");
  });

  it("caps what it renders even though the server already caps what it returns", () => {
    // Defence in depth: the server's cap protects the wire, this one protects
    // the main thread from a 20MB string laid out as one text node.
    expect(panel).toContain("MAX_RENDERED_CHARS");
  });

  it("never turns a response value into a link or an href", () => {
    const view = panel.slice(panel.indexOf("function ResponseView"));
    expect(view).not.toContain("href=");
  });
});
