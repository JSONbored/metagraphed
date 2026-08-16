import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * `@tanstack/zod-adapter`'s `fallback()` was removed in favour of zod's own
 * `.catch()`, across 111 call sites in 21 route search schemas. This pins the
 * claim that made that safe: the two parse identically.
 *
 * `legacyFallback` below is the adapter's ACTUAL runtime implementation, read
 * from its published dist and reproduced here --
 * `z.custom().pipe(schema.catch(value))`. The `z.custom()` prefix was a no-op
 * at runtime and existed only to widen the pipeline's input type, which is
 * precisely what broke inference under zod 4 (its declared return type named
 * `z.ZodPipeline` and `z.ZodTypeDef`, neither of which exists in v4, so
 * `fallback()` returned `any` and collapsed every route's search type to
 * `{ [x: string]: any }`).
 *
 * The dependency is gone, so this reimplements it rather than importing it.
 * If a future zod release changes `.catch()` semantics, this fails and names
 * the input class that diverged.
 */
const legacyFallback = <T extends z.ZodType>(schema: T, value: unknown) =>
  z.custom().pipe(schema.catch(value as never));

describe("fallback() vs .catch() are the same parse", () => {
  const cases: Array<[string, unknown]> = [
    ["valid in range", 42],
    ["below min", 0],
    ["above max", 5000],
    ["wrong type", "abc"],
    ["null", null],
    ["missing", undefined],
    ["NaN", Number.NaN],
    ["numeric string", "42"],
  ];

  it("agrees on every input, with .default() on top", () => {
    const before = z.object({
      limit: legacyFallback(z.number().int().min(1).max(100), 50).default(50),
    });
    const after = z.object({
      limit: z.number().int().min(1).max(100).catch(50).default(50),
    });
    for (const [name, input] of cases) {
      const a = before.safeParse({ limit: input });
      const b = after.safeParse({ limit: input });
      expect(b.success, `${name}: success differs`).toBe(a.success);
      expect(b.data, `${name}: data differs`).toEqual(a.data);
    }
  });

  it("agrees for a string field too", () => {
    const before = z.object({ q: legacyFallback(z.string(), "").default("") });
    const after = z.object({ q: z.string().catch("").default("") });
    for (const [name, input] of cases) {
      expect(after.safeParse({ q: input }).data, name).toEqual(before.safeParse({ q: input }).data);
    }
  });

  it("agrees for an enum field", () => {
    const V = ["table", "grid"] as const;
    const before = z.object({ v: legacyFallback(z.enum(V), "table").default("table") });
    const after = z.object({ v: z.enum(V).catch("table").default("table") });
    for (const [name, input] of [...cases, ["valid enum", "grid"] as [string, unknown]]) {
      expect(after.safeParse({ v: input }).data, name).toEqual(before.safeParse({ v: input }).data);
    }
  });
});
