// Rendering alpha in USD honestly (#10385).
//
// Every test here is about a chart that would render perfectly while lying:
// a USD line silently shorter than the TAO line beside it, a declining index
// shown as $0, a market cap compared against venue numbers computed a different
// way. The assertions are mostly about what must be SAID, because the failure
// mode is silence rather than an error.
import { describe, expect, test } from "vitest";
import {
  ALPHA_MARKET_CAP_USD_NOTE,
  ALPHA_USD_PROVENANCE_NOTE,
  alphaUsdCoverage,
  alphaUsdUnavailableLabel,
} from "./alpha-usd.functions";

describe("USD coverage on a series", () => {
  test("a partial series SAYS where USD begins", () => {
    // The headline case: 90 days of TAO, 8 of USD. A chart that renders both
    // without qualifying the shorter one invites the reader to compare them.
    const c = alphaUsdCoverage({
      usd_available_from_iso: "2026-08-02T00:00:00.000Z",
      priced_candle_count: 8,
      candle_count: 90,
    });
    expect(c.available).toBe(true);
    expect(c.partial).toBe(true);
    expect(c.from).toBe("2026-08-02");
    expect(c.caption).toContain("USD from 2026-08-02");
    expect(c.caption).toContain("8 of 90");
  });

  test("a fully covered series carries NO caption", () => {
    // Noise is what stops captions being read on the charts that need them.
    const c = alphaUsdCoverage({
      usd_available_from_iso: "2026-08-02T00:00:00.000Z",
      priced_candle_count: 24,
      candle_count: 24,
    });
    expect(c.available).toBe(true);
    expect(c.partial).toBe(false);
    expect(c.caption).toBeNull();
  });

  test("a declining index is UNAVAILABLE, never zero", () => {
    // Acceptance 3. `insufficient_pools` is a stated outcome; rendering it as
    // $0 would publish "this subnet is worthless" where the truth is "not
    // priceable right now".
    const c = alphaUsdCoverage({
      usd_unavailable: "index_unpriced",
      priced_candle_count: 0,
      candle_count: 90,
    });
    expect(c.available).toBe(false);
    expect(c.pricedCount).toBe(0);
    expect(c.caption).toBeNull();
    expect(c.unavailableLabel).toContain("too few qualifying liquidity pools");
    // The TAO side is still there to render.
    expect(c.totalCount).toBe(90);
  });

  test("a STATED reason outranks the counts", () => {
    // A payload that names why it could not price must not be rendered as a
    // series that merely happens to be empty — even if a count disagrees.
    const c = alphaUsdCoverage({
      usd_unavailable: "read_failed",
      priced_candle_count: 5,
      candle_count: 90,
    });
    expect(c.available).toBe(false);
    expect(c.unavailableLabel).toContain("could not reach");
  });

  test("each reason reads differently, because they mean different things", () => {
    // "briefly unavailable" and "we could not reach it" lead a reader to
    // different actions. Collapsing them to one string throws that away.
    const labels = [
      "index_unpriced",
      "index_stale",
      "no_index_reading",
      "read_failed",
      "no_alpha_price",
    ].map(alphaUsdUnavailableLabel);
    expect(new Set(labels).size).toBe(labels.length);
    for (const l of labels) expect(l).toMatch(/^USD unavailable/);
  });

  test("an unknown reason still degrades to a sentence, not to a raw token", () => {
    expect(alphaUsdUnavailableLabel("something_new")).toBe("USD unavailable");
    expect(alphaUsdUnavailableLabel(null)).toBe("USD unavailable");
  });

  test("the day-keyed series works the same way", () => {
    // /economics/trends keys on snapshot_date rather than a bucket instant.
    const c = alphaUsdCoverage({
      usd_available_from: "2026-08-02",
      priced_day_count: 8,
      day_count: 400,
    });
    expect(c.available).toBe(true);
    expect(c.from).toBe("2026-08-02");
    expect(c.caption).toContain("8 of 400");
  });

  test("a missing or malformed payload renders TAO only", () => {
    for (const bad of [null, undefined, 42, "x", []]) {
      const c = alphaUsdCoverage(bad as never);
      expect(c.available).toBe(false);
      expect(c.caption).toBeNull();
      expect(c.unavailableLabel).toBe("USD unavailable");
    }
  });

  test("priced points with no stated boundary still qualify themselves", () => {
    // The count is enough to know the series is partial; the date is a nicety.
    // Dropping the caption because one field was absent would hide the gap.
    const c = alphaUsdCoverage({ priced_candle_count: 3, candle_count: 90 });
    expect(c.partial).toBe(true);
    expect(c.from).toBeNull();
    expect(c.caption).toContain("3 of 90");
  });

  test("zero points priced is unavailable even with no reason given", () => {
    const c = alphaUsdCoverage({ priced_candle_count: 0, candle_count: 90 });
    expect(c.available).toBe(false);
    expect(c.caption).toBeNull();
  });

  test("negative or non-numeric counts do not become a caption", () => {
    // A garbled count must not produce "USD covers -1 of 90 points".
    for (const bad of [-1, Number.NaN, "many", null]) {
      const c = alphaUsdCoverage({
        priced_candle_count: bad as never,
        candle_count: 90,
      });
      expect(c.available).toBe(false);
      expect(c.caption).toBeNull();
    }
  });
});

describe("the notes that must stay reachable", () => {
  test("USD is described as DERIVED, not quoted", () => {
    // Acceptance 1: no USD figure renders without its provenance reachable.
    expect(ALPHA_USD_PROVENANCE_NOTE).toMatch(/derived/i);
    expect(ALPHA_USD_PROVENANCE_NOTE).toMatch(/not.*quoted by any venue/i);
  });

  test("the market-cap note names its denominator and warns off comparison", () => {
    // #10381: the denominator is a property of the figure, not a footnote.
    expect(ALPHA_MARKET_CAP_USD_NOTE).toMatch(/total staked alpha/i);
    expect(ALPHA_MARKET_CAP_USD_NOTE).toMatch(/not a circulating-supply/i);
    expect(ALPHA_MARKET_CAP_USD_NOTE).toMatch(/not comparable/i);
  });
});
