import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAccountPageDigest } from "../scripts/lib/account-page-digest.ts";
import { feedOrder } from "../src/history-feed-tree.ts";
import type { AccountPageEntry } from "../scripts/lib/account-page-encoding.ts";

// Independent Python hashlib/struct vectors pin the existing digest stream.
const boundaries: [number, string][] = [
  [0, "8385cbfbdd20a88d90cb1b6e0c3a92a3a291fa355be8bb1de341fa27a2a2da04"],
  [1, "ca0122a676df2250b0ca0cfebfe5bc3fe81a5e7508fc4a0820581ea284640616"],
  [32640, "94a995d1b1a98a722d68f74df9c6d63da03fd7cb0757bef053e133c07b206649"],
  [32641, "22789c1d651755620e493b9d71a3bb4f8b2b8d204cdf9dc661e513883213e321"],
  [32642, "e5689f4e7f580f9391aa9808aeb98772fd7021617b403b74a9fe414f2f68096a"],
  [32768, "bf90c08dc2e24d4553c7e70eaff301982b0160727a28bc28eed351d57e9a3c8c"],
  [65537, "c63d8af8745031e664c7f71ae49b668562a77bc60e6039311a9418a3a4e3e294"],
];
const token =
  "a".repeat(64) + feedOrder(1000, 123, 4) + "b".repeat(64) + "00000001";
function entry(length: number): AccountPageEntry {
  return {
    token,
    values: [
      123,
      4,
      null,
      "Transfer",
      "x".repeat(length) + "\ud800\udc00\udfff\0雪",
      "",
      0,
      null,
      -0,
      Number.MIN_VALUE,
      1000,
    ],
  };
}

describe("bounded account page digests", () => {
  it.each(boundaries)(
    "preserves exact typed bytes across a %i-character field",
    (length, expected) => {
      const digest = createAccountPageDigest();
      expect(digest([entry(length)])).toBe(expected);
      expect(digest([])).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
      expect(digest([entry(length)])).toBe(expected);
    },
  );
  it("matches the independent compact page fixture", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("./fixtures/account-feeds/compact-page.json", import.meta.url),
        "utf8",
      ),
    ) as { entries: [string, AccountPageEntry["values"]][] };
    expect(
      createAccountPageDigest()(
        fixture.entries.map(([token, values]) => ({ token, values })),
      ),
    ).toBe("c534141988974db09c8865c4fffdaa38bb04a00647a9afb0e0c5aeaed1dc98c4");
  });
  it("separates pages, row order and the sign of zero", () => {
    const digest = createAccountPageDigest(),
      a = entry(0),
      b = entry(1);
    expect(digest([a, b])).not.toBe(digest([b, a]));
    expect(digest([a])).toBe(boundaries[0][1]);
    const positive = { ...a, values: [...a.values] };
    positive.values[8] = 0;
    expect(digest([positive])).not.toBe(digest([a]));
    const finite = { ...a, values: [...a.values] };
    finite.values[9] = Number.MAX_VALUE;
    expect(digest([finite])).not.toBe(digest([a]));
    expect(digest([a, b])).toBe(createAccountPageDigest()([a, b]));
  });
});
