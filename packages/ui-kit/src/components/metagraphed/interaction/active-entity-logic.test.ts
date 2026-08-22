import { describe, expect, it } from "vitest";
import {
  EMPTY_ACTIVE_ENTITY,
  isRovingKey,
  markTabIndex,
  reduceActiveEntity,
  rovingTarget,
  tapIntent,
  type ActiveEntityState,
} from "./active-entity-logic";

type E = { key: string };
const a = { key: "a" };
const b = { key: "b" };
const empty: ActiveEntityState<E> = EMPTY_ACTIVE_ENTITY;

describe("reduceActiveEntity", () => {
  it("hover / focus sets the entity and is not pinned", () => {
    expect(reduceActiveEntity(empty, { type: "set", entity: a })).toEqual({
      active: a,
      pinned: false,
    });
  });

  it("leave / blur clears a hovered entity", () => {
    const hovered = reduceActiveEntity(empty, { type: "set", entity: a });
    expect(reduceActiveEntity(hovered, { type: "clear" })).toEqual(empty);
  });

  it("clearing an already-empty state returns the same object (no re-render)", () => {
    expect(reduceActiveEntity(empty, { type: "clear" })).toBe(empty);
  });

  it("a tap pins; hover and plain clear cannot dislodge a pinned entity", () => {
    const pinned = reduceActiveEntity(empty, { type: "pin", entity: a });
    expect(pinned).toEqual({ active: a, pinned: true });
    expect(reduceActiveEntity(pinned, { type: "set", entity: b })).toBe(pinned);
    expect(reduceActiveEntity(pinned, { type: "clear" })).toBe(pinned);
  });

  it("Escape / outside tap (force) releases a pinned entity", () => {
    const pinned = reduceActiveEntity(empty, { type: "pin", entity: a });
    expect(reduceActiveEntity(pinned, { type: "clear", force: true })).toEqual(
      empty,
    );
  });

  it("tapping a different mark re-pins to it; re-tapping the pinned one is a no-op", () => {
    const pinned = reduceActiveEntity(empty, { type: "pin", entity: a });
    expect(reduceActiveEntity(pinned, { type: "pin", entity: b })).toEqual({
      active: b,
      pinned: true,
    });
    expect(
      reduceActiveEntity(pinned, { type: "pin", entity: { key: "a" } }),
    ).toBe(pinned);
  });
});

describe("tapIntent", () => {
  it("a pointer click always activates", () => {
    expect(tapIntent("mouse", false)).toBe("activate");
    expect(tapIntent("pen", true)).toBe("activate");
  });
  it("a touch tap pins first and activates on the second tap of the pinned mark", () => {
    expect(tapIntent("touch", false)).toBe("pin");
    expect(tapIntent("touch", true)).toBe("activate");
  });
});

describe("rovingTarget", () => {
  it("arrows wrap in both directions", () => {
    expect(rovingTarget("ArrowRight", 0, 3)).toBe(1);
    expect(rovingTarget("ArrowDown", 2, 3)).toBe(0);
    expect(rovingTarget("ArrowLeft", 0, 3)).toBe(2);
    expect(rovingTarget("ArrowUp", 1, 3)).toBe(0);
  });
  it("Home / End clamp", () => {
    expect(rovingTarget("Home", 2, 5)).toBe(0);
    expect(rovingTarget("End", 0, 5)).toBe(4);
  });
  it("does nothing for a lone mark or an index outside the group", () => {
    expect(rovingTarget("ArrowRight", 0, 1)).toBeNull();
    expect(rovingTarget("ArrowRight", -1, 3)).toBeNull();
    expect(rovingTarget("End", 3, 3)).toBeNull();
  });
  it("recognises exactly the roving keys", () => {
    for (const k of [
      "ArrowRight",
      "ArrowDown",
      "ArrowLeft",
      "ArrowUp",
      "Home",
      "End",
    ]) {
      expect(isRovingKey(k)).toBe(true);
    }
    expect(isRovingKey("Tab")).toBe(false);
    expect(isRovingKey("Enter")).toBe(false);
  });
});

describe("markTabIndex", () => {
  it("exactly one tabbable mark per group at rest: the first", () => {
    expect(markTabIndex({ disabled: false, active: false, first: true })).toBe(
      0,
    );
    expect(markTabIndex({ disabled: false, active: false, first: false })).toBe(
      -1,
    );
  });
  it("the active mark is also tabbable so Tab returns to it", () => {
    expect(markTabIndex({ disabled: false, active: true, first: false })).toBe(
      0,
    );
  });
  it("a disabled mark never is", () => {
    expect(markTabIndex({ disabled: true, active: true, first: true })).toBe(
      -1,
    );
  });
});
