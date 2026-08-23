// The props of every v2 primitive, as data, for the tables on
// /design/primitives (#11627).
//
// Read off each component's own TypeScript interface in
// `packages/ui-kit/src/components/metagraphed/**` -- one row per declared
// prop, including the ones a caller rarely passes, because the point of the
// page is that a reader never has to open the component to find out what it
// takes. `required` is the interface's own optionality (`prop?:` is not
// required); `default` is stated in the description when the implementation
// gives one.

export interface PropRow {
  /** `${component}.${prop}` -- unique across a section. */
  key: string;
  component: string;
  prop: string;
  type: string;
  required: boolean;
  what: string;
}

/** [prop, type, required, what] */
type Spec = readonly [string, string, boolean, string];

function props(component: string, specs: readonly Spec[]): PropRow[] {
  return specs.map(([prop, type, required, what]) => ({
    key: `${component}.${prop}`,
    component,
    prop,
    type,
    required,
    what,
  }));
}

export const DOCUMENT_PROPS: PropRow[] = [
  ...props("AnalyticsSection", [
    ["id", "string", true, "Anchor target; SectionNav scrolls to it."],
    ["name", "ReactNode", true, "The subject, set 600. A string gets a full stop added."],
    ["question", "ReactNode", false, "What it tells you, one sentence at the same size."],
    ["visual", "ReactNode", false, "The visual. Renders first, at full width."],
    ["legend", "ReactNode", false, "A RankGrid, or nothing."],
    ["footnote", "ReactNode", false, "`window · source`, one 11px muted line."],
    ["controls", "ReactNode", false, "One RangeControl, right of the heading."],
    ["children", "ReactNode", false, "Content that is not yet a `visual` (a route mid-migration)."],
    ["className", "string", false, "Appended to `.mg-section`."],
  ]),
  ...props("AnalyticsPage", [
    ["hero", "ReactNode", false, "The EntityHero, rendered above the nav."],
    ["children", "ReactNode", true, "AnalyticsSection elements. More than 7 throws in dev."],
    [
      "sections",
      "readonly SectionNavItem[]",
      false,
      "The nav, stated rather than inferred from children.",
    ],
    ["className", "string", false, "Appended to `.mg-page`."],
  ]),
  ...props("SectionNav", [
    ["items", "readonly SectionNavItem[]", true, "`{ id, name, href?, current? }` per section."],
    ["link", "SectionNavLink", false, "Renders `href` items; defaults to a plain `<a>`."],
    ["className", "string", false, "Appended to `.mg-section-nav`."],
  ]),
];

export const HERO_PROPS: PropRow[] = props("EntityHero", [
  ["crumbs", "readonly Crumb[]", false, "`{ label, href? }` chips above the name."],
  ["name", "ReactNode", true, "The 40px h1."],
  ["avatar", "ReactNode", false, "A 40px, 4px-radius mark left of the name."],
  ["action", "ReactNode", false, "The one primary action, styled by `.mg-hero-action`."],
  ["secondary", "ReactNode", false, "Secondary icon actions (watch, share)."],
  ["sentence", "ReactNode", false, "The FactSentence."],
  ["cells", "FactCells", false, "2–6 cells; renders a FactStrip."],
  ["facts", "ReactNode", false, "A composed FactStrip, for a route mapping legacy KPI arrays."],
  ["live", "LiveMetaProps", false, "Renders the page's one LiveMeta."],
  ["className", "string", false, "Appended to `.mg-hero`."],
]);

export const FACT_PROPS: PropRow[] = [
  ...props("FactSentence", [
    ["children", "ReactNode", true, "The sentence; facts inside it are `<Fact>` chips."],
    ["className", "string", false, "Appended to `.mg-fact-sentence`."],
  ]),
  ...props("Fact", [
    ["children", "ReactNode", true, "The fact — a number, a state word, a count."],
    ["className", "string", false, "Appended to `.mg-fact-chip`."],
  ]),
  ...props("FactStrip", [
    ["cells", "FactCells", false, "2–6 cells, enforced by the tuple type."],
    ["children", "ReactNode", false, "Composed `<FactCell>`s instead of `cells`."],
    ["variant", '"row" | "grid"', false, 'Default "row"; "grid" is the 3×2 six-number variant.'],
    ["className", "string", false, "Appended to `.mg-facts`."],
  ]),
  ...props("FactCell", [
    ["label", "string", true, "11px muted label."],
    ["value", "ReactNode", true, "28px mono 500, tabular."],
    [
      "delta",
      '{ text, tone: "good" | "bad" | "neutral" }',
      false,
      "A signed change right of the value.",
    ],
    ["hint", "ReactNode", false, "A string mounts a Definition beside the label."],
    ["className", "string", false, "Appended to `.mg-fact`."],
  ]),
];

export const LIVE_META_PROPS: PropRow[] = props("LiveMeta", [
  ["updatedAt", "string | null", false, "ISO timestamp of the data behind the page."],
  ["onRefresh", "() => void", false, "Adds the `refresh` button; omitted, there is none."],
  ["refreshing", "boolean", false, "Disables the button and reads `refreshing…`."],
  ["source", "string", false, 'One word: "chain", "registry", "probe".'],
  ["className", "string", false, "Appended to `.mg-live-meta`."],
]);

export const RANGE_PROPS: PropRow[] = props("RangeControl", [
  ["options", "readonly RangeOption<V>[]", true, "`{ value, label }`; 2–4 of them."],
  ["value", "V", true, "The selected option's value."],
  ["onChange", "(value: V) => void", true, "Fires on click and on arrow-key selection."],
  ["label", "string", true, 'Accessible name of the radiogroup, e.g. "Window".'],
  ["className", "string", false, "Appended to `.mg-range`."],
]);

export const RAW_PROPS: PropRow[] = [
  ...props("Raw", [
    ["title", "string", false, 'Summary text; defaults to "Raw identifiers & sources".'],
    ["rows", "readonly RawRow[]", false, "The identifier rows; defaults to none."],
    ["children", "ReactNode", false, "Code blocks (`RawCode`) and anything else behind the fold."],
    ["defaultOpen", "boolean", false, "Start open — specimens and tests."],
    ["id", "string", false, "Anchor target on the `<details>`."],
    ["className", "string", false, "Appended to `.mg-raw`."],
  ]),
  ...props("RawRow", [
    ["label", "string", true, "The `<dt>`."],
    ["value", "string", true, "Rendered in full, wrapping, never truncated."],
    ["href", "string", false, "Links the value."],
    ["copyLabel", "string", false, "Accessible label for the copy button; defaults to `label`."],
  ]),
  ...props("RawCode", [
    ["children", "string", true, "The snippet. A string, not nodes — it is copied verbatim."],
    ["label", "string", false, "Accessible name and copy-button label."],
  ]),
];

export const INTERACTION_PROPS: PropRow[] = [
  ...props("ActiveEntityProvider", [
    ["children", "ReactNode", true, "One provider per route holds at most one active key."],
  ]),
  ...props("useEntityMark(key, opts)", [
    ["key", "string", true, "The entity key every mark of this entity shares."],
    ["opts.source", "string", false, 'Which surface set it; defaults to "mark".'],
    ["opts.label", "string", false, "Accessible name; defaults to the key."],
    ["opts.data", "ActiveEntityData", false, "`{ title, total?, rows?, note? }` for ChartTooltip."],
    ["opts.onActivate", "() => void", false, "Click, Enter/Space, or a second tap when pinned."],
    ["opts.disabled", "boolean", false, "Inert mark: no highlight, out of the roving order."],
  ]),
  ...props("ChartTooltip", [
    ["top", 'number | "mark"', false, '110px into the container, or "mark" to follow the row.'],
    ["offsetLeft", "number", false, "Pins the horizontal position instead of floating."],
    [
      "fallback",
      "(key: string) => ActiveEntityData | null",
      false,
      "Content when the mark registered none.",
    ],
    ["className", "string", false, "Appended to `.mg-chart-tooltip`."],
  ]),
  ...props("Definition", [
    ["term", "string", true, "Looked up in the app's glossary."],
    ["sentence", "string", false, "Overrides the glossary sentence."],
    ["align", '"start" | "end"', false, 'Default "start"; "end" opens leftwards at a right edge.'],
    ["children", "ReactNode", false, "A custom trigger instead of the 16×16 “?”."],
    ["className", "string", false, "Appended to `.mg-definition`."],
  ]),
  ...props("DefinitionsProvider", [
    ["definitions", "Readonly<Record<string, string>>", true, "The glossary, mounted once."],
    ["children", "ReactNode", true, "The subtree that may use `<Definition>`."],
  ]),
];

export const DATA_TABLE_PROPS: PropRow[] = [
  ...props("DataTable", [
    ["rows", "readonly Row[]", true, "The rows for this page of the result."],
    ["columns", "ReadonlyArray<DataTableColumn<Row>>", true, "Column definitions, in order."],
    ["rowKey", "(row: Row) => string", true, "Stable key; also the entity key of the row mark."],
    ["caption", "string", true, "Names the table and the CSV file."],
    ["captionHidden", "boolean", false, "Keeps the caption for assistive tech only."],
    ["total", "number", false, "The full result size when it is larger than `rows`."],
    ["sort", "SortState | null", false, "Controlled sort; omit both to let the table sort itself."],
    ["onSort", "(sort: SortState | null) => void", false, "Controlled-sort handler."],
    ["page", "number", false, "Controlled page; omit both to let the table page itself."],
    ["onPage", "(page: number) => void", false, "Controlled-paging handler."],
    ["pageSize", "number", false, "Rows per page; defaults to 50."],
    ["pageSizes", "readonly number[]", false, "Choices offered in the menu; needs `onPageSize`."],
    ["onPageSize", "(size: number) => void", false, "Without it the size control is left out."],
    ["paginate", "boolean", false, "`false` renders every row (a crawlable index)."],
    ["rowHref", "(row: Row) => string | undefined", false, "Whole-row link."],
    ["link", "SectionNavLink", false, "Renders row links; pass the app's router Link."],
    ["onRowActivate", "(row: Row) => void", false, "Click / Enter on a row that has no href."],
    ["expand", "(row: Row) => ReactNode", false, "Rendered under a row when it is expanded."],
    ["search", "{ value, onChange, placeholder? }", false, "The search box in the caption row."],
    ["filters", "ReactNode", false, "At most three; more belong behind the menu."],
    ["loading", "boolean", false, "Skeleton rows instead of content."],
    ["empty", "ReactNode", false, "Shown instead of rows when there are none."],
    ["error", "ReactNode", false, "Shown instead of rows when the query failed."],
    ["dense", "boolean", false, "Shorter rows for a long list."],
    ["mobile", '"cards" | "scroll"', false, "Forces the sub-640px mode instead of measuring it."],
    ["source", "string", false, 'Entity-mark namespace; defaults to "table".'],
    ["storageKey", "string", false, "Persists the column selection; omit to keep it per-mount."],
    ["shareUrl", "string", false, 'Copied by the menu\'s "Copy link"; defaults to the URL.'],
    ["id", "string", false, "Anchor target on the table root."],
    ["className", "string", false, "Appended to `.mg-dt`."],
  ]),
  ...props("DataTableColumn", [
    ["key", "string", true, "Column id; also the sort key and the CSV header."],
    ["label", "string", true, "The 10px uppercase header."],
    ["align", '"left" | "right"', false, "Overrides the kind's own alignment."],
    ["width", "number | string", false, "Fixed column width."],
    ["sortable", "boolean", false, "Adds the sort control to the header."],
    ["demote", "boolean", false, "Hidden until the reader turns it on in the menu."],
    [
      "kind",
      '"text" | "number" | "identifier" | "status" | "time" | "delta" | "link" | "tint"',
      false,
      "Picks the cell's formatting and alignment.",
    ],
    [
      "value",
      "(row: Row) => CellValue",
      false,
      "The sortable / exportable / default-rendered value.",
    ],
    ["format", "(value: CellValue, row: Row) => string", false, "Formats `value` for display."],
    ["render", "(row: Row) => ReactNode", false, "Full control of the cell."],
    ["href", "(row: Row) => string | undefined", false, '`kind: "link"` — where the text points.'],
    ["tint", "(row: Row) => number | null", false, '`kind: "tint"` — 0…1, paints the background.'],
    ["definition", "string", false, "A glossary term; renders a “?” after the header label."],
  ]),
];

export const TEMPORAL_PROPS: PropRow[] = [
  ...props("StackedColumns", [
    ["columns", "readonly StackedColumn[]", true, "`{ key, label, axisLabel?, total, segments }`."],
    ["seriesOrder", "readonly string[]", true, "Which series take a swatch; the rest collapse."],
    ["registry", "SeriesPaletteRegistry", false, "Shared palette so a key keeps its colour."],
    ["other", "string", false, 'Label for the collapsed residual; defaults to "Other".'],
    ["formatValue", "(value: number) => string", false, "Tooltip and table formatting."],
    ["ariaLabel", "string", true, "Group name and the hidden table's caption."],
    ["columnSource", "string", false, 'Entity namespace for columns; default "stacked-columns".'],
    ["id", "string", false, "Anchor target on the chart root."],
    ["className", "string", false, "Appended to `.mg-stack`."],
  ]),
  ...props("LineWithWindow", [
    ["points", "readonly LinePoint[]", true, "`{ t, v }`, the full history."],
    ["window", "LineWindow", true, "The `{ from, to }` re-drawn in the accent."],
    ["unit", "string", true, 'What the series counts: "tokens", "TAO".'],
    ["formatValue", "(value: number) => string", false, "Summary, tooltip and table formatting."],
    ["formatDate", "(t: number) => string", false, 'Point label; defaults to an en-US "AUG 22".'],
    ["formatRange", "(from: number, to: number) => string", false, "The window extent's label."],
    ["ariaLabel", "string", true, "Group name and the hidden table's caption."],
    ["keyOf", "(point: LinePoint) => string", false, "Entity key; defaults to `${source}:${t}`."],
    ["source", "string", false, 'Entity namespace; defaults to "line".'],
    ["compact", "boolean", false, "120px plot, no summary, no months row."],
    ["marker", "number", false, "A `t` to rule vertically — the subject the window is about."],
    ["markerLabel", "string", false, "Accessible name for the marker rule; required with it."],
    ["id", "string", false, "Anchor target on the chart root."],
    ["className", "string", false, "Appended to `.mg-line`."],
  ]),
];

export const RANK_PROPS: PropRow[] = [
  ...props("RankedRails", [
    ["items", "readonly RankedRailItem[]", true, "`{ key, label, value, secondary?, detail? }`."],
    ["formatValue", "(value: number) => string", true, "The leading value column."],
    ["formatSecondary", "(value: number) => string", false, "The second track; defaults to above."],
    ["scale", '"linear" | "sqrt"', false, 'Default "linear"; "sqrt" for heavy tails.'],
    ["max", "number", false, "Pins the scale; defaults to the largest value."],
    [
      "secondaryScale",
      '"shared" | "own"',
      false,
      'Default "shared"; "own" when the two series are not commensurate.',
    ],
    ["columns", "{ value, name, track, secondary? }", false, "Header labels; omitted = no header."],
    ["limit", "number", false, 'Rows before "Show all"; defaults to 10.'],
    ["ariaLabel", "string", true, "Group name for the rows."],
    ["source", "string", false, 'Entity namespace; defaults to "ranked-rails".'],
    ["onActivate", "(item: RankedRailItem) => void", false, "Click / Enter on a row."],
    ["className", "string", false, "Appended to `.mg-rails`."],
  ]),
  ...props("MarkerRail", [
    ["items", "readonly MarkerRailItem[]", true, "`{ key, label, value, tag?, href? }`."],
    ["max", "number", false, "The rail's upper bound; defaults to 100."],
    ["formatValue", "(value: number) => string", true, "The ratio column."],
    [
      "columns",
      "{ ratio, name, scale }",
      true,
      "Header labels — always shown, so the scale is stated.",
    ],
    ["ariaLabel", "string", true, "Group name for the rows."],
    ["source", "string", false, 'Entity namespace; defaults to "marker-rail".'],
    ["onActivate", "(item: MarkerRailItem) => void", false, "Click / Enter on a row."],
    ["className", "string", false, "Appended to `.mg-marker-rail`."],
  ]),
  ...props("RankGrid", [
    ["items", "readonly RankGridItem[]", true, "`{ key, label, value?, share?, swatch?, href? }`."],
    ["cols", "3 | 4 | 5", false, "Columns at 1280; defaults to 4. 2 at 768, 1 at 375."],
    ["ariaLabel", "string", true, 'Group name; each row reads "{label} · {value} total".'],
    ["source", "string", false, 'Entity namespace; defaults to "rank-grid".'],
    ["start", "number", false, "Rank numbering starts here; defaults to 1."],
    ["onActivate", "(item: RankGridItem) => void", false, "Click / Enter on a row with no href."],
    ["className", "string", false, "Appended to `.mg-rank-grid`."],
  ]),
  ...props("LeaderCards", [
    ["items", "readonly LeaderCardItem[]", true, "`{ key, name, sub?, value, delta?, href }`."],
    ["featured", "number", false, "How many lead as 154px cards; defaults to 3."],
    ["ariaLabel", "string", true, "Group name for the cards."],
    ["source", "string", false, 'Entity namespace; defaults to "leader-cards".'],
    ["className", "string", false, "Appended to `.mg-leaders`."],
  ]),
  ...props("CompositionBreakdown", [
    ["segments", "readonly CompositionSegment[]", true, "`{ key, label, value, href? }`."],
    ["registry", "SeriesPaletteRegistry", false, "Shared palette so a key matches every chart."],
    ["formatValue", "(value: number) => string", true, "The legend's value column."],
    ["limit", "number", false, "Collapse past this many series; defaults to the palette size."],
    ["other", "string", false, 'Label for the residual; defaults to "Other".'],
    ["legendCols", "3 | 4 | 5", false, "Columns of the RankGrid legend; defaults to 4."],
    ["ariaLabel", "string", true, "Group name for the bar and its legend."],
    ["source", "string", false, 'Entity namespace; defaults to "composition".'],
    ["onActivate", "(key: string) => void", false, "Click / Enter on a legend row."],
    ["className", "string", false, "Appended to `.mg-composition`."],
  ]),
];

export const COMPARE_PROPS: PropRow[] = [
  ...props("CompareLedger", [
    ["entities", "readonly CompareEntity[]", true, "Two or three; one column each."],
    ["groups", "readonly CompareGroup[]", true, "`{ label, rows }` — one row per fact."],
    ["highlightBest", "boolean", false, "Tints the winning cell; defaults to true."],
    ["ariaLabel", "string", true, "The table's accessible name."],
    ["className", "string", false, "Appended to `.mg-compare`."],
  ]),
  ...props("CompareEntity", [
    ["key", "string", true, "Column id."],
    ["name", "string", true, "The column head."],
    ["sub", "string", false, "Operator, domain, netuid — whatever qualifies the name."],
    ["href", "string", false, "Links the name."],
    ["avatar", "ReactNode", false, "A mark left of the name."],
    ["onChange", "() => void", false, "Swaps this entity out; renders a control in the head."],
  ]),
  ...props("CompareRow", [
    ["key", "string", true, "Row id."],
    ["label", "string", true, "The row header."],
    [
      "values",
      "ReadonlyArray<number | string | null>",
      true,
      'One entry per entity, in `entities` order; `null` renders as "—".',
    ],
    ["better", '"high" | "low"', false, "Which direction wins. Omit for a row with no winner."],
    ["format", "(value: number | string) => string", false, "Formats each cell."],
    ["spark", "ReadonlyArray<ReactNode | null>", false, "A chart under the value, per entity."],
  ]),
];

export const FILTER_PROPS: PropRow[] = [
  ...props("FilterField", [
    ["label", "string", true, "The 10px muted field label."],
    ["htmlFor", "string", false, "Points the label at a control it does not wrap."],
    ["hint", "ReactNode", false, "Rendered after the label at 70% opacity."],
    ["children", "ReactNode", true, "The control."],
    ["grow", "boolean", false, "Lets the field fill the remaining row (search inputs)."],
    ["className", "string", false, "Appended to the label."],
  ]),
  ...props("FilterInput", [
    ["leadingIcon", "boolean", false, "The search glyph inside the field; defaults to true."],
    [
      "…",
      "InputHTMLAttributes<HTMLInputElement>",
      false,
      "Everything else is a native input prop.",
    ],
  ]),
  ...props("FilterSelect", [
    ["children", "ReactNode", false, "The `<option>`s."],
    [
      "…",
      "SelectHTMLAttributes<HTMLSelectElement>",
      false,
      "Everything else is a native select prop.",
    ],
  ]),
  ...props("LoadMore", [
    ["hasMore", "boolean", true, 'False renders "end of list" instead of the button.'],
    ["isLoading", "boolean", true, "Replaces the row with three skeletons."],
    ["onLoadMore", "() => void", true, "Fetches the next page; also the retry handler."],
    ["shown", "number", true, "How many rows are loaded."],
    ["total", "number", false, 'Renders as "shown of total".'],
    ["error", "Error | null", false, "Renders the inline retry strip."],
    ["cursorInvalid", "boolean", false, "Stops paging and says why — an untrustworthy cursor."],
  ]),
];

export const COPY_PROPS: PropRow[] = props("CopyableCode", [
  ["value", "string", true, "The text copied to the clipboard, shown as `<code>`."],
  ["label", "string", false, "A muted prefix inside the chip and the copy announcement."],
  ["truncate", "boolean", false, "Defaults to true; false wraps from 640px up instead."],
  ["className", "string", false, "Appended to the button."],
]);

export const SHEET_PROPS: PropRow[] = [
  ...props("Sheet", [
    ["open", "boolean", false, "Controlled open state (Radix Dialog root)."],
    ["onOpenChange", "(open: boolean) => void", false, "Controlled-state handler."],
    ["children", "ReactNode", true, "A SheetTrigger and a SheetContent."],
  ]),
  ...props("SheetTrigger", [
    ["asChild", "boolean", false, "Renders the child as the trigger instead of a `<button>`."],
  ]),
  ...props("SheetContent", [
    [
      "side",
      '"top" | "right" | "bottom" | "left"',
      false,
      'Which edge it slides from; default "right".',
    ],
    ["children", "ReactNode", true, "Header, body, footer."],
    ["className", "string", false, "Appended to the panel."],
  ]),
  ...props("SheetHeader / SheetFooter", [
    ["children", "ReactNode", true, "SheetTitle + SheetDescription; actions in the footer."],
    ["className", "string", false, "Appended to the wrapper."],
  ]),
  ...props("SheetTitle / SheetDescription", [
    ["children", "ReactNode", true, "The accessible name and description of the dialog."],
  ]),
];
