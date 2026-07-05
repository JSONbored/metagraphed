import { describe, expect, it, vi } from "vitest";

import { createRegistrySnapshotHandler } from "./use-registry-events";

describe("createRegistrySnapshotHandler", () => {
  it("skips the first snapshot replayed on connect", () => {
    const invalidate = vi.fn();
    const onSnapshot = createRegistrySnapshotHandler(invalidate);

    onSnapshot();

    expect(invalidate).not.toHaveBeenCalled();
  });

  it("invalidates on every snapshot after the connect replay", () => {
    const invalidate = vi.fn();
    const onSnapshot = createRegistrySnapshotHandler(invalidate);

    onSnapshot();
    onSnapshot();
    onSnapshot();

    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("starts fresh when a new handler is created on reconnect", () => {
    const invalidate = vi.fn();
    const first = createRegistrySnapshotHandler(invalidate);
    first();
    first();
    expect(invalidate).toHaveBeenCalledTimes(1);

    const second = createRegistrySnapshotHandler(invalidate);
    second();
    second();

    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
