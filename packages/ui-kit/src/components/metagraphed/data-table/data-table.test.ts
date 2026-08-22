import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActiveEntityProvider } from "../interaction/active-entity";
import { DataTable, statusTone, type DataTableColumn } from "./data-table";

interface Row {
  id: string;
  name: string;
  stake: number;
  health: string;
  seen: string;
  change: number;
}

const rows: Row[] = [
  {
    id: "5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9",
    name: "Targon",
    stake: 1_890_000,
    health: "ok",
    seen: "2026-08-22T10:00:00Z",
    change: 0.42,
  },
  {
    id: "5CUbyC1234567890abcdefghijklmnopqrstuvwxyzxi2XSG",
    name: "Chutes",
    stake: 351_600,
    health: "degraded",
    seen: "2026-08-21T10:00:00Z",
    change: -0.12,
  },
  {
    id: "5Ev5mQ1234567890abcdefghijklmnopqrstuvwxyz8Pnh9s",
    name: "Affine",
    stake: 169_200,
    health: "down",
    seen: "2026-08-20T10:00:00Z",
    change: 0,
  },
];

const columns: Array<DataTableColumn<Row>> = [
  { key: "name", label: "Subnet", sortable: true, value: (r) => r.name },
  { key: "id", label: "Hotkey", kind: "identifier", value: (r) => r.id },
  {
    key: "stake",
    label: "Stake",
    kind: "number",
    sortable: true,
    value: (r) => r.stake,
  },
  { key: "health", label: "Health", kind: "status", value: (r) => r.health },
  { key: "seen", label: "Last seen", kind: "time", value: (r) => r.seen },
  { key: "change", label: "Δ 7d", kind: "delta", value: (r) => r.change },
  {
    key: "notes",
    label: "Notes",
    demote: true,
    value: () => "hidden by default",
  },
];

const render = (props: Partial<Parameters<typeof DataTable<Row>>[0]> = {}) =>
  renderToStaticMarkup(
    h(
      ActiveEntityProvider,
      null,
      h(DataTable<Row>, {
        rows,
        columns,
        rowKey: (r: Row) => r.id,
        caption: "Validators",
        ...props,
      }),
    ),
  );

describe("DataTable markup", () => {
  it("names itself, counts its rows and labels the table for assistive tech", () => {
    const html = render();
    expect(html).toContain("Validators");
    expect(html).toContain('<span class="mg-dt-count"> (3)</span>');
    expect(html).toMatch(/<table aria-labelledby="[^"]+"/);
    expect(html).toMatch(/<p id="[^"]+" class="mg-dt-title"/);
  });

  it("renders every row on the server, so a crawler sees the whole list", () => {
    expect((render().match(/class="mg-dt-row"/g) ?? []).length).toBe(3);
  });

  it("hides demoted columns until the reader asks for them", () => {
    const html = render();
    expect(html).toContain(">Subnet<");
    expect(html).not.toContain(">Notes<");
    expect(html).not.toContain("hidden by default");
  });

  it("gives sortable headers a button and an aria-sort, and leaves the rest plain", () => {
    const html = render({
      sort: { key: "stake", dir: "desc" },
      onSort: () => {},
    });
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain('class="mg-dt-sort" data-active="true"');
    expect((html.match(/class="mg-dt-sort"/g) ?? []).length).toBe(2);
    expect(html).toContain('<th scope="col">Health</th>');
  });

  it("renders each kind in its own shape", () => {
    const html = render();
    expect(html).toContain("5GsbTg…SFpZX9");
    expect(html).toContain(
      'title="5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9"',
    );
    expect(html).toContain('<span class="mg-dt-status" data-tone="good">');
    expect(html).toContain('<span class="mg-dt-status" data-tone="bad">');
    expect(html).toContain(
      '<span class="mg-dt-delta" data-state="up">+42%</span>',
    );
    expect(html).toContain(
      '<span class="mg-dt-delta" data-state="down">−12%</span>',
    );
    expect(html).toContain("1,890,000");
    expect(html).toContain('data-align="right"');
  });

  it("carries a per-cell label, which is what the mobile cards print", () => {
    const html = render();
    expect(html).toContain('data-label="Stake"');
    expect(html).toContain('data-mobile="cards"');
    expect(render({ mobile: "scroll" })).toContain('data-mobile="scroll"');
  });

  it("makes the first cell the row's link so a row is one tab stop", () => {
    const html = render({ rowHref: (r: Row) => `/validators/${r.id}` });
    expect((html.match(/class="mg-dt-rowlink"/g) ?? []).length).toBe(3);
    expect(html).toContain(
      'href="/validators/5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9"',
    );
  });

  it("routes every link through the caller's Link, not a bare anchor", () => {
    // The row link and a `kind: "link"` cell both have to reach the router;
    // a bare <a> would navigate with a full page load and drop the router's
    // cache and scroll restoration.
    const Router = ({
      href,
      children,
      ...rest
    }: {
      href: string;
      children: unknown;
    }) => h("a", { ...rest, href, "data-router": "true" }, children as never);
    const html = renderToStaticMarkup(
      h(
        ActiveEntityProvider,
        null,
        h(DataTable<Row>, {
          rows,
          rowKey: (r: Row) => r.id,
          caption: "Validators",
          link: Router,
          rowHref: (r: Row) => `/validators/${r.id}`,
          columns: [
            { key: "name", label: "Subnet", value: (r: Row) => r.name },
            {
              key: "link",
              label: "Profile",
              kind: "link",
              value: (r: Row) => r.name,
              href: (r: Row) => `/subnets/${r.name}`,
            },
          ],
        }),
      ),
    );
    // Three row links + three cell links, every one of them the router's.
    expect((html.match(/data-router="true"/g) ?? []).length).toBe(6);
    expect(html).not.toMatch(/<a (?![^>]*data-router)/);
  });

  it("shows the empty state instead of rows, and the error state instead of both", () => {
    expect(render({ rows: [], empty: "No validators" })).toMatch(
      /<tr class="mg-dt-state"><td colSpan="6">No validators<\/td><\/tr>/i,
    );
    expect(
      render({ rows: [], empty: "No validators", error: "Request failed" }),
    ).toContain("Request failed");
  });

  it("renders skeleton rows while loading", () => {
    const html = render({ loading: true });
    expect((html.match(/class="mg-dt-skeleton"/g) ?? []).length).toBe(8);
    expect(html).not.toContain("Targon");
  });

  it("pages only when there is more than one page, and states the range", () => {
    expect(render()).not.toContain("mg-dt-footer");
    const paged = render({ pageSize: 2 });
    expect(paged).toContain("1–2 of 3");
    expect(paged).toContain('aria-current="page"');
    expect((paged.match(/class="mg-dt-row"/g) ?? []).length).toBe(2);
    // An index that must stay crawlable opts out and keeps every row.
    const all = render({ pageSize: 2, paginate: false });
    expect((all.match(/class="mg-dt-row"/g) ?? []).length).toBe(3);
    expect(all).not.toContain("mg-dt-footer");
  });

  it("sorts itself when no one else owns the sort", () => {
    const html = render({ pageSize: 1 });
    // Incoming order, untouched.
    expect(html).toContain("Targon");
    expect(html).not.toContain("Affine");
  });
});

describe("expandable rows (#8821)", () => {
  const expandable = (extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      h(
        ActiveEntityProvider,
        null,
        h(DataTable<Row>, {
          rows,
          columns: [
            { key: "name", label: "Subnet", value: (r: Row) => r.name },
          ],
          rowKey: (r: Row) => r.id,
          caption: "Validators",
          expand: (r: Row) => `detail for ${r.name}`,
          ...extra,
        }),
      ),
    );

  it("puts the disclosure on a real button, never on the <tr>", () => {
    const html = expandable();
    // A <tr> cannot take focus, so a row-level toggle would be mouse-only —
    // and aria-expanded is invalid on the implicit row role.
    expect(html).not.toMatch(/<tr[^>]*aria-expanded/);
    expect(
      (
        html.match(
          /<button type="button" class="mg-dt-rowbutton" aria-expanded="false"/g,
        ) ?? []
      ).length,
    ).toBe(3);
    expect(html).toContain('data-expandable="true"');
  });

  it("points aria-controls at the expansion row only while it exists", () => {
    // Collapsed: nothing to point at, so no dangling aria-controls.
    expect(expandable()).not.toContain("aria-controls");
    expect(expandable()).not.toContain("mg-dt-expansion");
  });
});

describe("statusTone", () => {
  it("maps the vocabulary the API actually uses", () => {
    expect(statusTone("OK")).toBe("good");
    expect(statusTone("degraded")).toBe("warn");
    expect(statusTone("down")).toBe("bad");
    expect(statusTone("whatever")).toBe("muted");
  });
});
