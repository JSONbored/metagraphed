import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { CatalogExportAction } from "./catalog-export-action";

const hooks = vi.hoisted(() => ({
  request: { current: null as AbortController | null },
  cleanup: undefined as (() => void) | undefined,
  pending: vi.fn(),
  error: vi.fn(),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useRef: () => hooks.request,
  useState: (initial: unknown) => [initial, initial === false ? hooks.pending : hooks.error],
  useLayoutEffect: (effect: () => () => void) => {
    hooks.cleanup = effect();
  },
}));

interface Row {
  id: string;
}
const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
const createObjectURL = vi.fn((_blob: Blob) => "blob:catalog");
const revokeObjectURL = vi.fn();

function action(
  loadRows: (signal: AbortSignal) => Promise<readonly Row[]>,
  formatRows = vi.fn(() => "id\r\none\r\n"),
) {
  const tree = CatalogExportAction({
    loadRows,
    formatRows,
    filename: "Verified surfaces",
    children: "share",
  });
  const [actions] = tree.props.children as ReactElement<{
    children: ReactElement<{ onClick: () => Promise<void> }>[];
  }>[];
  const [button, share] = actions!.props.children;
  expect(share).toBe("share");
  return { click: button!.props.onClick, formatRows };
}

beforeEach(() => {
  vi.clearAllMocks();
  hooks.request.current = null;
  hooks.cleanup = undefined;
  anchor.href = "";
  anchor.download = "";
  vi.stubGlobal("document", { body: { append: vi.fn() }, createElement: vi.fn(() => anchor) });
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
});
afterEach(() => {
  hooks.cleanup?.();
  vi.unstubAllGlobals();
});

describe("checked catalog export action", () => {
  it("starts at the click and creates a CSV only after every row arrives", async () => {
    let finish!: (rows: readonly Row[]) => void;
    const loadRows = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<readonly Row[]>((resolve) => {
          finish = resolve;
        }),
    );
    const { click, formatRows } = action(loadRows);
    const done = click();
    expect(loadRows).toHaveBeenCalledOnce();
    expect(loadRows.mock.calls[0]![0]).toBeInstanceOf(AbortSignal);
    expect(createObjectURL).not.toHaveBeenCalled();
    finish([{ id: "one" }]);
    await done;
    expect(formatRows).toHaveBeenCalledWith([{ id: "one" }]);
    const blob = createObjectURL.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe("text/csv;charset=utf-8");
    expect(await blob.text()).toBe("id\r\none\r\n");
    expect(anchor.download).toBe("verified-surfaces.csv");
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:catalog");
  });

  it("aborts on view replacement or menu unmount and rejects a late fulfilled walk", async () => {
    let finish!: (rows: readonly Row[]) => void;
    const loadRows = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<readonly Row[]>((resolve) => {
          finish = resolve;
        }),
    );
    const { click, formatRows } = action(loadRows);
    const done = click();
    const signal = loadRows.mock.calls[0]![0];
    hooks.cleanup!();
    expect(signal.aborted).toBe(true);
    finish([{ id: "late" }]);
    await done;
    expect(formatRows).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(anchor.click).not.toHaveBeenCalled();
  });

  it("keeps failures visible and never downloads a partial walk", async () => {
    const { click } = action(
      vi.fn(async () => {
        throw new Error("Catalog changed. Restart export.");
      }),
    );
    await click();
    expect(hooks.error).toHaveBeenCalledWith("Catalog changed. Restart export.");
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(anchor.click).not.toHaveBeenCalled();
  });

  it("does not start a second concurrent walk", async () => {
    let finish!: (rows: readonly Row[]) => void;
    const loadRows = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<readonly Row[]>((resolve) => {
          finish = resolve;
        }),
    );
    const { click } = action(loadRows);
    const done = click();
    await click();
    expect(loadRows).toHaveBeenCalledOnce();
    finish([]);
    await done;
  });
});
