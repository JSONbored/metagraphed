import { describe, expect, it } from "vitest";
import {
  COARSE_POINTER_MEDIA_QUERY,
  getCoarsePointerMediaQuery,
  matchesCoarsePointer,
} from "./coarse-pointer";

describe("coarse-pointer media helpers (#5337)", () => {
  it("exports the touch-primary media query EntityHoverCard relies on", () => {
    expect(COARSE_POINTER_MEDIA_QUERY).toBe("(hover: none), (pointer: coarse)");
  });

  it("treats missing media as fine-pointer (hover cards stay enabled)", () => {
    expect(matchesCoarsePointer(null)).toBe(false);
    expect(matchesCoarsePointer(undefined)).toBe(false);
  });

  it("returns true when the media query matches", () => {
    expect(matchesCoarsePointer({ matches: true })).toBe(true);
    expect(matchesCoarsePointer({ matches: false })).toBe(false);
  });

  it("returns null from getCoarsePointerMediaQuery when matchMedia is absent", () => {
    expect(getCoarsePointerMediaQuery(null)).toBeNull();
    expect(getCoarsePointerMediaQuery({} as Window)).toBeNull();
  });

  it("delegates to window.matchMedia when available", () => {
    const list = { matches: true } as MediaQueryList;
    const win = {
      matchMedia: (query: string) => {
        expect(query).toBe(COARSE_POINTER_MEDIA_QUERY);
        return list;
      },
    };
    expect(getCoarsePointerMediaQuery(win)).toBe(list);
  });

  it("swallows matchMedia errors and returns null", () => {
    const win = {
      matchMedia: () => {
        throw new Error("unsupported");
      },
    };
    expect(getCoarsePointerMediaQuery(win)).toBeNull();
  });
});
