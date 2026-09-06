// Actual API card raster fixtures. No registry requests or endpoint probes.
// node --experimental-strip-types scripts/render-api-og-preview.ts [output] [--write-fallback]
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import type { ReactNode } from "react";
import satori from "satori";
import { html } from "satori-html";
import { loadCardFonts } from "../src/og-card-fonts.ts";
import {
  CARD_VERSION,
  LOGO_DATA_URI,
  renderCardLayout,
} from "../src/og-card-style.ts";
import { renderMarkup } from "../src/og-image.ts";
import {
  accountFacts,
  renderEntityMarkup,
  subnetFacts,
} from "../src/og-entity-card.ts";

const outDir = process.argv[2] ?? "/tmp/api-og-preview";
const logo = new Resvg(Buffer.from(LOGO_DATA_URI.split(",")[1], "base64"))
  .render()
  .asPng();
const subnet = subnetFacts(
  {
    subnets: [
      {
        netuid: 19,
        name: "Example subnet",
        integration_readiness: 96,
        surface_count: 76,
        coverage_level: "deep",
      },
    ],
  },
  19,
)!;
const variants = {
  "all-fields-maximum": renderCardLayout({
    title: "W".repeat(110),
    identifier: "Identifier ".repeat(4),
    subtitle: "W".repeat(90),
    stats: [1, 2, 3, 4].map(() => ({
      label: "W".repeat(24),
      value: "9".repeat(28),
    })),
    mark: "65535",
    entity: true,
  }),
  "black-logo": renderEntityMarkup({
    ...subnet,
    logo: `data:image/png;base64,${new Resvg(Buffer.from(LOGO_DATA_URI.split(",")[1], "base64").toString().replaceAll("#30ffc0", "#000000")).render().asPng().toString("base64")}`,
  }),
  landing: renderMarkup([
    "128 subnets",
    "2,540 endpoints",
    "312 providers",
    "87% coverage",
  ]),
  fallback: renderMarkup(null),
  "landing-max": renderMarkup([
    "999,999,999 subnets",
    "999,999,999 endpoints",
    "999,999,999 providers",
    "100% coverage",
  ]),
  subnet: renderEntityMarkup(subnet),
  "subnet-logo": renderEntityMarkup({
    ...subnet,
    logo: `data:image/png;base64,${logo.toString("base64")}`,
  }),
  "subnet-absent": renderEntityMarkup({
    kind: "Bittensor subnet 65535",
    identifier: "Subnet 65535",
    title: "Subnet 65535",
    stats: [],
    mark: "65535",
  }),
  account: renderEntityMarkup(
    accountFacts("5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3"),
  ),
  "maximum-text": renderEntityMarkup({
    title: "Long public subnet identity ".repeat(5),
    kind: "Bittensor subnet 65535",
    identifier: "Subnet 65535",
    mark: "65535",
    stats: ["Coverage", "Published field", "Observed value"].map((label) => ({
      label: label.repeat(4),
      value: "123456789012345678901234567890",
    })),
  }),
  "unbroken-text": renderEntityMarkup({
    kind: "Bittensor subnet 0",
    identifier: "Subnet 0",
    title: "W".repeat(150),
    stats: [],
    mark: "0",
  }),
  unicode: renderEntityMarkup({
    kind: "Bittensor subnet 7",
    identifier: "Subnet 7",
    title: "Research & data — τ",
    stats: [
      { label: "Readiness", value: "96/100" },
      { label: "Coverage", value: "87% & verified" },
    ],
    mark: "7",
  }),
};

await mkdir(outDir, { recursive: true });
const receipts = [];
for (const [name, markup] of Object.entries(variants)) {
  const svg = await satori(html(markup) as ReactNode, {
    width: 1200,
    height: 630,
    fonts: await loadCardFonts(markup),
  });
  const rendered = new Resvg(svg).render();
  if (rendered.width !== 1200 || rendered.height !== 630)
    throw new Error(`${name}: invalid canvas`);
  const png = rendered.asPng();
  await writeFile(path.join(outDir, `${name}.png`), png);
  await writeFile(path.join(outDir, `${name}.svg`), svg);
  await writeFile(path.join(outDir, `${name}.html`), markup);
  receipts.push({
    fixture: name,
    renderer_version: CARD_VERSION,
    width: rendered.width,
    height: rendered.height,
    sha256: createHash("sha256").update(png).digest("hex"),
  });
  console.log(`${name}: 1200×630 PNG`);
}
await writeFile(
  path.join(outDir, "receipts.json"),
  JSON.stringify(
    {
      evidence:
        "Local synthetic fixtures; native Satori/Resvg, production markup and font loader",
      cards: receipts,
    },
    null,
    2,
  ) + "\n",
);
if (process.argv.includes("--write-fallback")) {
  await copyFile(
    path.join(outDir, "fallback.png"),
    new URL("../public/brand/og-fallback.png", import.meta.url),
  );
}
