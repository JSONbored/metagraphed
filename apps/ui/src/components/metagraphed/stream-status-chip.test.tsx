import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StreamStatusChip } from "./stream-status-chip";

describe("StreamStatusChip", () => {
  // #8365: idle used to render nothing at all (`renderToStaticMarkup` -> "").
  // It now always renders the same DOM shape -- fixed width, `invisible` --
  // so a later transition to connecting/open/error never shifts a sibling
  // sharing the row. Content is still absent from the a11y tree, matching
  // the old contract's actual intent ("nothing meaningful to announce yet").
  it("renders an invisible, space-reserving chip for idle status", () => {
    const html = renderToStaticMarkup(<StreamStatusChip status="idle" />);
    expect(html).not.toBe("");
    expect(html).toContain("invisible");
    expect(html).toContain('data-stream-status="idle"');
  });

  it("renders the same invisible placeholder for closed status", () => {
    const html = renderToStaticMarkup(<StreamStatusChip status="closed" />);
    expect(html).toContain("invisible");
    expect(html).toContain('data-stream-status="closed"');
  });

  it("renders Live with the pulsing dot when open", () => {
    const html = renderToStaticMarkup(<StreamStatusChip status="open" testId="x" />);
    expect(html).toContain("Live");
    expect(html).toContain("mg-live-dot");
    expect(html).toContain('data-stream-status="open"');
    expect(html).toContain('data-testid="x"');
  });

  it("renders Connecting/Polling with the dot slot present but invisible", () => {
    // #8365: the dot element itself is now ALWAYS in the markup (reserving
    // its width) -- only its own visibility toggles, so `mg-live-dot`
    // appearing in the HTML is no longer a signal of "open" on its own; the
    // dot's own `invisible` class is the actual visibility switch.
    const connecting = renderToStaticMarkup(<StreamStatusChip status="connecting" />);
    expect(connecting).toContain("Connecting");
    expect(connecting).toContain("mg-live-dot");
    expect(connecting).toMatch(/mg-live-dot[^"]*invisible/);

    const errored = renderToStaticMarkup(<StreamStatusChip status="error" />);
    expect(errored).toContain("Polling");
    expect(errored).toContain("mg-live-dot");
    expect(errored).toMatch(/mg-live-dot[^"]*invisible/);
  });

  it("the open chip's dot has no invisible class", () => {
    const html = renderToStaticMarkup(<StreamStatusChip status="open" />);
    expect(html).not.toMatch(/mg-live-dot[^"]*invisible/);
  });

  it("every status shares the same min-width class, so the chip's own footprint never changes", () => {
    for (const status of ["idle", "connecting", "open", "error", "closed"] as const) {
      expect(renderToStaticMarkup(<StreamStatusChip status={status} />)).toContain(
        "min-w-[6.5rem]",
      );
    }
  });
});
