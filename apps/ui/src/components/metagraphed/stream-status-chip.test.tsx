import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StreamStatusChip } from "./stream-status-chip";

describe("StreamStatusChip", () => {
  it("renders nothing for idle status", () => {
    expect(renderToStaticMarkup(<StreamStatusChip status="idle" />)).toBe("");
  });

  it("renders Live with the pulsing dot when open", () => {
    const html = renderToStaticMarkup(<StreamStatusChip status="open" testId="x" />);
    expect(html).toContain("Live");
    expect(html).toContain("mg-live-dot");
    expect(html).toContain('data-stream-status="open"');
    expect(html).toContain('data-testid="x"');
  });

  it("renders Connecting/Polling without the dot for non-open statuses", () => {
    const connecting = renderToStaticMarkup(<StreamStatusChip status="connecting" />);
    expect(connecting).toContain("Connecting");
    expect(connecting).not.toContain("mg-live-dot");

    const errored = renderToStaticMarkup(<StreamStatusChip status="error" />);
    expect(errored).toContain("Polling");
    expect(errored).not.toContain("mg-live-dot");
  });
});
