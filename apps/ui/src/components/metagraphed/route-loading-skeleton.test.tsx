import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentLoadingSkeleton } from "./route-loading-skeleton";

describe("DocumentLoadingSkeleton", () => {
  it("preserves the entity hero and primary-ledger geometry without inventing data", () => {
    const html = renderToStaticMarkup(<DocumentLoadingSkeleton label="Loading block detail" />);

    expect(html).toContain('aria-label="Loading block detail"');
    expect(html).toContain("mg-hero--entity");
    expect((html.match(/class="mg-fact"/g) ?? []).length).toBe(3);
    expect(html).toContain('class="mg-dt"');
    expect(html).toContain('data-mobile="cards"');
    expect((html.match(/class="mg-dt-row mg-dt-skeleton"/g) ?? []).length).toBe(8);
    expect(html).not.toContain("mg-block-event-stream");
  });

  it("keeps block navigation beside the block title at small widths", () => {
    const html = renderToStaticMarkup(<DocumentLoadingSkeleton entityKind="block" />);

    expect(html).toContain("mg-hero--block");
  });
});
