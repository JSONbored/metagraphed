import { classNames } from "@/lib/format";

export interface SankeyNode {
  id: string;
  label: string;
  /** Total throughput used for sizing — the caller computes this (sum of
   * connected link values), same convention as TreemapMiniDatum.value. */
  value: number;
  /** 0-indexed position along the flow axis (root=0, subnets=1, ...). */
  column: number;
  color?: string;
}

export interface SankeyLink {
  source: string;
  target: string;
  value: number;
  color?: string;
}

interface NodeRect {
  node: SankeyNode;
  /** Position along the column axis (which column) and stack axis (offset within it), logical units. */
  colPos: number;
  stackPos: number;
  stackSize: number;
}

interface LinkPath {
  link: SankeyLink;
  colStart: number;
  stackStart: number;
  colEnd: number;
  stackEnd: number;
  thickness: number;
}

interface Layout {
  columnCount: number;
  nodeRects: Map<string, NodeRect>;
  linkPaths: LinkPath[];
}

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
const NODE_THICKNESS = 10;
const NODE_GAP = 6;
// Below this, a node's label collides with its neighbors' — the crowded axis
// is `stackSize` in both orientations (a short bar's height, horizontal; a
// narrow bar's width, vertical), so one threshold covers both. Same idea as
// TreemapMini's MIN_TILE_*_FOR_LABEL: the tile/node still has a `<title>`
// tooltip, it just doesn't draw text that would overlap its neighbors.
const MIN_LABEL_STACK_SIZE = 14;

/**
 * Pure sankey layout, no dependencies. Works in a logical (columnAxis,
 * stackAxis) space — the render layer maps that onto screen x/y, which is
 * how the same layout serves both the horizontal (desktop) and vertical
 * (mobile) orientations without recomputing anything.
 *
 * Each column's total stack length uses the full `stackExtent` independently
 * (nodes within a column share one scale; different columns can end up at
 * different per-unit scales, same as any sankey mixing dissimilar totals
 * across columns — that's expected here since a validator column's current
 * stake and a subnet column's windowed flow aren't the same unit of measure).
 *
 * A link's departure position within its source node depends only on that
 * node's OTHER outgoing links (stacked by insertion order); its arrival
 * position within its target node depends only on that node's incoming
 * links. This is the standard sankey band convention and tolerates a node
 * whose incoming and outgoing totals don't exactly match.
 */
export function layoutSankey(
  nodes: readonly SankeyNode[],
  links: readonly SankeyLink[],
  columnExtent: number,
  stackExtent: number,
): Layout {
  const columns = [...new Set(nodes.map((n) => n.column))].sort(
    (a, b) => a - b,
  );
  const colPos = (column: number) =>
    columns.length <= 1
      ? 0
      : (columns.indexOf(column) / (columns.length - 1)) *
        (columnExtent - NODE_THICKNESS);

  const nodeRects = new Map<string, NodeRect>();
  for (const column of columns) {
    const colNodes = nodes.filter((n) => n.column === column);
    const total = sum(colNodes.map((n) => Math.max(0, n.value))) || 1;
    const totalGap = NODE_GAP * Math.max(0, colNodes.length - 1);
    const usable = Math.max(0, stackExtent - totalGap);
    let cursor = 0;
    for (const node of colNodes) {
      const size = Math.max(2, (Math.max(0, node.value) / total) * usable);
      nodeRects.set(node.id, {
        node,
        colPos: colPos(column),
        stackPos: cursor,
        stackSize: size,
      });
      cursor += size + NODE_GAP;
    }
  }

  const outgoingBy = new Map<string, SankeyLink[]>();
  const incomingBy = new Map<string, SankeyLink[]>();
  for (const link of links) {
    if (
      !nodeRects.has(link.source) ||
      !nodeRects.has(link.target) ||
      link.value <= 0
    )
      continue;
    (
      outgoingBy.get(link.source) ??
      outgoingBy.set(link.source, []).get(link.source)!
    ).push(link);
    (
      incomingBy.get(link.target) ??
      incomingBy.set(link.target, []).get(link.target)!
    ).push(link);
  }

  const outCursor = new Map<string, number>();
  const inCursor = new Map<string, number>();
  const linkPaths: LinkPath[] = [];
  for (const link of links) {
    const src = nodeRects.get(link.source);
    const tgt = nodeRects.get(link.target);
    if (!src || !tgt || link.value <= 0) continue;

    const srcTotal =
      sum((outgoingBy.get(link.source) ?? []).map((l) => l.value)) || 1;
    const srcOff = outCursor.get(link.source) ?? 0;
    const srcBand = (link.value / srcTotal) * src.stackSize;
    outCursor.set(link.source, srcOff + srcBand);

    const tgtTotal =
      sum((incomingBy.get(link.target) ?? []).map((l) => l.value)) || 1;
    const tgtOff = inCursor.get(link.target) ?? 0;
    const tgtBand = (link.value / tgtTotal) * tgt.stackSize;
    inCursor.set(link.target, tgtOff + tgtBand);

    linkPaths.push({
      link,
      colStart: src.colPos + NODE_THICKNESS,
      stackStart: src.stackPos + srcOff + srcBand / 2,
      colEnd: tgt.colPos,
      stackEnd: tgt.stackPos + tgtOff + tgtBand / 2,
      thickness: Math.max(1, Math.min(srcBand, tgtBand)),
    });
  }

  return { columnCount: columns.length, nodeRects, linkPaths };
}

interface Props {
  nodes: readonly SankeyNode[];
  links: readonly SankeyLink[];
  /** Extent along the flow axis (desktop: width; mobile: height). */
  columnExtent?: number;
  /** Extent along the stacking axis (desktop: height; mobile: width). */
  stackExtent?: number;
  orientation?: "horizontal" | "vertical";
  formatValue?: (value: number) => string;
  className?: string;
  ariaLabel?: string;
  onNodeSelect?: (nodeId: string) => void;
}

/**
 * Tiny sankey diagram, no dependencies — the flow-diagram counterpart to
 * TreemapMini/Donut in this file's family (pure layout math + a thin SVG
 * render layer, theme via `var(--*)` tokens, `role="img"` + a synthesized
 * fallback aria-label, `return null` when there's nothing to draw).
 */
export function SankeyMini({
  nodes,
  links,
  columnExtent = 560,
  stackExtent = 280,
  orientation = "horizontal",
  formatValue = String,
  className,
  ariaLabel,
  onNodeSelect,
}: Props) {
  if (nodes.length === 0 || links.length === 0) return null;
  const { nodeRects, linkPaths } = layoutSankey(
    nodes,
    links,
    columnExtent,
    stackExtent,
  );

  const vertical = orientation === "vertical";
  const viewW = vertical ? stackExtent : columnExtent;
  const viewH = vertical ? columnExtent : stackExtent;
  // (col, stack) -> (x, y): horizontal maps col->x/stack->y; vertical swaps.
  const px = (col: number, stack: number) => (vertical ? stack : col);
  const py = (col: number, stack: number) => (vertical ? col : stack);
  const lastColumn = Math.max(...nodes.map((n) => n.column));

  const label =
    ariaLabel ??
    `Stake flow diagram: ${links
      .map((l) => `${l.source} to ${l.target} ${formatValue(l.value)}`)
      .join(", ")}`;

  return (
    <svg
      viewBox={`0 0 ${viewW} ${viewH}`}
      role="img"
      aria-label={label}
      className={classNames("block w-full", className)}
      style={{ maxWidth: "100%" }}
    >
      {linkPaths.map((lp, i) => {
        const x0 = px(lp.colStart, lp.stackStart);
        const y0 = py(lp.colStart, lp.stackStart);
        const x1 = px(lp.colEnd, lp.stackEnd);
        const y1 = py(lp.colEnd, lp.stackEnd);
        const midX = vertical ? x0 : (x0 + x1) / 2;
        const midY = vertical ? (y0 + y1) / 2 : y0;
        const midX2 = vertical ? x1 : (x0 + x1) / 2;
        const midY2 = vertical ? (y0 + y1) / 2 : y1;
        const path = `M${x0},${y0} C${midX},${midY} ${midX2},${midY2} ${x1},${y1}`;
        return (
          <path
            key={`${lp.link.source}->${lp.link.target}-${i}`}
            d={path}
            fill="none"
            stroke={lp.link.color ?? "var(--accent)"}
            strokeOpacity={0.32}
            strokeWidth={lp.thickness}
          >
            <title>
              {lp.link.source} → {lp.link.target}: {formatValue(lp.link.value)}
            </title>
          </path>
        );
      })}
      {[...nodeRects.values()].map(({ node, colPos, stackPos, stackSize }) => {
        const x = px(colPos, stackPos);
        const y = py(colPos, stackPos);
        const w = vertical ? stackSize : NODE_THICKNESS;
        const h = vertical ? NODE_THICKNESS : stackSize;
        const interactive = Boolean(onNodeSelect);
        return (
          <g
            key={node.id}
            onClick={interactive ? () => onNodeSelect?.(node.id) : undefined}
            role={interactive ? "button" : undefined}
            tabIndex={interactive ? 0 : undefined}
            onKeyDown={
              interactive
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onNodeSelect?.(node.id);
                    }
                  }
                : undefined
            }
            className={interactive ? "cursor-pointer" : undefined}
          >
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              rx={2}
              fill={node.color ?? "var(--ink-muted)"}
            >
              <title>
                {node.label}: {formatValue(node.value)}
              </title>
            </rect>
            {stackSize >= MIN_LABEL_STACK_SIZE ? (
              <text
                x={
                  vertical
                    ? x + w / 2
                    : node.column === lastColumn
                      ? x - 4
                      : x + NODE_THICKNESS + 4
                }
                y={vertical ? y - 4 : y + h / 2}
                textAnchor={
                  vertical
                    ? "middle"
                    : node.column === lastColumn
                      ? "end"
                      : "start"
                }
                dominantBaseline={vertical ? "auto" : "middle"}
                fill="var(--ink-strong)"
                className="mg-type-data-sm"
              >
                {node.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
