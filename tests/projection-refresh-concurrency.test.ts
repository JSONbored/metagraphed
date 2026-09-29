import { describe, expect, it, vi } from "vitest";
import { refreshExistingArtifact } from "../src/projection-store.ts";
import { runProjectionLane } from "../src/projection-lanes.ts";
import { TOP_HOLDERS_HOLDINGS_REFRESH_LANE } from "../src/top-holders-holdings-refresh.ts";

const key = TOP_HOLDERS_HOLDINGS_REFRESH_LANE.artifactKey;
function fixture() {
  let selected = {
    etag: "original",
    body: { generated_at: "old-flow", row_count: 1 },
  };
  const get = vi.fn(async () => ({
    etag: selected.etag,
    json: async () => selected.body,
  }));
  const head = vi.fn(async (_key: string) => ({ etag: selected.etag }));
  const put = vi.fn(
    async (
      _key: string,
      value: string,
      options?: { onlyIf: { etagMatches: string } },
    ): Promise<object | null> => {
      if (options?.onlyIf.etagMatches !== selected.etag) return null;
      selected = { etag: "refreshed", body: JSON.parse(value) };
      return { etag: selected.etag };
    },
  );
  return {
    env: { METAGRAPH_ARCHIVE: { get, put, head } },
    get,
    head,
    put,
    replace() {
      selected = {
        etag: "winner",
        body: { generated_at: "new-flow", row_count: 2 },
      };
    },
    current: () => selected.body,
  };
}

describe("conditional projection refresh", () => {
  it("recomputes from the winner when the source changes during computation", async () => {
    const f = fixture();
    let computations = 0;
    const compute = vi.fn(async () => {
      const value = { ...f.current(), holdings_generated_at: "fresh-holdings" };
      if (++computations === 1) f.replace();
      return value;
    });
    const recordException = vi.fn(async () => true);
    const result = await runProjectionLane(
      f.env as unknown as Env,
      { ...TOP_HOLDERS_HOLDINGS_REFRESH_LANE, compute },
      { recordException },
    );
    expect(result).toEqual({
      name: "top-holders-holdings-refresh",
      ok: true,
      rows: 2,
    });
    expect(f.current()).toMatchObject({
      generated_at: "new-flow",
      holdings_generated_at: "fresh-holdings",
    });
    expect(f.put).toHaveBeenCalledTimes(2);
    expect(f.put.mock.calls.map((call) => call[2])).toEqual([
      { onlyIf: { etagMatches: "original" } },
      { onlyIf: { etagMatches: "winner" } },
    ]);
    expect(recordException).not.toHaveBeenCalled();
  });

  it("recomputes after a publication conflict and scopes both reads and writes", async () => {
    const f = fixture();
    f.put.mockImplementationOnce(async () => {
      f.replace();
      return null;
    });
    const compute = vi.fn(async () => ({ ...f.current() }));
    expect(
      await refreshExistingArtifact(f.env, "testnet/" + key, compute),
    ).toEqual({ generated_at: "new-flow", row_count: 2 });
    expect(compute).toHaveBeenCalledTimes(2);
    expect(f.head.mock.calls).toEqual([["testnet/" + key], ["testnet/" + key]]);
    expect(f.get).not.toHaveBeenCalled();
    expect(f.put.mock.calls.every((call) => call[0] === "testnet/" + key)).toBe(
      true,
    );
  });

  it("declines a missing artifact or declined computation without publishing", async () => {
    const compute = vi.fn(async () => null);
    const put = vi.fn();
    expect(
      await refreshExistingArtifact(
        {
          METAGRAPH_ARCHIVE: {
            get: async () => null,
            head: async () => null,
            put,
          },
        },
        key,
        compute,
      ),
    ).toBeNull();
    expect(compute).not.toHaveBeenCalled();
    const f = fixture();
    expect(await refreshExistingArtifact(f.env, key, compute)).toBeNull();
    expect(put).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
  });

  it("requires readable writable storage and a nonempty source identity", async () => {
    const compute = vi.fn(async () => ({}));
    for (const METAGRAPH_ARCHIVE of [
      {},
      { get: async () => null, head: async () => null },
      { get: async () => null, put: async () => ({}) },
      { put: async () => ({}) },
    ]) {
      await expect(
        refreshExistingArtifact({ METAGRAPH_ARCHIVE }, key, compute),
      ).rejects.toThrow("read and write");
    }
    for (const etag of [undefined as unknown as string, ""]) {
      await expect(
        refreshExistingArtifact(
          {
            METAGRAPH_ARCHIVE: {
              get: async () => ({ etag, json: async () => ({}) }),
              head: async () => ({ etag }),
              put: async () => ({}),
            },
          },
          key,
          compute,
        ),
      ).rejects.toThrow("source ETag");
    }
    expect(compute).not.toHaveBeenCalled();
  });

  it("bounds contention to three recomputations and reports a real failure", async () => {
    const f = fixture();
    f.put.mockResolvedValue(null);
    const compute = vi.fn(async () => ({ ...f.current() }));
    const recordException = vi.fn(async () => true);
    const result = await runProjectionLane(
      f.env as unknown as Env,
      { ...TOP_HOLDERS_HOLDINGS_REFRESH_LANE, compute },
      { recordException },
    );
    expect(result.reason).toBe("lane_failed");
    expect(compute).toHaveBeenCalledTimes(3);
    expect(recordException).toHaveBeenCalledTimes(1);
    expect(f.current().generated_at).toBe("old-flow");
  });

  it("does not retry transport errors or allow partially conditional split writes", async () => {
    const f = fixture();
    f.put.mockRejectedValue(new Error("transport failed"));
    const compute = vi.fn(async () => ({ ...f.current() }));
    await expect(refreshExistingArtifact(f.env, key, compute)).rejects.toThrow(
      "transport failed",
    );
    expect(compute).toHaveBeenCalledTimes(1);
    const recordException = vi.fn(async () => true);
    const result = await runProjectionLane(
      f.env as unknown as Env,
      { ...TOP_HOLDERS_HOLDINGS_REFRESH_LANE, compute, split: () => ({}) },
      { recordException },
    );
    expect(result.reason).toBe("lane_failed");
    expect(compute).toHaveBeenCalledTimes(1);
    expect(recordException).toHaveBeenCalledTimes(1);
  });
});
