import { describe, expect, it } from "vitest";
import { createNativeUiAssets, nativeOgElement } from "./native-ui";

describe("native UI cached logos", () => {
  it("dispatches only a canonical local asset request without caller headers or origin", async () => {
    const calls: Request[] = [];
    const assets = createNativeUiAssets(async (request) => {
      calls.push(request);
      return new Response("logo", { headers: { "content-type": "image/png" } });
    });
    const response = await assets.fetch(
      new Request("https://example.com/logos/display/logo.webp?token=hidden", {
        headers: { authorization: "Bearer fixture", cookie: "fixture=value" },
      }),
    );
    expect(await response.text()).toBe("logo");
    expect(calls[0].url).toBe("http://native-ui.invalid/logos/display/logo.webp");
    expect([...calls[0].headers]).toEqual([]);
    expect(Object.isFrozen(assets)).toBe(true);
  });

  it("preserves HEAD and request cancellation", async () => {
    const abort = new AbortController();
    abort.abort(new Error("stopped"));
    const assets = createNativeUiAssets(async (request) => {
      expect(request.method).toBe("HEAD");
      expect(request.signal.aborted).toBe(true);
      return new Response(null);
    });
    expect(
      (
        await assets.fetch(
          new Request("https://example.com/logos/logo.png", {
            method: "HEAD",
            signal: abort.signal,
          }),
        )
      ).status,
    ).toBe(200);
  });

  it("rejects non-assets, encoded paths, oversized paths and write methods before dispatch", async () => {
    let calls = 0;
    const assets = createNativeUiAssets(async () => {
      calls++;
      return new Response();
    });
    for (const path of [
      "/api/v1/accounts",
      "/logos/../secret",
      "/logos/%252e%252e/key",
      `/logos/${"x".repeat(2050)}`,
    ]) {
      expect((await assets.fetch(new Request(`https://example.com${path}`))).status).toBe(404);
    }
    expect(
      (
        await assets.fetch(
          new Request("https://example.com/logos/logo.png", { method: "POST", body: "no" }),
        )
      ).status,
    ).toBe(405);
    expect(calls).toBe(0);
  });
});

describe("native OG input", () => {
  const json = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value, (key, entry) =>
        key.startsWith("_") || key === "key" ? undefined : entry,
      ),
    );
  it("preserves the source wrapper, CSS values, image attributes and literal text entities", () => {
    const tree = json(
      nativeOgElement(
        '<div style="font-size: 20px; font-family: \'Geist\', sans-serif; color: rgb(1, 2, 3)">A &amp; B<img src="data:image/png;base64,AA==" width="2" height="3"></div>',
      ),
    );
    expect(tree.props).toEqual({
      style: { display: "flex", flexDirection: "column" },
      children: [
        {
          type: "div",
          props: {
            style: { fontSize: "20px", fontFamily: "'Geist', sans-serif", color: "rgb(1, 2, 3)" },
            children: [
              "A &amp; B",
              {
                type: "img",
                props: { children: [], src: "data:image/png;base64,AA==", width: "2", height: "3" },
              },
            ],
          },
        },
      ],
    });
  });
  it("ignores comments and unrelated attributes and rejects unbounded input", () => {
    const value = json(
      nativeOgElement(
        '<!-- ignored --><div id="unused" style=" ; color:"><img src="x" width="2"></div>',
      ),
    );
    expect(value.props.children[0].props).toEqual({
      children: [{ type: "img", props: { children: [], src: "x" } }],
    });
    expect(() => nativeOgElement("x".repeat(2 * 1024 * 1024 + 1))).toThrow("too large");
    expect(() => nativeOgElement("<div>".repeat(66) + "x" + "</div>".repeat(66))).toThrow("budget");
    expect(() => nativeOgElement("<br>".repeat(16385))).toThrow("budget");
    expect(json(nativeOgElement("&copy; &#65; &amp;")).props.children).toEqual([
      "&copy; &#65; &amp;",
    ]);
  });
});
