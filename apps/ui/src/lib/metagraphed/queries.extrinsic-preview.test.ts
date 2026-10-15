import { afterEach, describe, expect, it, vi } from "vitest";
import { extrinsicQuery } from "./queries";
import { runQuery } from "./run-query";

afterEach(() => vi.unstubAllGlobals());

async function preview(call_args: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          data: { extrinsic: { extrinsic_hash: "0xabc", call_args }, events: [] },
        }),
      ),
    ),
  );
  return (await runQuery(extrinsicQuery("0xabc"))).data!;
}

describe("real extrinsic query argument preview boundaries", () => {
  it.each([2000, 2001])("discloses string truncation at %i characters", async (length) => {
    const result = await preview({ operand: "x".repeat(length) });
    expect((result.call_args as Record<string, unknown>).operand).toBe(
      length === 2000 ? "x".repeat(2000) : `${"x".repeat(2000)}…`,
    );
    expect(result.call_args_preview_limits).toEqual(length === 2000 ? [] : ["long strings"]);
  });

  it.each([64, 65])("reports top-level and nested collection bounds at %i", async (length) => {
    const args = Object.fromEntries(Array.from({ length }, (_, index) => [`arg${index}`, index]));
    const top = await preview(args);
    expect(Object.keys(top.call_args!)).toHaveLength(Math.min(length, 64));
    expect(top.call_args_total).toBe(length);
    expect(top.call_args_preview_limits).toEqual(length === 64 ? [] : ["argument count"]);
    const nested = await preview({
      list: Array.from({ length }, (_, index) => index),
      object: args,
    });
    expect(nested.call_args_preview_limits).toEqual(length === 64 ? [] : ["collection entries"]);
    const list = (nested.call_args as Record<string, unknown>).list as unknown[];
    expect(list.at(-1)).toBe(length === 64 ? 63 : "[Truncated]");
  });

  it.each([8, 9])("reports nested object depth at %i levels", async (depth) => {
    let value: unknown = "leaf";
    for (let index = 0; index < depth; index++) value = { child: value };
    const result = await preview({ operand: value });
    expect(result.call_args_preview_limits).toEqual(depth === 8 ? [] : ["nested depth"]);
    expect(JSON.stringify(result.call_args)).toContain(
      depth === 8 ? "leaf" : "[Max depth exceeded]",
    );
  });

  it("discloses dropped malformed operands and name/key collisions instead of measured emptiness", async () => {
    const malformed = await preview([1, "operand"]);
    expect(malformed.call_args).toEqual([]);
    expect(malformed.call_args_total).toBe(2);
    expect(malformed.call_args_preview_limits).toContain("unrecognized arguments");
    const prefix = "x".repeat(2000);
    const keys = await preview({ [`${prefix}a`]: 1, [`${prefix}b`]: 2 });
    expect(keys.call_args_preview_limits).toContain("long strings");
    expect(Object.keys(keys.call_args!)).toHaveLength(1);
    const names = await preview([{ name: `${prefix}a`, value: 1 }]);
    expect(names.call_args_preview_limits).toContain("long strings");
  });

  it("shares a preview budget across arguments instead of multiplying width by depth", async () => {
    const result = await preview(
      Object.fromEntries(
        Array.from({ length: 64 }, (_, index) => [
          `arg${index}`,
          Array.from({ length: 64 }, () => "x".repeat(2000)),
        ]),
      ),
    );
    expect(result.call_args_preview_limits).toContain("preview budget");
    expect(JSON.stringify(result.call_args).length).toBeLessThan(256 * 1024);
  });
});
