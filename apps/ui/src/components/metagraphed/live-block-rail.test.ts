import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./live-block-rail.tsx", import.meta.url)),
  "utf8",
);

describe("live block rail intent prefetch", () => {
  it("aligns the route record preload and primary ledger warm behind sustained reader intent", () => {
    expect(source).toContain(
      "blockExtrinsicsInfiniteQuery(String(blockNumber), BLOCK_EXTRINSIC_PAGE_SIZE)",
    );
    expect(source).toContain("preloadDelay={140}");
    expect(source).toContain("}, 140);");
    expect(source).toContain('event.pointerType === "mouse"');
    expect(source).not.toContain("blockChainEventsQuery");
  });

  it("cancels a passing hover or focus change before it starts network work", () => {
    expect(source).toContain("onPointerLeave={clearIntent}");
    expect(source).toContain("onBlur={clearIntent}");
    expect(source).toContain("window.clearTimeout(intentTimer.current)");
  });
});
