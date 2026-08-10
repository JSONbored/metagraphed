// The validator-economics card (#10300).
//
// The card's value is that it refuses to flatten three distinctions the API
// went to the trouble of publishing separately. The trend word is unit-tested
// because "rose" on an unchanged pair is a claim about movement that did not
// happen -- the exact class of confident-but-wrong statement this whole surface
// exists to avoid.
import { describe, expect, it } from "vitest";
import { trendWord } from "./subnet-validator-economics-panel";

describe("describing which way a threshold moved", () => {
  it("says rose or fell only when it actually did", () => {
    expect(trendWord(10, 5)).toBe("rose");
    expect(trendWord(5, 10)).toBe("fell");
  });

  it("says UNCHANGED rather than picking a direction", () => {
    // A `>` comparison alone would report "fell" on an identical pair, which
    // invents movement over a flat window.
    expect(trendWord(7, 7)).toBe("unchanged");
    expect(trendWord(0, 0)).toBe("unchanged");
  });

  it("distinguishes 'no comparison exists' from 'no change'", () => {
    // A missing end is not a flat line. Reporting it as unchanged would claim
    // stability we never observed.
    for (const [a, b] of [
      [null, 5],
      [5, null],
      [undefined, 5],
      [null, null],
    ] as const) {
      expect(trendWord(a, b)).toBe("not comparable");
    }
  });

  it("treats zero as a real value, not as missing", () => {
    // `!latest` would send a genuine 0 down the not-comparable path -- a floor
    // that fell to zero is the most interesting movement there is.
    expect(trendWord(0, 5)).toBe("fell");
    expect(trendWord(5, 0)).toBe("rose");
  });
});
