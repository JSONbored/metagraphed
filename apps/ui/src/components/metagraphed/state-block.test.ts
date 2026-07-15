import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { TableState } from "@jsonbored/ui-kit";
import { StateBlock, type StateContext } from "./state-block";
import { EmptyState } from "./states";
import { RegistryEmpty } from "./states/registry-empty";

// StateBlock is a plain dispatch function, so calling it returns the element it
// would render without needing a DOM — the same technique validator-columns.test
// uses for its cell renderers.
const render = (props: Parameters<typeof StateBlock>[0]) =>
  StateBlock(props) as ReactElement<Record<string, unknown>>;

describe("StateBlock (#5341)", () => {
  it("routes a section context to EmptyState", () => {
    expect(render({ context: "section", title: "No rows" }).type).toBe(EmptyState);
  });

  it("routes a table context to TableState", () => {
    expect(render({ context: "table", variant: "empty", title: "No rows" }).type).toBe(TableState);
  });

  it("routes a registry context to RegistryEmpty", () => {
    expect(render({ context: "registry", variant: "empty", title: "No surfaces" }).type).toBe(
      RegistryEmpty,
    );
  });

  it("maps every context to a distinct primitive", () => {
    const contexts: StateContext[] = ["section", "table", "registry"];
    const types = contexts.map(
      (context) =>
        render({ context, variant: "empty", title: "t" } as Parameters<typeof StateBlock>[0]).type,
    );
    expect(new Set(types).size).toBe(contexts.length);
  });

  it("forwards the caller's props and never leaks `context` to the primitive", () => {
    const onRetry = () => {};
    const el = render({
      context: "table",
      variant: "error",
      title: "Boom",
      onRetry,
      error: { status: 500, url: "https://api.example/x" },
    });
    expect(el.props).not.toHaveProperty("context");
    expect(el.props).toMatchObject({ variant: "error", title: "Boom", onRetry });
  });

  it("keeps EmptyState's own defaults intact (no title forced by the wrapper)", () => {
    const el = render({ context: "section" });
    expect(el.props).not.toHaveProperty("context");
    expect(el.props.title).toBeUndefined();
  });
});
