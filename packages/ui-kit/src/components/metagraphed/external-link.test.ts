import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExternalLink, safeExternalUrl } from "./external-link";

describe("safeExternalUrl", () => {
  it("allows ordinary public http(s) URLs", () => {
    expect(safeExternalUrl("https://example.com/path?q=1")).toBe(
      "https://example.com/path?q=1",
    );
    expect(safeExternalUrl("http://docs.example.com/")).toBe(
      "http://docs.example.com/",
    );
  });

  it("blocks non-http schemes and credentialed URLs", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeExternalUrl("data:text/html,hi")).toBeUndefined();
    expect(safeExternalUrl("https://user:pass@example.com/")).toBeUndefined();
  });

  it("blocks private, reserved, and local host targets", () => {
    const unsafe = [
      "http://localhost/",
      "http://service.local/",
      "http://0.0.0.0/",
      "http://10.0.0.1/",
      "http://100.64.0.1/",
      "http://127.0.0.1/",
      "http://169.254.169.254/",
      "http://172.16.0.1/",
      "http://192.0.2.1/",
      "http://192.168.0.1/",
      "http://198.18.0.1/",
      "http://198.51.100.1/",
      "http://203.0.113.1/",
      "http://224.0.0.1/",
      "http://[::1]/",
      "http://[::ffff:7f00:1]/",
      "http://[fc00::1]/",
      "http://[fe80::1]/",
      "http://[ff02::1]/",
    ];

    for (const href of unsafe) {
      expect(safeExternalUrl(href), href).toBeUndefined();
    }
  });
});

describe("ExternalLink children wrapper", () => {
  // The anchor is `inline-flex`, so its direct children are flex items. The
  // span wrapping `children` needs `min-w-0` or it keeps the flex default
  // `min-width: auto` -- refusing to shrink below its content's natural
  // width regardless of any `truncate`/`min-w-0`/`flex-1` the caller puts on
  // an element *inside* that span, since flex sizing is about the span
  // itself, not its descendants. Without this, long link text/labels escape
  // the viewport at narrow widths (#8537) even when the caller did
  // everything right on their own side.
  it("gives the wrapping span both min-w-0 and truncate so long children shrink instead of escaping", () => {
    const html = renderToStaticMarkup(
      React.createElement(ExternalLink, {
        href: "https://example.com",
        children:
          "a very long label that should truncate instead of overflowing its flex container",
      }),
    );
    const match = html.match(/<span class="([^"]*)">/);
    expect(match?.[1]).toContain("min-w-0");
    expect(match?.[1]).toContain("truncate");
  });
});
