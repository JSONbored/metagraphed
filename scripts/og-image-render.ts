import { Resvg } from "@resvg/resvg-js";
import type { ReactNode } from "react";
import satori from "satori";
import { html } from "satori-html";
import { CARD_FONT_FACES } from "../src/og-card-fonts.ts";
import { cardGlyphs } from "../src/og-card-style.ts";
import { CARD_VERSION } from "../src/og-card-version.ts";
import { buildStatParts, renderMarkup } from "../src/og-image.ts";
import { sha256Hex } from "./lib.ts";
import { ReleaseBudget } from "./artifact-release-store.ts";
import {
  IMAGE_PATHS,
  parseRecord,
  verifyPng,
  type ImageRenderReceipt,
} from "./og-image-release-plan.ts";

export async function strictCardFonts(markup: string, budget: ReleaseBudget) {
  const glyphs = [...new Set([...cardGlyphs(markup)])].join("");
  const fonts = [];
  for (const face of CARD_FONT_FACES) {
    const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(face.name)}:wght@${face.weight}&text=${encodeURIComponent(glyphs)}`;
    const css = await budget.request(cssUrl, {
      headers: {
        "user-agent": "Mozilla/5.0 AppleWebKit/533.21.1 Safari/533.21.1",
      },
    });
    if (!css.ok) throw new Error("Card font CSS unavailable.");
    const source = (await budget.read(css, 64 * 1024))
      .toString()
      .match(/src:\s*url\(([^)]+)\)/)?.[1];
    if (!source || new URL(source).origin !== "https://fonts.gstatic.com")
      throw new Error("Unexpected font source.");
    const response = await budget.request(source);
    if (!response.ok) throw new Error("Card font unavailable.");
    const bytes = await budget.read(response, 1024 * 1024);
    fonts.push({
      ...face,
      data: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
      style: "normal" as const,
    });
  }
  return fonts;
}

export async function renderImageRelease(
  source: Uint8Array,
  revision: string,
  budget = new ReleaseBudget(),
  loadFonts = strictCardFonts,
) {
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error("Exact renderer source revision required.");
  const summary = parseRecord(source, 1024 * 1024, "Registry summary");
  const markup = renderMarkup(buildStatParts(summary));
  const fonts = await loadFonts(markup, budget);
  const svg = await satori(html(markup) as ReactNode, {
    width: 1200,
    height: 630,
    fonts,
  });
  const png = Buffer.from(new Resvg(svg).render().asPng());
  verifyPng(png);
  const receipt: ImageRenderReceipt = {
    status: "rendered",
    renderer_version: CARD_VERSION,
    renderer_revision: revision,
    source_sha256: sha256Hex(source),
    fonts: fonts.map((font) => ({
      name: font.name,
      weight: font.weight,
      sha256: sha256Hex(Buffer.from(font.data)),
      size_bytes: font.data.byteLength,
    })),
    artifacts: IMAGE_PATHS.map((path) => ({
      path,
      sha256: sha256Hex(png),
      size_bytes: png.length,
      content_type: "image/png",
      width: 1200,
      height: 630,
    })),
  };
  return {
    pngs: Object.fromEntries(IMAGE_PATHS.map((path) => [path, png])),
    receipt,
  };
}
