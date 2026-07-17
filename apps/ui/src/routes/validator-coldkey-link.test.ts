import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #6427: detail.coldkey was fetched but only used for the isOwner check, never
// rendered for a visitor. It's now a public, linked Coldkey field in the
// masthead (AccountAddress -> /accounts/$ss58), outside any isOwner gate.
// Verified in a browser: after links /accounts/<coldkey>; before had no such link.
const source = readFileSync(
  fileURLToPath(new URL("./validators.$hotkey.tsx", import.meta.url)),
  "utf8",
);

describe("validator page surfaces the owning coldkey (#6427)", () => {
  it("renders the coldkey through AccountAddress, untruncated with a fallback", () => {
    const field = source.slice(
      source.indexOf("Coldkey</span>"),
      source.indexOf("Coldkey</span>") + 260,
    );
    expect(field).toContain("<AccountAddress");
    expect(field).toContain("ss58={detail.coldkey}");
    expect(field).toContain("truncate={false}");
    expect(field).toContain("fallback=");
  });

  it("is not gated on isOwner (public, not owner-only)", () => {
    // The coldkey field must sit in the always-rendered masthead, before the
    // isOwner-gated actions block, so every visitor sees it.
    const coldkeyAt = source.indexOf("ss58={detail.coldkey}");
    const isOwnerActionAt = source.indexOf("isOwner ? (");
    expect(coldkeyAt).toBeGreaterThan(-1);
    expect(coldkeyAt).toBeLessThan(isOwnerActionAt);
  });
});
