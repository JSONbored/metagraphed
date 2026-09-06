import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cardGlyphs,
  cardTitleLines,
  renderCardLayout,
} from "../src/og-card-style.ts";
import { loadCardFonts } from "../src/og-card-fonts.ts";
import {
  cardFontFamily,
  cjkFontPlan,
  createCjkFontLoader,
  fontHasGlyph,
  normalizeCardDisplayText,
} from "../src/og-cjk-fonts.ts";

function sfnt(
  subtables: Array<{ bytes: Uint8Array; platform?: number; encoding?: number }>,
) {
  const cmapLength =
    4 +
    8 * subtables.length +
    subtables.reduce((n, { bytes }) => n + bytes.length, 0);
  const data = new ArrayBuffer(28 + cmapLength);
  const view = new DataView(data);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, 1);
  view.setUint32(12, 0x636d6170);
  view.setUint32(20, 28);
  view.setUint32(24, cmapLength);
  view.setUint16(30, subtables.length);
  let offset = 4 + 8 * subtables.length;
  subtables.forEach(({ bytes, platform = 3, encoding = 10 }, index) => {
    view.setUint16(32 + index * 8, platform);
    view.setUint16(34 + index * 8, encoding);
    view.setUint32(36 + index * 8, offset);
    new Uint8Array(data).set(bytes, 28 + offset);
    offset += bytes.length;
  });
  return data;
}

function format12(text: string, firstGlyph = 1) {
  const codes = [...new Set([...text])]
    .map((char) => char.codePointAt(0)!)
    .sort((a, b) => a - b);
  const bytes = new Uint8Array(16 + codes.length * 12);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 12);
  view.setUint32(4, bytes.length);
  view.setUint32(12, codes.length);
  codes.forEach((code, index) => {
    view.setUint32(16 + index * 12, code);
    view.setUint32(20 + index * 12, code);
    view.setUint32(24 + index * 12, firstGlyph + index);
  });
  return bytes;
}

function font(text: string) {
  return sfnt([{ bytes: format12(text) }]);
}
function format4(range = false, glyph = 3) {
  const bytes = new Uint8Array(range ? 26 : 24);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 4);
  view.setUint16(2, bytes.length);
  view.setUint16(6, 2);
  view.setUint16(14, 0x6f22);
  view.setUint16(18, 0x6f22);
  view.setInt16(20, range ? 1 : -0x6f21);
  if (range) {
    view.setUint16(22, 2);
    view.setUint16(24, glyph);
  }
  return bytes;
}

function fetcher(
  options: {
    transform?: (text: string, family: string) => ArrayBuffer;
    fail?: string;
  } = {},
) {
  const requests: URL[] = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(url);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.redirect).toBe("manual");
      if (url.hostname === "fonts.googleapis.com") {
        expect(new Headers(init?.headers).get("user-agent")).toContain(
          "Safari/533.21.1",
        );
        const family = url.searchParams.get("family")!.split(":")[0];
        const text = url.searchParams.get("text")!;
        const binary = `https://fonts.gstatic.com/font?text=${encodeURIComponent(text)}&family=${encodeURIComponent(family)}`;
        return options.fail === "css"
          ? new Response("bad", { status: 503 })
          : new Response(`src: url(${binary}) format('truetype')`);
      }
      const text = url.searchParams.get("text")!;
      return new Response(
        options.transform?.(text, url.searchParams.get("family")!) ??
          font(text),
      );
    },
  );
  return { requests, fetchImpl: fetchImpl as typeof fetch };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("conditional OG script policy", () => {
  it("budgets full-width title glyphs so two requested lines stay two lines", () => {
    const lines = cardTitleLines("漢字かなカナ한글𠮷龘".repeat(10), 750, 48, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith("…")).toBe(true);
    for (const line of lines)
      expect(Array.from(line).length).toBeLessThanOrEqual(14);
  });
  it("loads required faces through the API/native publisher's shared entrypoint", async () => {
    const f = fetcher();
    vi.stubGlobal("fetch", f.fetchImpl);
    const fonts = await loadCardFonts(
      renderCardLayout({
        title: "漢字",
        identifier: "",
        subtitle: "かな",
        mark: "한",
        stats: [],
      }),
    );
    expect(fonts.map(({ name }) => name).slice(-3)).toEqual([
      "Noto Sans JP",
      "Noto Sans SC",
      "Noto Sans KR",
    ]);
    expect(f.requests).toHaveLength(16);
  });
  it("applies one normalized policy to all explicit API text roles", () => {
    const markup = renderCardLayout({
      title: "漢字",
      identifier: "かな",
      subtitle: "カナー",
      mark: "한",
      stats: [{ label: "글", value: "龘𠮷" }],
    });
    expect(cardGlyphs(markup)).toContain("한");
    expect(cardGlyphs(markup)).not.toContain("ᄒ");
    for (const [, family] of markup.matchAll(/font-family:([^;]+);/g)) {
      expect(family).toContain("'Noto Sans JP','Noto Sans SC','Noto Sans KR'");
    }
  });
  it("adds no family or stack change for Latin, ordinary punctuation, Greek, Arabic or emoji", () => {
    for (const text of [
      "",
      "ASCII 128 · 87% & τ + — … → € °",
      "العربية",
      "😀👩🏽‍💻🇯🇵",
      "。ー！",
    ]) {
      expect(cjkFontPlan(text)).toEqual([]);
      expect(cardFontFamily("'Geist','Inter'", cjkFontPlan(text))).toBe(
        "'Geist','Inter'",
      );
    }
  });
  it("selects complementary Han faces, kana-first forms and Hangul separately", () => {
    expect(cjkFontPlan("字𠮷龘").map((f) => f.name)).toEqual([
      "Noto Sans SC",
      "Noto Sans JP",
    ]);
    expect(cjkFontPlan("かなカナー").map((f) => f.name)).toEqual([
      "Noto Sans JP",
    ]);
    expect(cjkFontPlan("字かな한글").map((f) => f.name)).toEqual([
      "Noto Sans JP",
      "Noto Sans SC",
      "Noto Sans KR",
    ]);
    expect(cjkFontPlan("한글").map((f) => f.name)).toEqual(["Noto Sans KR"]);
    expect(cardFontFamily("'Geist Mono'", cjkFontPlan("かな"))).toBe(
      "'Geist Mono','Noto Sans JP'",
    );
  });
  it("normalizes display Jamo, deduplicates/sorts subsets and caps unique glyphs", () => {
    expect(normalizeCardDisplayText("한글")).toBe("한글");
    expect(cjkFontPlan("한글")).toEqual(cjkFontPlan("한글"));
    expect(cjkFontPlan("字漢字。！")[0].text).toBe("。字漢！");
    expect(cjkFontPlan("漢字")).toEqual(cjkFontPlan("字漢字"));
    expect(() =>
      cjkFontPlan(
        Array.from({ length: 513 }, (_, i) =>
          String.fromCodePoint(0x4e00 + i),
        ).join(""),
      ),
    ).toThrow(/bound/);
  });
});

describe("actual cmap coverage", () => {
  it("recognizes Unicode BMP and supplementary glyphs, without treating .notdef as coverage", () => {
    expect(fontHasGlyph(font("漢𠮷"), "漢")).toBe(true);
    expect(fontHasGlyph(font("漢𠮷"), "𠮷")).toBe(true);
    expect(fontHasGlyph(font("漢"), "龘")).toBe(false);
    expect(fontHasGlyph(sfnt([{ bytes: format12("漢", 0) }]), "漢")).toBe(
      false,
    );
    for (const range of [false, true]) {
      const data = sfnt([{ bytes: format4(range), encoding: 1 }]);
      expect(fontHasGlyph(data, "漢")).toBe(true);
      expect(fontHasGlyph(data, "字")).toBe(false);
      expect(fontHasGlyph(data, "𠮷")).toBe(false);
    }
    expect(
      fontHasGlyph(sfnt([{ bytes: format4(true, 0), platform: 0 }]), "漢"),
    ).toBe(false);
    expect(
      fontHasGlyph(sfnt([{ bytes: format12("漢"), platform: 1 }]), "漢"),
    ).toBe(false);
    const unsupported = new Uint8Array(2);
    new DataView(unsupported.buffer).setUint16(0, 6);
    expect(fontHasGlyph(sfnt([{ bytes: unsupported }]), "漢")).toBe(false);
    const otf = font("漢");
    new DataView(otf).setUint32(0, 0x4f54544f);
    expect(fontHasGlyph(otf, "漢")).toBe(true);
  });
  it("rejects malformed headers, directories, records and subtable bounds", () => {
    expect(() => fontHasGlyph(new ArrayBuffer(0), "漢")).toThrow(/header/);
    const mutations: Array<(v: DataView) => void> = [
      (v) => v.setUint32(0, 0x774f4632),
      (v) => v.setUint16(4, 129),
      (v) => v.setUint32(12, 0),
      (v) => v.setUint32(20, 9999),
      (v) => v.setUint32(24, 2),
      (v) => v.setUint16(30, 129),
      (v) => v.setUint16(30, 10),
      (v) => v.setUint32(36, 9999),
      (v) => v.setUint32(44, 9999),
      (v) => v.setUint32(52, 9999),
    ];
    for (const mutate of mutations) {
      const data = font("漢");
      mutate(new DataView(data));
      expect(() => fontHasGlyph(data, "漢")).toThrow();
    }
    const short12 = sfnt([{ bytes: new Uint8Array([0, 12]) }]);
    const short4 = sfnt([{ bytes: new Uint8Array([0, 4]) }]);
    expect(() => fontHasGlyph(short12, "漢")).toThrow(/format 12/);
    expect(() => fontHasGlyph(short4, "漢")).toThrow(/format 4/);
    for (const mutate of [
      (v: DataView) => v.setUint16(6, 3),
      (v: DataView) => v.setUint16(2, 2),
      (v: DataView) => v.setUint16(22, 500),
    ]) {
      const bytes = format4(true);
      mutate(new DataView(bytes.buffer));
      expect(() => fontHasGlyph(sfnt([{ bytes }]), "漢")).toThrow();
    }
  });
});

describe("bounded conditional font loading", () => {
  it("does no Latin fetch, deduplicates concurrent subsets and can reset its memo", async () => {
    const loader = createCjkFontLoader();
    const f = fetcher();
    expect(await loader.load("Latin · τ", f.fetchImpl)).toEqual([]);
    expect(f.requests).toHaveLength(0);
    const [a, b] = await Promise.all([
      loader.load("漢字", f.fetchImpl),
      loader.load("字漢", f.fetchImpl),
    ]);
    expect(a.map(({ name }) => name)).toEqual(["Noto Sans SC", "Noto Sans JP"]);
    expect(b).toEqual(a);
    expect(f.requests).toHaveLength(4);
    await loader.load("漢字", f.fetchImpl);
    expect(f.requests).toHaveLength(4);
    loader.clear();
    await loader.load("漢字", f.fetchImpl);
    expect(f.requests).toHaveLength(8);
  });
  it("accepts complementary regional coverage and rejects missing glyphs without poisoning retries", async () => {
    const loader = createCjkFontLoader();
    const f = fetcher({
      transform: (text, name) =>
        font(text.replace(name.endsWith("SC") ? "𠮷" : "龘", "")),
    });
    expect(await loader.load("𠮷龘", f.fetchImpl)).toHaveLength(2);
    const missing = fetcher({ transform: () => font("字") });
    await expect(loader.load("漢", missing.fetchImpl)).rejects.toThrow(
      /glyph unavailable/,
    );
    const good = fetcher();
    await expect(loader.load("漢", good.fetchImpl)).resolves.toHaveLength(2);
    expect(good.requests).toHaveLength(4);
  });
  it("accepts a complementary face after a wholly unsupported regional subset fails", async () => {
    const loader = createCjkFontLoader();
    const good = fetcher();
    const partial = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.searchParams.get("family")?.startsWith("Noto Sans SC"))
        return new Response("No supported characters", { status: 400 });
      return good.fetchImpl(input, init);
    }) as typeof fetch;
    const fonts = await loader.load("𠮷", partial);
    expect(fonts.map(({ name }) => name)).toEqual(["Noto Sans JP"]);
    expect(fontHasGlyph(fonts[0].data, "𠮷")).toBe(true);
    const missing = fetcher({ transform: () => font("字") });
    const incomplete = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = new URL(String(input));
      return url.searchParams.get("family")?.startsWith("Noto Sans SC")
        ? new Response(null, { status: 503 })
        : missing.fetchImpl(input, init);
    }) as typeof fetch;
    await expect(loader.load("龘", incomplete)).rejects.toThrow(
      /glyph unavailable/,
    );
    await expect(loader.load("龘", good.fetchImpl)).resolves.toHaveLength(2);
  });
  it("evicts a malformed later cmap lookup and preserves a newer replacement", async () => {
    const loader = createCjkFontLoader();
    const malformed = fetcher({
      transform: () =>
        sfnt([{ bytes: format12("字") }, { bytes: new Uint8Array([0, 12]) }]),
    });
    await expect(loader.load("字漢", malformed.fetchImpl)).rejects.toThrow(
      /format 12/,
    );
    const good = fetcher();
    await expect(loader.load("字漢", good.fetchImpl)).resolves.toHaveLength(2);
    expect(good.requests).toHaveLength(4);

    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const old = fetcher({ transform: () => font("글") });
    const pending = loader.load("한", (async (input, init) => {
      await waiting;
      return old.fetchImpl(input, init);
    }) as typeof fetch);
    loader.clear();
    await loader.load("한", good.fetchImpl);
    const count = good.requests.length;
    release();
    await expect(pending).rejects.toThrow(/glyph unavailable/);
    await loader.load("한", good.fetchImpl);
    expect(good.requests).toHaveLength(count);
  });
  it("retries failed requests and rejects a valid HTTP response with invalid font bytes", async () => {
    const loader = createCjkFontLoader();
    await expect(
      loader.load("한글", fetcher({ fail: "css" }).fetchImpl),
    ).rejects.toThrow(/503/);
    await expect(
      loader.load(
        "한글",
        fetcher({ transform: () => new ArrayBuffer(12) }).fetchImpl,
      ),
    ).rejects.toThrow(/TrueType/);
    await expect(
      loader.load("한글", fetcher().fetchImpl),
    ).resolves.toHaveLength(1);
  });
  it("rejects missing/unsafe sources, binary failures and oversized or absent response bodies", async () => {
    for (const response of [
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://example.com/font" },
        }),
      () =>
        new Response("src: url(https://fonts.gstatic.com/f) format('woff2')"),
      () =>
        new Response("src: url(http://fonts.gstatic.com/f) format('truetype')"),
      () => new Response("src: url(https://example.com/f) format('truetype')"),
      () =>
        new Response(
          "src: url(https://user@fonts.gstatic.com/f) format('truetype')",
        ),
      () =>
        new Response(
          "src: url(https://fonts.gstatic.com:444/f) format('truetype')",
        ),
      () => new Response(null),
      () => new Response("bad", { headers: { "content-length": "65537" } }),
      () => new Response("x".repeat(65537)),
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("body failed"));
            },
          }),
        ),
    ]) {
      await expect(
        createCjkFontLoader().load("かな", (async () =>
          response()) as typeof fetch),
      ).rejects.toThrow();
    }
    for (const response of [
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://example.com/font" },
        }),
      () => new Response("no", { status: 502 }),
      () => new Response(new Uint8Array(1_048_577)),
    ]) {
      const f = (async (input: RequestInfo | URL) =>
        String(input).includes("googleapis")
          ? new Response(
              "src: url(https://fonts.gstatic.com/f) format('truetype')",
            )
          : response()) as typeof fetch;
      await expect(createCjkFontLoader().load("かな", f)).rejects.toThrow();
    }
  });
  it("honors request deadlines and retries after a reset during an in-flight request", async () => {
    const loader = createCjkFontLoader();
    const timedOut = AbortSignal.abort(new Error("deadline"));
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((milliseconds) => {
        expect(milliseconds).toBe(5000);
        return timedOut;
      });
    await expect(
      loader.load("한", (async (_input, init) => {
        init!.signal!.throwIfAborted();
        return new Response();
      }) as typeof fetch),
    ).rejects.toThrow(/deadline/);
    timeout.mockRestore();
    const missing = fetcher({
      transform: () => {
        loader.clear();
        return font("字");
      },
    });
    await expect(loader.load("한", missing.fetchImpl)).rejects.toThrow(
      /glyph unavailable/,
    );
    await expect(loader.load("한", fetcher().fetchImpl)).resolves.toHaveLength(
      1,
    );
  });
  it("evicts by byte budget while retaining bounded pending requests", async () => {
    const loader = createCjkFontLoader();
    const large = fetcher({
      transform: (text) => {
        const bytes = new Uint8Array(1_048_576);
        bytes.set(new Uint8Array(font(text)));
        return bytes.buffer;
      },
    });
    for (let i = 0; i < 5; i++)
      await loader.load(String.fromCharCode(0xac00 + i), large.fetchImpl);
    await loader.load(String.fromCharCode(0xac00), large.fetchImpl);
    expect(large.requests).toHaveLength(12);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fetcher();
    const pending = loader.load("한", (async (input, init) => {
      await waiting;
      return f.fetchImpl(input, init);
    }) as typeof fetch);
    for (let i = 10; i < 36; i++)
      await loader.load(String.fromCharCode(0xac00 + i), f.fetchImpl);
    release();
    await expect(pending).resolves.toHaveLength(1);
  });
  it("bounds parallel loads and evicts old subsets instead of growing indefinitely", async () => {
    const loader = createCjkFontLoader();
    const f = fetcher();
    for (let i = 0; i < 25; i++)
      await loader.load(String.fromCharCode(0xac00 + i), f.fetchImpl);
    expect(f.requests).toHaveLength(50);
    await loader.load(String.fromCharCode(0xac18), f.fetchImpl);
    expect(f.requests).toHaveLength(50);
    await loader.load(String.fromCharCode(0xac00), f.fetchImpl);
    expect(f.requests).toHaveLength(52);
    const stalled = createCjkFontLoader();
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const blocked = (async () => {
      await waiting;
      return new Response("bad", { status: 503 });
    }) as typeof fetch;
    const loads = Array.from({ length: 12 }, (_, i) =>
      stalled.load(String.fromCharCode(0xac00 + i), blocked).catch(() => {}),
    );
    await expect(stalled.load("글", blocked)).rejects.toThrow(/capacity/);
    stalled.clear();
    finish();
    await Promise.all(loads);
    await expect(stalled.load("글", f.fetchImpl)).resolves.toHaveLength(1);
  });
});
