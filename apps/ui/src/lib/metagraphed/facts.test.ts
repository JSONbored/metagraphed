import { describe, expect, it } from "vitest";
import { factCells } from "./facts";

const fact = (key: string) => ({ key, label: key, value: key.length });

describe("factCells", () => {
  it("builds a strip for every size the primitive accepts", () => {
    for (const size of [2, 3, 4, 5, 6]) {
      const facts = Array.from({ length: size }, (_, i) => fact(`f${i}`));
      expect(factCells(facts)).toHaveLength(size);
    }
  });

  it("takes the first six and drops the rest, because the strip holds six", () => {
    const cells = factCells(Array.from({ length: 9 }, (_, i) => fact(`f${i}`)));
    expect(cells).toHaveLength(6);
    expect(cells?.[0]?.label).toBe("f0");
    expect(cells?.[5]?.label).toBe("f5");
  });

  it("has no strip below two, which is the primitive's own floor", () => {
    expect(factCells([])).toBeNull();
    expect(factCells([fact("only")])).toBeNull();
  });

  it("carries a delta through, and omits the key the strip has no use for", () => {
    const [first] = factCells([
      { key: "a", label: "A", value: 1, delta: { text: "+2%", tone: "good" } },
      fact("b"),
    ])!;
    expect(first).toEqual({ label: "A", value: 1, delta: { text: "+2%", tone: "good" } });
  });

  it("leaves `delta` off entirely when there is none, rather than passing undefined", () => {
    expect(factCells([fact("a"), fact("b")])![0]).not.toHaveProperty("delta");
  });
});
