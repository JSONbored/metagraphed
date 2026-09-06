import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, test, vi } from "vitest";
import {
  CARD_LIMITS,
  CARD_VERSION,
  OG_THEME,
  cardGlyphs,
  cardLabel,
  renderCardLayout,
} from "../src/og-card-style.ts";
import { loadCardFonts } from "../src/og-card-fonts.ts";
import { homepageResponse } from "../workers/request-handlers/discovery.ts";

afterEach(() => vi.unstubAllGlobals());

describe("API preview composition", () => {
  test("uses the canonical dark tokens without a UI runtime dependency", () => {
    const css = readFileSync(
      new URL("../packages/ui-kit/src/styles.css", import.meta.url),
      "utf8",
    )
      .split(".dark {")[1]
      .split("}")[0];
    const names = {
      canvas: "canvas",
      layer: "layer",
      raised: "raised",
      ink: "ink-strong",
      muted: "ink-muted",
      rule: "rule",
      brand: "brand",
      accent: "accent",
    };
    for (const [key, token] of Object.entries(names))
      assert.ok(
        css.includes(`--${token}: ${OG_THEME[key as keyof typeof OG_THEME]};`),
        token,
      );
  });

  test("bounds text nodes without splitting code points or injecting markup", () => {
    assert.equal(
      cardLabel(' <script>alpha</script> & "beta" \n', 100),
      'scriptalpha/script & "beta"',
    );
    assert.equal(
      cardLabel("x".repeat(111), CARD_LIMITS.title),
      "x".repeat(109) + "…",
    );
    assert.equal(cardLabel("🙂🙂🙂", 2), "🙂…");
    assert.equal(cardLabel("short", 10), "short");
  });

  test("sizes short, medium, long titles and bounded stat values", () => {
    for (const [length, size] of [
      [24, 68],
      [48, 54],
      [110, 42],
    ]) {
      const markup = renderCardLayout({
        title: "X".repeat(length),
        eyebrow: "Public",
        stats: [
          { label: "short", value: "1" },
          { label: "medium", value: "1".repeat(12) },
          { label: "long", value: "1".repeat(29) },
        ],
      });
      assert.ok(markup.includes(`font-size:${size}px`));
      assert.ok(markup.includes("1".repeat(27) + "…"));
      assert.ok(!markup.includes("1".repeat(29)));
      assert.ok(
        !/>\s+</.test(markup),
        "Worker parser must not create whitespace flex children",
      );
    }
  });

  test("preserves absent facts, caps the landing rail and uses only inlined PNG logos", () => {
    const bare = renderCardLayout({
      title: "Public",
      eyebrow: "Registry",
      stats: [],
    });
    assert.ok(!bare.includes("0/100"));
    assert.ok(!bare.includes("background:#ffffff"));
    const logo = "data:image/png;base64,AQID";
    const full = renderCardLayout({
      title: "Public",
      eyebrow: "Registry",
      subtitle: "Public data",
      stats: [1, 2, 3, 4, 5].map((n) => ({
        label: `field${n}`,
        value: String(n),
      })),
      logo,
      mark: "19",
    });
    assert.ok(full.includes(`src="${logo}"`));
    assert.ok(full.includes("FIELD4"));
    assert.ok(!full.includes("FIELD5"));
    for (const unsafe of [
      "https://example.com/logo.png",
      "data:image/svg+xml;base64,PHN2Zz4=",
      'data:image/png;base64,AQID" onload="x',
    ]) {
      const markup = renderCardLayout({
        title: "Public",
        eyebrow: "Registry",
        stats: [],
        logo: unsafe,
        mark: "65535",
      });
      assert.ok(!markup.includes(unsafe));
      assert.ok(markup.includes(">65535</div>"));
    }
    assert.ok(
      renderCardLayout({
        title: "Public",
        eyebrow: "Registry",
        stats: [],
        logo: "invalid",
      }).includes("width:1072px"),
    );
  });

  test("derives normalized visible font text including brand, domain and ellipsis", () => {
    const text = cardGlyphs(
      renderCardLayout({
        title: "Long ".repeat(40),
        eyebrow: "Subnet",
        stats: [{ label: "Coverage", value: "87% & τ" }],
        mark: "19",
      }),
    );
    for (const expected of [
      "Metagraphed",
      "api.metagraph.sh",
      "…",
      "COVERAGE",
      "87% & τ",
      "19",
    ])
      assert.ok(text.includes(expected));
    assert.ok(!text.includes("data:image"));
    assert.ok(!text.includes("font-size"));
  });

  test("discovery emits the same versioned absolute URL for both platforms", async () => {
    const response = await homepageResponse(
      new Request("https://api.metagraph.sh/"),
    );
    const html = await response.text();
    assert.ok(
      html.includes(
        `property="og:image" content="https://api.metagraph.sh/og.png?v=${CARD_VERSION}"`,
      ),
    );
    assert.ok(
      html.includes(
        `name="twitter:image" content="https://api.metagraph.sh/og.png?v=${CARD_VERSION}"`,
      ),
    );
  });
});

describe("API preview font requests", () => {
  test("encodes the painted text and loads the same faces for both renderers", async () => {
    const asked: URL[] = [];
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      const url = new URL(input);
      asked.push(url);
      assert.ok(init.signal instanceof AbortSignal);
      return url.hostname === "fonts.googleapis.com"
        ? new Response(
            "@font-face { src: url(https://fonts.gstatic.com/test.woff) format('woff'); }",
          )
        : new Response(new Uint8Array([1, 2, 3]));
    });
    const fonts = await loadCardFonts("<div>87% & + τ…</div>");
    assert.deepEqual(
      fonts.map(({ name, weight }) => [name, weight]),
      [
        ["Geist", 500],
        ["Geist", 700],
        ["Geist Mono", 500],
        ["Inter", 500],
        ["Inter", 700],
      ],
    );
    for (const url of asked.filter(
      (u) => u.hostname === "fonts.googleapis.com",
    )) {
      assert.equal(url.searchParams.get("text"), "87% &+τ…");
      assert.equal([...url.searchParams.keys()].length, 2);
    }
    assert.deepEqual(new Uint8Array(fonts[0].data), new Uint8Array([1, 2, 3]));
  });

  test("fails a render on unavailable CSS, missing face, font error or network failure", async () => {
    for (const mode of ["css", "source", "font", "network"]) {
      vi.stubGlobal("fetch", async (input: string) => {
        if (mode === "network") throw new Error("offline");
        if (mode === "css") return new Response("unavailable", { status: 503 });
        if (mode === "source") return new Response("no face");
        return new URL(input).hostname === "fonts.googleapis.com"
          ? new Response("src: url(https://fonts.gstatic.com/test.woff)")
          : new Response("unavailable", { status: 502 });
      });
      await assert.rejects(loadCardFonts("<div>test</div>"));
    }
  });
});
