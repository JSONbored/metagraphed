import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { ListCard } from "@/components/metagraphed/list-shell";

// #6376: ListCard takes independently-optional `to`/`onClick`, but the link
// branch returned <a href={to}> without ever attaching onClick -- passing both
// silently swallowed the handler, with nothing in the JSDoc saying they were
// mutually exclusive. A caller wiring click-tracking alongside navigation got no
// warning and no handler.
//
// ListCard is a plain function, so calling it returns the element to inspect
// directly -- no DOM needed, which suits this package's node-environment suite
// (a click can't be dispatched without jsdom, but the wiring is what regressed).
type CardElementProps = {
  href?: string;
  type?: string;
  onClick?: () => void;
  className?: string;
};

const render = (props: Parameters<typeof ListCard>[0]) =>
  ListCard(props) as ReactElement<CardElementProps>;

describe("ListCard wires onClick on both branches (#6376)", () => {
  it("attaches onClick to the link branch instead of dropping it", () => {
    const onClick = vi.fn();
    const el = render({ to: "/subnets/1", onClick, children: "row" });

    expect(el.type).toBe("a");
    expect(el.props.href).toBe("/subnets/1");
    // The regression: this used to be undefined.
    expect(el.props.onClick).toBe(onClick);

    el.props.onClick?.();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("still navigates -- the handler is additive, not a replacement", () => {
    // No preventDefault wrapper: the <a> keeps its href so the browser
    // navigates, and onClick runs alongside it (the click-tracking case).
    const el = render({ to: "/accounts/x", onClick: vi.fn(), children: "row" });
    expect(el.props.href).toBe("/accounts/x");
    expect(String(el.props.onClick)).not.toMatch(/preventDefault/);
  });

  it("link branch without onClick stays undefined, not a stub", () => {
    const el = render({ to: "/subnets/1", children: "row" });
    expect(el.type).toBe("a");
    expect(el.props.onClick).toBeUndefined();
  });

  it("without `to` it is still a button carrying onClick", () => {
    const onClick = vi.fn();
    const el = render({ onClick, children: "row" });

    expect(el.type).toBe("button");
    expect(el.props.type).toBe("button");
    expect(el.props.onClick).toBe(onClick);
  });

  it("both branches keep the 44px tap-target class the JSDoc promises", () => {
    const link = render({ to: "/x", children: "row" });
    const button = render({ onClick: vi.fn(), children: "row" });
    expect(link.props.className).toContain("min-h-11");
    expect(button.props.className).toContain("min-h-11");
  });
});
