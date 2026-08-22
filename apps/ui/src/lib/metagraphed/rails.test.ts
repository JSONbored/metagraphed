import { describe, expect, it } from "vitest";
import { railItems } from "./rails";

describe("railItems", () => {
  it("keys rows by label, keeps hrefs and drops non-finite values", () => {
    expect(
      railItems([
        { label: "SN1", value: 3, href: "/subnets/1" },
        { label: "SN2", value: Number.NaN },
      ]),
    ).toEqual([{ key: "SN1", label: "SN1", value: 3, href: "/subnets/1" }]);
    expect(railItems([{ label: "a", value: 1 }], (r) => `k:${r.label}`)[0]!.key).toBe("k:a");
  });
});
