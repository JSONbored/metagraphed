// Shared by the API/native and UI OG renderers. No rendering dependency belongs
// here: ordinary pages must not load Satori or a font parser to build metadata.
const HAN = /\p{Script=Han}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;
const CJK_GLYPH =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u;
const HANGUL_GLYPH = /\p{Script_Extensions=Hangul}/u;
const PUNCTUATION = /[\u3000-\u303f\uff00-\uffef]/u;
const FONT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) " +
  "AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1";
const MAX_FONT_BYTES = 1_048_576;
const MAX_CACHE_BYTES = 4 * MAX_FONT_BYTES;
const MAX_CACHE_ENTRIES = 24;
const MAX_PENDING = 12;

type CjkFamily = "Noto Sans SC" | "Noto Sans JP" | "Noto Sans KR";
export interface CjkFontRequest {
  name: CjkFamily;
  weight: 500;
  text: string;
}
export interface CjkFont {
  name: CjkFamily;
  weight: 500;
  style: "normal";
  data: ArrayBuffer;
}

/** Display normalization only; callers retain the original entity/route key. */
export function normalizeCardDisplayText(text: string): string {
  return text.normalize("NFC");
}

/** Select scripts, not shared punctuation: an ordinary middle dot costs nothing. */
export function cjkFontPlan(text: string): CjkFontRequest[] {
  const normalized = normalizeCardDisplayText(text);
  const han = HAN.test(normalized);
  const kana = KANA.test(normalized);
  const families: CjkFamily[] = han
    ? kana
      ? ["Noto Sans JP", "Noto Sans SC"]
      : ["Noto Sans SC", "Noto Sans JP"]
    : kana
      ? ["Noto Sans JP"]
      : [];
  if (HANGUL.test(normalized)) families.push("Noto Sans KR");
  return families.map((name) => {
    const script = name === "Noto Sans KR" ? HANGUL_GLYPH : CJK_GLYPH;
    const characters = [...new Set([...normalized])]
      .filter((char) => script.test(char) || PUNCTUATION.test(char))
      .sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!);
    if (characters.length > 512)
      throw new Error("OG script subset exceeds its bound");
    return { name, weight: 500, text: characters.join("") };
  });
}

/** Preserve the exact Latin stack when no script face is necessary. */
export function cardFontFamily(base: string, plan: CjkFontRequest[]): string {
  return base + plan.map(({ name }) => `,'${name}'`).join("");
}

// Inspect only Unicode cmap entries in a bounded sfnt. This tiny reader avoids
// eagerly importing Satori's full OpenType parser into the Worker module graph.
// A 200 TTF response is insufficient: Google can return a valid subset that
// omits a requested rare character (SC lacks 𠮷; JP lacks 龘).
export function fontHasGlyph(data: ArrayBuffer, character: string): boolean {
  const view = new DataView(data);
  const within = (offset: number, size: number) =>
    offset >= 0 && offset + size <= view.byteLength;
  if (!within(0, 12)) throw new Error("Invalid OG font header");
  const signature = view.getUint32(0);
  if (signature !== 0x00010000 && signature !== 0x4f54544f)
    throw new Error("OG font is not TrueType/OpenType");
  const tables = view.getUint16(4);
  if (tables > 128 || !within(12, tables * 16))
    throw new Error("Invalid OG font table directory");
  let cmap = -1;
  let cmapLength = 0;
  for (let index = 0; index < tables; index++) {
    const record = 12 + index * 16;
    if (view.getUint32(record) !== 0x636d6170) continue;
    cmap = view.getUint32(record + 8);
    cmapLength = view.getUint32(record + 12);
  }
  if (cmap < 0 || cmapLength < 4 || !within(cmap, cmapLength))
    throw new Error("Invalid OG font cmap");
  const cmapWithin = (offset: number, size: number) =>
    offset >= cmap && offset + size <= cmap + cmapLength;
  const records = view.getUint16(cmap + 2);
  if (records > 128 || !cmapWithin(cmap + 4, records * 8))
    throw new Error("Invalid OG font cmap records");
  const codepoint = character.codePointAt(0)!;
  for (let index = 0; index < records; index++) {
    const record = cmap + 4 + index * 8;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    if (
      platform !== 0 &&
      !(platform === 3 && (encoding === 1 || encoding === 10))
    )
      continue;
    const offset = cmap + view.getUint32(record + 4);
    if (!cmapWithin(offset, 2)) throw new Error("Invalid OG font cmap offset");
    const format = view.getUint16(offset);
    if (format === 12) {
      if (!cmapWithin(offset, 16))
        throw new Error("Invalid OG font cmap format 12");
      const length = view.getUint32(offset + 4);
      const groups = view.getUint32(offset + 12);
      if (
        length < 16 ||
        !cmapWithin(offset, length) ||
        groups > (length - 16) / 12
      )
        throw new Error("Invalid OG font cmap groups");
      for (let group = 0; group < groups; group++) {
        const at = offset + 16 + group * 12;
        const start = view.getUint32(at);
        const end = view.getUint32(at + 4);
        if (codepoint >= start && codepoint <= end)
          return view.getUint32(at + 8) + codepoint - start !== 0;
      }
    } else if (format === 4 && codepoint <= 0xffff) {
      if (!cmapWithin(offset, 16))
        throw new Error("Invalid OG font cmap format 4");
      const length = view.getUint16(offset + 2);
      const segments = view.getUint16(offset + 6) / 2;
      if (
        !Number.isInteger(segments) ||
        !segments ||
        length < 16 + segments * 8 ||
        !cmapWithin(offset, length)
      )
        throw new Error("Invalid OG font cmap segments");
      for (let segment = 0; segment < segments; segment++) {
        const end = view.getUint16(offset + 14 + segment * 2);
        const start = view.getUint16(offset + 16 + segments * 2 + segment * 2);
        if (codepoint < start || codepoint > end) continue;
        const delta = view.getInt16(offset + 16 + segments * 4 + segment * 2);
        const rangeAt = offset + 16 + segments * 6 + segment * 2;
        const range = view.getUint16(rangeAt);
        if (!range) return ((codepoint + delta) & 0xffff) !== 0;
        const glyphAt = rangeAt + range + (codepoint - start) * 2;
        if (glyphAt + 2 > offset + length)
          throw new Error("Invalid OG font glyph offset");
        const glyph = view.getUint16(glyphAt);
        return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
      }
    }
  }
  return false;
}

async function boundedResponse(
  response: Response,
  maxBytes: number,
): Promise<ArrayBuffer> {
  if (!response.ok)
    throw new Error(`OG script font unavailable: ${response.status}`);
  if (Number(response.headers.get("content-length")) > maxBytes)
    throw new Error("OG script font response exceeds its byte limit");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("OG script font response is empty");
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxBytes)
        throw new Error("OG script font response exceeds its byte limit");
      parts.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined.buffer;
}

async function fetchScriptFont(
  face: CjkFontRequest,
  fetchImpl: typeof fetch,
): Promise<ArrayBuffer> {
  // Workers supports manual redirects; the bounded reader rejects every 3xx.
  const signal = AbortSignal.timeout(5000);
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(face.name)}:wght@500&text=${encodeURIComponent(face.text)}`;
  const css = new TextDecoder().decode(
    await boundedResponse(
      await fetchImpl(url, {
        headers: { "user-agent": FONT_USER_AGENT },
        signal,
        redirect: "manual",
      }),
      65_536,
    ),
  );
  const source = css.match(
    /src:\s*url\(([^)]+)\)\s*format\('(?:opentype|truetype)'\)/,
  )?.[1];
  if (!source) throw new Error("OG script font CSS has no TrueType source");
  const parsed = new URL(source);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "fonts.gstatic.com" ||
    parsed.username ||
    parsed.password ||
    parsed.port
  )
    throw new Error("Invalid OG script font origin");
  const bytes = await boundedResponse(
    await fetchImpl(source, {
      signal,
      redirect: "manual",
    }),
    MAX_FONT_BYTES,
  );
  // Validate the file even when this particular regional face cannot supply
  // the first requested character; combined coverage is checked below.
  fontHasGlyph(bytes, [...face.text][0]);
  return bytes;
}

/** Bounded per-renderer memo; errors are retryable and never become card success. */
export function createCjkFontLoader() {
  const cache = new Map<
    string,
    { promise: Promise<ArrayBuffer>; bytes: number }
  >();
  let pending = 0;
  let cachedBytes = 0;
  const clear = () => {
    cache.clear();
    cachedBytes = 0;
  };
  const trim = () => {
    for (const [key, entry] of cache) {
      if (cache.size <= MAX_CACHE_ENTRIES && cachedBytes <= MAX_CACHE_BYTES)
        break;
      if (!entry.bytes) continue;
      cache.delete(key);
      cachedBytes -= entry.bytes;
    }
  };
  const loadFace = (face: CjkFontRequest, fetchImpl: typeof fetch) => {
    const key = `${face.name}:${face.text}`;
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return cached.promise;
    }
    if (pending >= MAX_PENDING)
      return Promise.reject(new Error("OG script font load capacity exceeded"));
    pending++;
    const entry = { promise: Promise.resolve(new ArrayBuffer(0)), bytes: 0 };
    entry.promise = fetchScriptFont(face, fetchImpl)
      .then((bytes) => {
        if (cache.get(key) === entry) {
          entry.bytes = bytes.byteLength;
          cachedBytes += entry.bytes;
          trim();
        }
        return bytes;
      })
      .catch((error: unknown) => {
        if (cache.get(key) === entry) cache.delete(key);
        throw error;
      })
      .finally(() => {
        pending--;
      });
    cache.set(key, entry);
    trim();
    return entry.promise;
  };
  return {
    clear,
    async load(
      text: string,
      fetchImpl: typeof fetch = fetch,
    ): Promise<CjkFont[]> {
      const plan = cjkFontPlan(text);
      const requests = plan.map((face) => ({
        face,
        promise: loadFace(face, fetchImpl),
      }));
      const results = await Promise.allSettled(
        requests.map(async ({ face, promise }) => ({
          name: face.name,
          weight: face.weight,
          style: "normal" as const,
          data: await promise,
        })),
      );
      const fonts = results
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value);
      try {
        // A regional subset can be entirely unsupported (Google returns 400
        // for SC containing only 𠮷). Accept another face only when its actual
        // cmap covers every required character; never accept Latin-only tofu.
        const failure = results.find((result) => result.status === "rejected");
        if (failure && !fonts.length) throw failure.reason;
        for (const character of new Set(
          plan.flatMap(({ text: subset }) => [...subset]),
        )) {
          if (!fonts.some(({ data }) => fontHasGlyph(data, character))) {
            throw new Error(
              `OG script glyph unavailable: U+${character.codePointAt(0)!.toString(16)}`,
            );
          }
        }
      } catch (error) {
        // A later cmap lookup can reject a malformed subtable even when the
        // initial glyph was valid. Evict only this load's promises: a reset
        // and successful replacement may have happened while they resolved.
        for (const { face, promise } of requests) {
          const key = `${face.name}:${face.text}`;
          const entry = cache.get(key);
          if (entry?.promise !== promise) continue;
          cachedBytes -= entry.bytes;
          cache.delete(key);
        }
        throw error;
      }
      return fonts;
    },
  };
}
