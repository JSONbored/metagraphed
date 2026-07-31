import { describe, expect, it } from "vitest";

import { curationTileState, operationalTileState } from "./subnet-health-tile";

describe("operationalTileState", () => {
  it("shows a checking placeholder while the health query is pending", () => {
    const state = operationalTileState({
      phase: "pending",
      down: undefined,
      warn: undefined,
      total: undefined,
    });
    expect(state).toEqual({
      phase: "pending",
      value: "…",
      hint: "checking probes",
      tone: "default",
    });
  });

  it("never claims Healthy when the health query failed", () => {
    const state = operationalTileState({
      phase: "error",
      down: undefined,
      warn: undefined,
      total: undefined,
    });
    expect(state.value).not.toBe("Healthy");
    expect(state.hint).not.toBe("All probed surfaces up");
    expect(state.tone).not.toBe("ok");
    expect(state).toEqual({
      phase: "error",
      value: "Unavailable",
      hint: "health probe unavailable",
      tone: "default",
    });
  });

  it("reports open incidents with a down tone when down > 0", () => {
    const state = operationalTileState({ phase: "ready", down: 2, warn: 1, total: 10 });
    expect(state).toEqual({
      phase: "ready",
      value: "3 open",
      hint: "2 down · 1 degraded",
      tone: "down",
    });
  });

  it("reports open incidents with a warn tone when only warn > 0", () => {
    const state = operationalTileState({ phase: "ready", down: 0, warn: 2, total: 10 });
    expect(state).toEqual({
      phase: "ready",
      value: "2 open",
      hint: "0 down · 2 degraded",
      tone: "warn",
    });
  });

  it("reports Healthy only when both counts are real zeros over a probed total", () => {
    const state = operationalTileState({ phase: "ready", down: 0, warn: 0, total: 10 });
    expect(state).toEqual({
      phase: "ready",
      value: "Healthy",
      hint: "All probed surfaces up",
      tone: "ok",
    });
  });

  it("falls back to no-probe-data when down is not a number, even if ready", () => {
    const state = operationalTileState({ phase: "ready", down: undefined, warn: 0, total: 10 });
    expect(state.value).not.toBe("Healthy");
    expect(state).toEqual({ phase: "ready", value: "—", hint: "no probe data", tone: "default" });
  });

  it("falls back to no-probe-data when warn is not a number", () => {
    const state = operationalTileState({ phase: "ready", down: 0, warn: undefined, total: 10 });
    expect(state).toEqual({ phase: "ready", value: "—", hint: "no probe data", tone: "default" });
  });

  it("falls back to no-probe-data when total is zero", () => {
    const state = operationalTileState({ phase: "ready", down: 0, warn: 0, total: 0 });
    expect(state).toEqual({ phase: "ready", value: "—", hint: "no probe data", tone: "default" });
  });

  it("falls back to no-probe-data when total is nullish", () => {
    const state = operationalTileState({ phase: "ready", down: 0, warn: 0, total: undefined });
    expect(state).toEqual({ phase: "ready", value: "—", hint: "no probe data", tone: "default" });
  });
});

describe("curationTileState", () => {
  it("shows a checking placeholder while the profile query is pending", () => {
    const state = curationTileState({ phase: "pending", curationLevel: undefined });
    expect(state).toEqual({
      phase: "pending",
      value: "…",
      hint: "checking curation",
      tone: "default",
    });
  });

  it("never fabricates a curation level when the profile query failed", () => {
    const state = curationTileState({ phase: "error", curationLevel: undefined });
    expect(state.value).not.toBe("Candidate Discovered");
    expect(state.tone).not.toBe("accent");
    expect(state).toEqual({
      phase: "error",
      value: "Unavailable",
      hint: "curation query unavailable",
      tone: "default",
    });
  });

  it("reports Unknown when a ready profile carries no curation level", () => {
    const state = curationTileState({ phase: "ready", curationLevel: null });
    expect(state).toEqual({
      phase: "ready",
      value: "Unknown",
      hint: "curation level not recorded",
      tone: "default",
    });
  });

  it("labels an adapter-backed subnet with the accent tone", () => {
    const state = curationTileState({ phase: "ready", curationLevel: "adapter-backed" });
    expect(state).toEqual({
      phase: "ready",
      value: "Adapter Backed",
      hint: "Deep integration — adapter-backed",
      tone: "accent",
    });
  });

  it("labels a candidate-discovered subnet with the default tone", () => {
    const state = curationTileState({ phase: "ready", curationLevel: "candidate-discovered" });
    expect(state).toEqual({
      phase: "ready",
      value: "Candidate Discovered",
      hint: "Registry curation level",
      tone: "default",
    });
  });
});
