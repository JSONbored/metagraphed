import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFreshnessTime, useRelativeTime } from "./use-time-format";

const hydration = vi.hoisted(() => ({ ready: false }));
vi.mock("./use-hydrated", () => ({ useHydrated: () => hydration.ready }));

const originalZone = process.env.TZ;
const observed = "2026-09-22T00:59:30.000Z";

function Stamp() {
  const relative = useRelativeTime();
  const freshness = useFreshnessTime();
  return (
    <p>
      {relative(observed)} · {freshness(observed, "7d")}
    </p>
  );
}

afterEach(() => {
  hydration.ready = false;
  vi.useRealTimers();
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
});

describe("time labels across hydration", () => {
  it("keeps the initial markup identical across clocks, day boundaries and time zones", () => {
    vi.useFakeTimers();
    process.env.TZ = "UTC";
    vi.setSystemTime(new Date("2026-09-22T01:00:00Z"));
    const server = renderToStaticMarkup(<Stamp />);
    process.env.TZ = "America/Phoenix";
    vi.setSystemTime(new Date("2026-09-22T01:02:01Z"));
    const initialBrowser = renderToStaticMarkup(<Stamp />);
    expect(initialBrowser).toBe(server);
    expect(server).toContain("UTC");
    expect(server).toContain("7d window");
  });

  it("retains relative labels after hydration", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T01:00:00Z"));
    hydration.ready = true;
    expect(renderToStaticMarkup(<Stamp />)).toBe("<p>30s ago · updated 30s ago · 7d window</p>");
  });
});
