import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  fileURLToPath(new URL("./-event-detail-page.tsx", import.meta.url)),
  "utf8",
);
const route = readFileSync(
  fileURLToPath(new URL("./events.$block.$index.tsx", import.meta.url)),
  "utf8",
);
const blockPage = readFileSync(
  fileURLToPath(new URL("./-block-detail-page.tsx", import.meta.url)),
  "utf8",
);
const extrinsicPage = readFileSync(
  fileURLToPath(new URL("./-extrinsic-detail-page.tsx", import.meta.url)),
  "utf8",
);
const streamPage = readFileSync(
  fileURLToPath(new URL("./-chain-stream-page.tsx", import.meta.url)),
  "utf8",
);

describe("event detail route", () => {
  it("resolves one event from the existing lossless per-block record", () => {
    expect(route).toContain('createFileRoute("/events/$block/$index")');
    expect(route).toContain("ensureQueryData(blockChainEventsQuery(params.block))");
    expect(route).toContain("row.event_index === Number(params.index)");
    expect(route).toContain("if (!event) throw notFound()");
  });

  it("validates both coordinates before loading", () => {
    expect(route).toContain("if (!/^\\d+$/.test(raw)) throw notFound()");
    expect(route).toContain("Number.isSafeInteger(value)");
  });

  it("keeps the primary record concise and the full arguments copyable", () => {
    expect(page).toContain("name={label}");
    expect(page).toContain('title="Decoded arguments, identifiers and API"');
    expect(page).toContain("eventArgRows(event?.args)");
    expect(page).toContain("defaultOpen");
    expect(page).toContain("Open extrinsic");
  });

  it("links every raw-event table to the canonical record", () => {
    for (const source of [blockPage, extrinsicPage, streamPage]) {
      expect(source).toContain("rowHref={(row) => eventHref(row) ?? undefined}");
    }
  });
});
