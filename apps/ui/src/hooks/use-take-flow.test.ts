import { describe, expect, it } from "vitest";
import { deriveTakeFlowPhase, canCloseTakeFlow } from "./use-take-flow";

describe("deriveTakeFlowPhase", () => {
  it("is 'connect' whenever the wallet isn't connected, regardless of confirmed/txStatus", () => {
    expect(deriveTakeFlowPhase("idle", false, "idle")).toBe("connect");
    expect(deriveTakeFlowPhase("connecting", true, "finalized")).toBe("connect");
    expect(deriveTakeFlowPhase("no-extension", true, "signing")).toBe("connect");
  });

  it("is 'amount' whenever not yet confirmed, once connected", () => {
    expect(deriveTakeFlowPhase("connected", false, "idle")).toBe("amount");
    expect(deriveTakeFlowPhase("connected", false, "finalized")).toBe("amount");
  });

  it("is 'confirm' once confirmed with an idle tx", () => {
    expect(deriveTakeFlowPhase("connected", true, "idle")).toBe("confirm");
  });

  it("is 'signing' while the extension is prompting for a signature", () => {
    expect(deriveTakeFlowPhase("connected", true, "signing")).toBe("signing");
  });

  it("is 'failed' for a decoded on-chain failure or a rejected/pre-dispatch submission", () => {
    expect(deriveTakeFlowPhase("connected", true, "failed")).toBe("failed");
    expect(deriveTakeFlowPhase("connected", true, "submit-error")).toBe("failed");
  });

  it("is 'done' once finalized", () => {
    expect(deriveTakeFlowPhase("connected", true, "finalized")).toBe("done");
  });

  it("is 'broadcasting' for every other in-flight broadcast status", () => {
    for (const status of [
      "future",
      "ready",
      "broadcast",
      "in-block",
      "retracted",
      "finality-timeout",
      "usurped",
      "dropped",
      "invalid",
      "error",
    ] as const) {
      expect(deriveTakeFlowPhase("connected", true, status)).toBe("broadcasting");
    }
  });
});

describe("canCloseTakeFlow", () => {
  it("allows closing from idle, failed, submit-error, and finalized", () => {
    expect(canCloseTakeFlow("idle")).toBe(true);
    expect(canCloseTakeFlow("failed")).toBe(true);
    expect(canCloseTakeFlow("submit-error")).toBe(true);
    expect(canCloseTakeFlow("finalized")).toBe(true);
  });

  it("blocks closing while signing or mid-broadcast", () => {
    expect(canCloseTakeFlow("signing")).toBe(false);
    expect(canCloseTakeFlow("broadcast")).toBe(false);
    expect(canCloseTakeFlow("in-block")).toBe(false);
    expect(canCloseTakeFlow("future")).toBe(false);
  });
});
