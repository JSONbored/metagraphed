import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  effects: [] as Array<() => void>,
  report: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  // SSR does not flush effects. Capture the actual component's reporting
  // effect so its original unknown value can be checked without a DOM.
  useEffect: (effect: () => void) => {
    boundary.effects.push(effect);
  },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ invalidate: boundary.invalidate }),
  useRouterState: () => "/broken",
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("../lib/lovable-error-reporting", () => ({
  reportLovableError: boundary.report,
}));

import { ErrorComponent } from "./-root-views";

const opaque = {
  get message(): never {
    throw new Error("Do not inspect an unknown message getter");
  },
  toString(): never {
    throw new Error("Do not coerce an unknown thrown value");
  },
};
const cases: Array<{ name: string; error: unknown; message: string }> = [
  { name: "Error", error: new Error("route failed"), message: "route failed" },
  { name: "string", error: "plain route failure", message: "plain route failure" },
  { name: "null", error: null, message: "Unknown error" },
  { name: "undefined", error: undefined, message: "Unknown error" },
  { name: "plain object", error: { message: {} }, message: "Unknown error" },
  { name: "opaque object", error: opaque, message: "Unknown error" },
];

describe("root route error boundary", () => {
  beforeEach(() => {
    boundary.effects.length = 0;
    boundary.report.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(cases)(
    "renders and reports an unknown $name without replacing it",
    ({ error, message }) => {
      const html = renderToStaticMarkup(<ErrorComponent error={error} reset={vi.fn()} />);
      expect(html).toContain("This route hit an error");
      expect(html).toContain("Retry route");
      expect(html).toContain("/broken");
      expect(html).toContain(message);
      expect(vi.mocked(console.error).mock.calls[0][0]).toBe(error);

      // ErrorComponent registers its reporting effect before rendering its
      // children. Execute that captured effect, not a substituted reporter path.
      expect(boundary.effects[0]).toBeTypeOf("function");
      boundary.effects[0]();
      expect(boundary.report.mock.calls[0][0]).toBe(error);
      expect(boundary.report.mock.calls[0][1]).toEqual({
        boundary: "tanstack_root_error_component",
      });
    },
  );
});
