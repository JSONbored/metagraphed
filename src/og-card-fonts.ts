import { cardGlyphs } from "./og-card-style.ts";

export const CARD_FONT_FACES = [
  { name: "Geist", weight: 500 },
  { name: "Geist", weight: 700 },
  { name: "Geist Mono", weight: 500 },
  // Geist does not cover Greek/Cyrillic identity text. Keep an explicit
  // fallback face so values such as τ do not become missing-glyph boxes.
  { name: "Inter", weight: 500 },
  { name: "Inter", weight: 700 },
] as const;

/** Shared by the Node artifact renderer and the lazy entity renderer. */
export async function loadCardFonts(markup: string) {
  // Encode the entire text parameter. A literal %, &, or + in registry copy
  // must not alter the font subset query or omit a painted Unicode glyph.
  const text = [...new Set([...cardGlyphs(markup)])].join("");
  return Promise.all(
    CARD_FONT_FACES.map(async (face) => {
      const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(face.name)}:wght@${face.weight}&text=${encodeURIComponent(text)}`;
      const css = await fetch(cssUrl, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1",
        },
        signal: AbortSignal.timeout(5000),
        redirect: "manual",
      });
      if (!css.ok) throw new Error(`card font CSS unavailable: ${css.status}`);
      const src = (await css.text()).match(/src:\s*url\(([^)]+)\)/)?.[1];
      if (!src) throw new Error("card font CSS has no source");
      // CSS is a remote response, not authority to request an arbitrary host.
      // Inspect redirects without following them (Workers supports manual, not
      // error mode). Non-success responses below preserve the same boundary at
      // every hop, including for a compromised font stylesheet.
      const source = new URL(src);
      if (
        source.protocol !== "https:" ||
        source.hostname !== "fonts.gstatic.com" ||
        source.username ||
        source.password ||
        source.port
      ) {
        throw new Error("card font source is not an allowed HTTPS font origin");
      }
      const font = await fetch(source.href, {
        signal: AbortSignal.timeout(5000),
        redirect: "manual",
      });
      if (!font.ok) throw new Error(`card font unavailable: ${font.status}`);
      return {
        ...face,
        data: await font.arrayBuffer(),
        style: "normal" as const,
      };
    }),
  );
}
