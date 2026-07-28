/**
 * Pure layout math for CandlestickMini's optional volume band, split out as a
 * `.ts` sibling for the same reason chart-aria.ts is -- ui-kit's vitest suite
 * runs in a plain node environment and its `include` matches `.test.ts` files
 * only (vitest.config.ts), so logic that deserves direct tests lives beside
 * the component rather than inside its `.tsx`.
 */

/** Share of total height given to the volume histogram when it's drawn. */
export const VOLUME_BAND_RATIO = 0.22;
/** Dead gap between the volume band and the price plot above it. */
export const VOLUME_BAND_GAP_RATIO = 0.04;

export interface CandlestickVolumeLayout {
  /** True only when at least one candle carries a positive finite volume. */
  hasVolume: boolean;
  /** Largest volume in the series; 0 when there is none. */
  maxVolume: number;
  /** Height reserved for the volume band; 0 when there is no volume. */
  volumeHeight: number;
  /** Height left for the price plot -- the FULL height when there's no volume. */
  priceHeight: number;
}

/**
 * Decide whether a volume band is drawn at all, and how the height splits.
 *
 * A series with no volume field, or one whose volumes are all zero/non-finite,
 * reserves nothing: the price plot keeps the entire height and every caller
 * that predates the volume band renders byte-identically.
 */
export function candlestickVolumeLayout(
  height: number,
  candles: readonly { volume?: number }[],
): CandlestickVolumeLayout {
  let maxVolume = 0;
  for (const c of candles) {
    const v = c.volume;
    if (typeof v === "number" && Number.isFinite(v) && v > maxVolume)
      maxVolume = v;
  }
  const hasVolume = maxVolume > 0;
  const volumeHeight = hasVolume ? height * VOLUME_BAND_RATIO : 0;
  const priceHeight = hasVolume
    ? height - volumeHeight - height * VOLUME_BAND_GAP_RATIO
    : height;
  return { hasVolume, maxVolume, volumeHeight, priceHeight };
}

/**
 * Height of one volume bar. A real-but-tiny bucket clamps to a 1px hairline
 * rather than rounding away to nothing -- the same reasoning that gives a doji
 * (open === close) a visible body in the component itself. A zero, negative,
 * or non-finite volume draws nothing at all, which is the honest rendering of
 * "no trades in this bucket".
 */
export function candlestickVolumeBarHeight(
  volume: number | undefined,
  maxVolume: number,
  volumeHeight: number,
): number {
  if (typeof volume !== "number" || !Number.isFinite(volume) || volume <= 0)
    return 0;
  if (maxVolume <= 0 || volumeHeight <= 0) return 0;
  return Math.max(1, (volume / maxVolume) * volumeHeight);
}
