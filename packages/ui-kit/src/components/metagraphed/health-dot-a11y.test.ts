import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HealthDot } from "@/components/metagraphed/chips";

/**
 * #6423, moved here by #11624.
 *
 * Three colour-only status indicators once carried their meaning in an
 * `aria-label` on a plain `<span>`. A span is `role="generic"`, and assistive
 * tech is not required to expose a generic element's `aria-label` as its
 * accessible name — so the health, official-provider and blocked-URL states
 * could announce as nothing at all.
 *
 * All three call sites are gone: the home page's chip marquee with #8249, the
 * subnet dossier's blocked-URL span with #11612, and the providers index's
 * official-provider badge with #11624 — authority is a word in a status cell
 * now, which is the design system's own rule (states are words, never coloured
 * badges). The guard lived in apps/ui and grepped those files' source; with no
 * subject left it would have passed on nothing.
 *
 * It belongs here instead, on the one component that still draws a
 * colour-only indicator, rendered rather than grepped.
 */
describe("HealthDot announces its state", () => {
  it("is role=img with an aria-label, not a bare span", () => {
    const html = renderToStaticMarkup(
      React.createElement(HealthDot, { state: "down" }),
    );
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Health: down"');
  });

  it("labels every state it can render, including the unknown one", () => {
    for (const state of [
      "ok",
      "warn",
      "down",
      "offline",
      "unknown",
      "nonsense",
    ]) {
      const html = renderToStaticMarkup(
        React.createElement(HealthDot, { state }),
      );
      const label = /aria-label="Health: ([^"]+)"/.exec(html)?.[1];
      expect(label, `${state} rendered no label`).toBeTruthy();
      expect(label).not.toBe("");
    }
  });

  it("keeps the label when the dot is drawn beside its word", () => {
    // `variant: "label"` wraps the same dot in a row with the word; the dot
    // must not lose its own accessible name in the process. The label is the
    // state's DISPLAY name -- `warn` reads "degraded", which is the word a
    // reader sees beside it.
    const html = renderToStaticMarkup(
      React.createElement(HealthDot, { state: "warn", variant: "label" }),
    );
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Health: degraded"');
  });
});
