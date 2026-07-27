import { describe, it, expect } from "vitest";
import {
  candlestickVolumeBarHeight,
  candlestickVolumeLayout,
  VOLUME_BAND_GAP_RATIO,
  VOLUME_BAND_RATIO,
} from "./candlestick-geometry";

describe("candlestickVolumeLayout", () => {
  it("reserves nothing when no candle carries a volume", () => {
    const layout = candlestickVolumeLayout(200, [{}, {}, {}]);
    expect(layout.hasVolume).toBe(false);
    expect(layout.volumeHeight).toBe(0);
    // The whole point: pre-volume callers must keep the full height for price.
    expect(layout.priceHeight).toBe(200);
  });

  it("reserves nothing when every volume is zero or non-finite", () => {
    const layout = candlestickVolumeLayout(200, [
      { volume: 0 },
      { volume: Number.NaN },
      { volume: Number.POSITIVE_INFINITY },
      { volume: -5 },
    ]);
    expect(layout.hasVolume).toBe(false);
    expect(layout.priceHeight).toBe(200);
  });

  it("splits the height once any positive volume is present", () => {
    const layout = candlestickVolumeLayout(200, [
      { volume: 0 },
      { volume: 12 },
    ]);
    expect(layout.hasVolume).toBe(true);
    expect(layout.maxVolume).toBe(12);
    expect(layout.volumeHeight).toBeCloseTo(200 * VOLUME_BAND_RATIO);
    expect(layout.priceHeight).toBeCloseTo(
      200 - 200 * VOLUME_BAND_RATIO - 200 * VOLUME_BAND_GAP_RATIO,
    );
  });

  it("leaves the band and the gap fully inside the given height", () => {
    const { volumeHeight, priceHeight } = candlestickVolumeLayout(220, [
      { volume: 1 },
    ]);
    expect(volumeHeight + priceHeight).toBeLessThan(220);
    expect(priceHeight).toBeGreaterThan(volumeHeight);
  });

  it("ignores non-finite volumes when picking the max", () => {
    const layout = candlestickVolumeLayout(100, [
      { volume: 5 },
      { volume: Number.NaN },
      { volume: 3 },
    ]);
    expect(layout.maxVolume).toBe(5);
  });
});

describe("candlestickVolumeBarHeight", () => {
  it("scales proportionally to the series max", () => {
    expect(candlestickVolumeBarHeight(50, 100, 40)).toBeCloseTo(20);
    expect(candlestickVolumeBarHeight(100, 100, 40)).toBeCloseTo(40);
  });

  it("clamps a real-but-tiny bucket to a visible hairline", () => {
    // 1/10000 of 40px would round away to nothing; it must still draw.
    expect(candlestickVolumeBarHeight(1, 10_000, 40)).toBe(1);
  });

  it("draws nothing for an absent, zero, negative, or non-finite volume", () => {
    expect(candlestickVolumeBarHeight(undefined, 100, 40)).toBe(0);
    expect(candlestickVolumeBarHeight(0, 100, 40)).toBe(0);
    expect(candlestickVolumeBarHeight(-3, 100, 40)).toBe(0);
    expect(candlestickVolumeBarHeight(Number.NaN, 100, 40)).toBe(0);
  });

  it("draws nothing when there is no band to draw into", () => {
    expect(candlestickVolumeBarHeight(10, 100, 0)).toBe(0);
    expect(candlestickVolumeBarHeight(10, 0, 40)).toBe(0);
  });
});
