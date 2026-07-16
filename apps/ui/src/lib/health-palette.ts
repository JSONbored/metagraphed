import { useCallback, useEffect, useState } from "react";

/**
 * Health color presets. Each preset ships light + dark values for the four
 * health states (ok/warn/down/unknown). Values are pre-checked to clear
 * WCAG AA (>= 4.5:1) as small text against both `--paper` and `--card`
 * in their respective modes; the health dot itself doesn't carry text so
 * the practical bar is "clearly perceptible vs surrounding chrome".
 */
export type HealthPaletteId = "traffic-light" | "colorblind-safe" | "muted";

interface PaletteShape {
  ok: string;
  warn: string;
  down: string;
  unknown: string;
}

export interface HealthPaletteDef {
  id: HealthPaletteId;
  label: string;
  description: string;
  light: PaletteShape;
  dark: PaletteShape;
  /** Preview swatch (single color per state) used in the settings popover. */
  swatch: PaletteShape;
}

export const HEALTH_PALETTES: HealthPaletteDef[] = [
  {
    id: "traffic-light",
    label: "Traffic light",
    description: "Default. Green / amber / red / grey.",
    light: {
      ok: "oklch(0.55 0.18 150)",
      warn: "oklch(0.65 0.16 65)",
      down: "oklch(0.55 0.22 28)",
      unknown: "oklch(0.60 0.008 40)",
    },
    dark: {
      ok: "oklch(0.72 0.16 150)",
      warn: "oklch(0.80 0.14 75)",
      down: "oklch(0.70 0.20 28)",
      unknown: "oklch(0.55 0.008 40)",
    },
    swatch: {
      ok: "oklch(0.65 0.17 150)",
      warn: "oklch(0.75 0.15 70)",
      down: "oklch(0.62 0.21 28)",
      unknown: "oklch(0.60 0.008 40)",
    },
  },
  {
    id: "colorblind-safe",
    label: "Colorblind-safe",
    description: "Based on Okabe-Ito. Distinguishable for deuteranopia/protanopia.",
    light: {
      ok: "oklch(0.55 0.15 210)", // blue
      warn: "oklch(0.65 0.16 60)", // orange
      down: "oklch(0.50 0.22 340)", // magenta
      unknown: "oklch(0.62 0.005 250)",
    },
    dark: {
      ok: "oklch(0.72 0.14 210)",
      warn: "oklch(0.80 0.14 60)",
      down: "oklch(0.70 0.20 340)",
      unknown: "oklch(0.58 0.005 250)",
    },
    swatch: {
      ok: "oklch(0.65 0.15 210)",
      warn: "oklch(0.74 0.15 60)",
      down: "oklch(0.60 0.21 340)",
      unknown: "oklch(0.60 0.005 250)",
    },
  },
  {
    id: "muted",
    label: "Muted",
    description: "Desaturated for dense dashboards. Calmer foreground.",
    light: {
      ok: "oklch(0.55 0.10 160)",
      warn: "oklch(0.65 0.10 75)",
      down: "oklch(0.55 0.13 25)",
      unknown: "oklch(0.62 0.008 40)",
    },
    dark: {
      ok: "oklch(0.72 0.09 160)",
      warn: "oklch(0.78 0.09 75)",
      down: "oklch(0.70 0.12 25)",
      unknown: "oklch(0.55 0.008 40)",
    },
    swatch: {
      ok: "oklch(0.65 0.10 160)",
      warn: "oklch(0.74 0.10 75)",
      down: "oklch(0.62 0.13 25)",
      unknown: "oklch(0.60 0.008 40)",
    },
  },
];

const STORAGE_KEY = "mg-health-palette";
const STYLE_ID = "mg-health-palette-style";
const DEFAULT_ID: HealthPaletteId = "traffic-light";

export function readId(): HealthPaletteId {
  if (typeof window === "undefined") return DEFAULT_ID;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return (HEALTH_PALETTES.find((p) => p.id === v)?.id ?? DEFAULT_ID) as HealthPaletteId;
  } catch {
    // Match theme.ts's readChoice: a throwing localStorage (Safari private
    // browsing, storage blocked by policy/extension) degrades to the default
    // instead of throwing during the initial render.
    return DEFAULT_ID;
  }
}

export function cssFor(p: HealthPaletteDef): string {
  return (
    `:root{--health-ok:${p.light.ok};--health-warn:${p.light.warn};--health-down:${p.light.down};--health-unknown:${p.light.unknown};}` +
    `.dark{--health-ok:${p.dark.ok};--health-warn:${p.dark.warn};--health-down:${p.dark.down};--health-unknown:${p.dark.unknown};}`
  );
}

function apply(id: HealthPaletteId) {
  if (typeof document === "undefined") return;
  const def = HEALTH_PALETTES.find((p) => p.id === id) ?? HEALTH_PALETTES[0];
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = cssFor(def);
}

/**
 * Pre-hydration script. Sets the palette before first paint.
 * Mirrors HEALTH_PALETTES; keep in sync.
 */
export const HEALTH_PALETTE_BOOTSTRAP_SCRIPT = `(() => {
  try {
    var v = localStorage.getItem("${STORAGE_KEY}");
    var P = ${JSON.stringify(HEALTH_PALETTES.map((p) => ({ id: p.id, light: p.light, dark: p.dark })))};
    var def = P.find(function(p){return p.id===v;}) || P[0];
    var css = ":root{--health-ok:"+def.light.ok+";--health-warn:"+def.light.warn+";--health-down:"+def.light.down+";--health-unknown:"+def.light.unknown+";}" +
      ".dark{--health-ok:"+def.dark.ok+";--health-warn:"+def.dark.warn+";--health-down:"+def.dark.down+";--health-unknown:"+def.dark.unknown+";}";
    var el = document.createElement("style");
    el.id = "${STYLE_ID}";
    el.textContent = css;
    document.head.appendChild(el);
  } catch (_) {}
})();`;

export function useHealthPalette() {
  const [paletteId, setPaletteIdState] = useState<HealthPaletteId>(() => readId());
  useEffect(() => apply(paletteId), [paletteId]);
  const setPalette = useCallback((id: HealthPaletteId) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* best-effort persist */
    }
    setPaletteIdState(id);
  }, []);
  return { paletteId, setPalette };
}
