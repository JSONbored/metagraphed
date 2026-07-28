import { describe, expect, it } from "vitest";
import { layoutSankey, type SankeyLink, type SankeyNode } from "./sankey-mini";

const nodes: SankeyNode[] = [
  { id: "root", label: "Root", value: 100, column: 0 },
  { id: "sn1", label: "SN1", value: 60, column: 1 },
  { id: "sn2", label: "SN2", value: 40, column: 1 },
];

const links: SankeyLink[] = [
  { source: "root", target: "sn1", value: 60 },
  { source: "root", target: "sn2", value: 40 },
];

describe("layoutSankey", () => {
  it("places one rect per node, sized proportionally within its column", () => {
    const { nodeRects } = layoutSankey(nodes, links, 400, 200);
    expect(nodeRects.size).toBe(3);
    const sn1 = nodeRects.get("sn1")!;
    const sn2 = nodeRects.get("sn2")!;
    // sn1:sn2 value ratio is 60:40 -- stack size should follow the same ratio.
    expect(sn1.stackSize / sn2.stackSize).toBeCloseTo(60 / 40, 1);
  });

  it("positions columns left to right by column index", () => {
    const { nodeRects } = layoutSankey(nodes, links, 400, 200);
    const root = nodeRects.get("root")!;
    const sn1 = nodeRects.get("sn1")!;
    expect(root.colPos).toBeLessThan(sn1.colPos);
  });

  it("produces one link path per link, dropping links to/from unknown nodes", () => {
    const withDangling: SankeyLink[] = [
      ...links,
      { source: "root", target: "ghost", value: 5 },
    ];
    const { linkPaths } = layoutSankey(nodes, withDangling, 400, 200);
    expect(linkPaths).toHaveLength(2);
  });

  it("drops zero/negative-value links", () => {
    const { linkPaths } = layoutSankey(
      nodes,
      [...links, { source: "root", target: "sn1", value: 0 }],
      400,
      200,
    );
    expect(linkPaths).toHaveLength(2);
  });

  it("splits a node's stacking offset across multiple outgoing links in insertion order", () => {
    const { linkPaths } = layoutSankey(nodes, links, 400, 200);
    const toSn1 = linkPaths.find((l) => l.link.target === "sn1")!;
    const toSn2 = linkPaths.find((l) => l.link.target === "sn2")!;
    // sn1 (60) comes first from root, so its band starts before sn2's.
    expect(toSn1.stackStart).toBeLessThan(toSn2.stackStart);
  });

  it("handles a single column (no links) without dividing by zero", () => {
    const { nodeRects, linkPaths } = layoutSankey(
      [{ id: "only", label: "Only", value: 10, column: 0 }],
      [],
      400,
      200,
    );
    expect(nodeRects.size).toBe(1);
    expect(linkPaths).toHaveLength(0);
  });

  it("gives every node a minimum visible size even with a tiny value share", () => {
    const skewed: SankeyNode[] = [
      { id: "big", label: "Big", value: 9999, column: 0 },
      { id: "small", label: "Small", value: 1, column: 0 },
    ];
    const { nodeRects } = layoutSankey(skewed, [], 400, 200);
    expect(nodeRects.get("small")!.stackSize).toBeGreaterThan(0);
  });
});
