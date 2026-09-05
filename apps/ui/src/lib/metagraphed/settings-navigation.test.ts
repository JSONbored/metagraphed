import { describe, expect, it } from "vitest";
import { settingsGroupForHash, settingsNavigation } from "./settings-navigation";

describe("Settings destinations", () => {
  it("preserves every existing section anchor", () => {
    for (const hash of ["wallet", "portability", "alerts"])
      expect(settingsGroupForHash(hash)).toBe("watchlists");
    for (const hash of ["keys", "webhooks"]) expect(settingsGroupForHash(hash)).toBe("developer");
    expect(settingsGroupForHash("preferences")).toBe("appearance");
    expect(settingsGroupForHash("#wallet")).toBe("watchlists");
  });
  it("safely defaults unknown and absent anchors without treating them as authenticated destinations", () => {
    for (const hash of ["", "unknown", "keys-extra", "%", "__proto__"])
      expect(settingsGroupForHash(hash)).toBe("appearance");
  });
  it("exposes exactly one current destination through stable existing URLs", () => {
    for (const group of ["appearance", "watchlists", "developer"] as const) {
      const nav = settingsNavigation(group);
      expect(nav.filter((item) => item.current).map((item) => item.id)).toEqual([group]);
      expect(nav.map((item) => item.href)).toEqual([
        "/settings#preferences",
        "/settings#wallet",
        "/settings#keys",
      ]);
    }
  });
});
