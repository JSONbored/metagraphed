import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #8821: grouped Activity rows toggled expand/collapse only via a plain
// `<tr onClick>`, with `aria-expanded` set directly on the row -- invalid,
// since a `<tr>`'s implicit `row` role doesn't support that attribute, and
// unreachable by keyboard since nothing in the row was focusable. Per this
// repo's convention (see subnets-activity-entrance-animation.test.ts), the
// route only renders inside the full app shell + router + suspense data, so
// the wiring is asserted on source rather than rendered output.

const source = readFileSync(
  fileURLToPath(new URL("./-subnets-netuid-page.tsx", import.meta.url)),
  "utf8",
);

function activityGroupRowSource(): string {
  const start = source.indexOf("function ActivityGroupRow(");
  const end = source.indexOf("function ActivityTableLoader(");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("subnet-activity grouped-row keyboard toggle (#8821)", () => {
  it("no longer puts aria-expanded on the group's <tr> (invalid on an implicit row role)", () => {
    const groupRow = activityGroupRowSource();
    const trOpenTag = groupRow.slice(
      groupRow.indexOf("<tr"),
      groupRow.indexOf(">", groupRow.indexOf("<tr")) + 1,
    );
    expect(trOpenTag).not.toContain("aria-expanded");
    expect(trOpenTag).not.toContain("role=");
  });

  it("wraps the disclosure chevron in a real focusable button bound to onToggle", () => {
    const groupRow = activityGroupRowSource();
    expect(groupRow).toContain('<button\n              type="button"');
    expect(groupRow).toContain("onToggle();");
  });

  it("the button carries aria-expanded and a meaningful aria-label", () => {
    const groupRow = activityGroupRowSource();
    const buttonStart = groupRow.indexOf("<button");
    const buttonOpenTag = groupRow.slice(buttonStart, groupRow.indexOf("</button>", buttonStart));
    expect(buttonOpenTag).toContain("aria-expanded={expanded}");
    expect(buttonOpenTag).toContain("aria-label={");
    expect(buttonOpenTag).toMatch(/Collapse.*Expand|Expand.*Collapse/s);
  });

  it("wires aria-controls to ids shared with the expanded child rows", () => {
    const groupRow = activityGroupRowSource();
    expect(groupRow).toContain("aria-controls={childRowIds}");
    expect(groupRow).toContain("const groupId = ");
    expect(groupRow).toContain("const childRowIds = ");
    // the nested rows below carry matching ids derived from the same groupId
    expect(groupRow).toContain("id={`${groupId}-row-${i}`}");
  });

  it("stops the button click from double-firing the row's own toggle", () => {
    const groupRow = activityGroupRowSource();
    const buttonStart = groupRow.indexOf("<button");
    const buttonBlock = groupRow.slice(buttonStart, groupRow.indexOf("</button>", buttonStart));
    expect(buttonBlock).toContain("e.stopPropagation()");
  });

  it("leaves the single-event fast path untouched (no button on a group of one)", () => {
    const groupRow = activityGroupRowSource();
    expect(groupRow).toContain(
      "if (group.events.length === 1) {\n    return <ActivityEventRow ev={group.events[0]!} isNew={isNew} />;\n  }",
    );
  });

  it("keeps the row's own onClick for mouse users", () => {
    const groupRow = activityGroupRowSource();
    expect(groupRow).toContain("onClick={onToggle}");
  });
});
