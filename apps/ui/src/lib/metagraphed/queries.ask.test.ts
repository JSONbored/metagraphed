import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { askQuestion } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

describe("askQuestion", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("POSTs the question as a JSON body and returns the unwrapped data", async () => {
    const data = {
      question: "which subnet does image generation?",
      answer: "SN64 (Chutes) handles image generation.",
      context_count: 3,
      model: "test-model",
      citations: [],
    };
    mockedApiFetch.mockResolvedValue({
      data,
      meta: {} as ApiResult<unknown>["meta"],
      url: "/api/v1/ask",
    });

    const result = await askQuestion("which subnet does image generation?");

    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/ask",
      expect.objectContaining({
        init: expect.objectContaining({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: "which subnet does image generation?" }),
        }),
      }),
    );
    expect(result).toEqual(data);
  });

  it("forwards an AbortSignal when provided", async () => {
    mockedApiFetch.mockResolvedValue({
      data: { question: "q", answer: "a", context_count: 0, model: "m", citations: [] },
      meta: {} as ApiResult<unknown>["meta"],
      url: "/api/v1/ask",
    });
    const controller = new AbortController();

    await askQuestion("q", controller.signal);

    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/ask",
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("omits signal from the call when not provided (no accidental undefined-signal mismatch)", async () => {
    mockedApiFetch.mockResolvedValue({
      data: { question: "q", answer: "a", context_count: 0, model: "m", citations: [] },
      meta: {} as ApiResult<unknown>["meta"],
      url: "/api/v1/ask",
    });

    await askQuestion("q");

    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/ask",
      expect.objectContaining({ signal: undefined }),
    );
  });

  it("propagates a rejection instead of swallowing it (e.g. a 429/503/network failure)", async () => {
    const error = new Error("boom");
    mockedApiFetch.mockRejectedValue(error);

    await expect(askQuestion("q")).rejects.toBe(error);
  });
});
