import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #6427: validatorDetailQuery already normalizes `coldkey`, but the page used it
// only for the owner-only `isOwner` check / TakeManagementModal — a regular
// visitor had no way to see which account controls the hotkey. The fix renders
// `detail.coldkey` as a public /accounts/$ss58 link (via AccountAddress), gated
// on the coldkey's presence rather than ownership.
const source = readFileSync(
  fileURLToPath(new URL("./validators.$hotkey.tsx", import.meta.url)),
  "utf8",
);

describe("validator detail surfaces the owning coldkey (#6427)", () => {
  it("renders detail.coldkey through AccountAddress (the /accounts/$ss58 link idiom)", () => {
    expect(source).toContain(
      'import { AccountAddress } from "@/components/metagraphed/account-address";',
    );
    expect(source).toContain("ss58={detail.coldkey}");
  });

  it("gates the coldkey field on its presence, not on isOwner", () => {
    // The AccountAddress usage must sit inside a `detail.coldkey ?` guard, not
    // inside the `isOwner ?` block that wraps the owner-only take controls.
    const coldkeyBlock = source.slice(
      source.indexOf("{detail.coldkey ?"),
      source.indexOf("ss58={detail.coldkey}"),
    );
    expect(coldkeyBlock).toContain("{detail.coldkey ?");
    expect(coldkeyBlock).not.toContain("isOwner");
  });

  it("handles a missing coldkey gracefully (renders nothing, with a fallback dash)", () => {
    // Present-but-invalid ss58 falls through AccountAddress's own fallback.
    const coldkeyRender = source.slice(
      source.indexOf("{detail.coldkey ?"),
      source.indexOf("{detail.coldkey ?") + 700,
    );
    expect(coldkeyRender).toContain("fallback=");
    expect(coldkeyRender).toMatch(/\)\s*:\s*null}/);
  });
});
