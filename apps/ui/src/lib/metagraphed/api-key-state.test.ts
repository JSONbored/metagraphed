import { describe, expect, it } from "vitest";
import { keyRevocationState, reconcileApiKeys, type ApiKeyRow } from "./api-key-state";

const active: ApiKeyRow = {
  key_id: "fixture-key",
  tier: "pro",
  created_at: 100,
  revoked_at: null,
  last_used_at: null,
};

describe("API key revocation evidence", () => {
  it("accepts legacy rows and additive pending evidence without treating epoch zero as absent", () => {
    expect(keyRevocationState(active)).toBe("active");
    expect(
      keyRevocationState({ ...active, revocation_requested_at: 0, revocation_state: "active" }),
    ).toBe("pending");
    expect(keyRevocationState({ ...active, revocation_state: "pending" })).toBe("pending");
  });

  it("gives confirmed revocation precedence over pending or active flags", () => {
    expect(keyRevocationState({ ...active, revoked_at: 0, revocation_state: "pending" })).toBe(
      "revoked",
    );
    expect(
      keyRevocationState({ ...active, revocation_requested_at: 0, revocation_state: "revoked" }),
    ).toBe("revoked");
  });

  it("retains pending and completed outcomes across stale lists while updating other metadata", () => {
    const refreshed = { ...active, last_used_at: 200 };
    for (const state of ["pending", "revoked"] as const) {
      expect(reconcileApiKeys([refreshed], [{ ...active, revocation_state: state }])).toEqual([
        { ...refreshed, revocation_state: state },
      ]);
    }
    expect(
      keyRevocationState(
        reconcileApiKeys(
          [{ ...active, revocation_state: "pending" }],
          [{ ...active, revocation_state: "revoked" }],
        )[0],
      ),
    ).toBe("revoked");
  });

  it("accepts stronger incoming evidence and isolates keys and fresh session caches", () => {
    const pending = { ...active, revocation_state: "pending" as const };
    const revoked = { ...active, revoked_at: 200 };
    expect(reconcileApiKeys([revoked], [pending])).toEqual([revoked]);
    const other = { ...active, key_id: "another-key" };
    expect(reconcileApiKeys([other], [pending])).toEqual([other, pending]);
    expect(reconcileApiKeys([active])).toEqual([active]);
  });
  it("keeps non-active evidence through a list that predates the key, without retaining absent active rows", () => {
    for (const state of ["pending", "revoked"] as const) {
      const known = { ...active, revocation_state: state };
      const omitted = reconcileApiKeys([], [known, { ...active, key_id: "absent-active" }]);
      expect(omitted).toEqual([known]);
      expect(keyRevocationState(reconcileApiKeys([active], omitted)[0])).toBe(state);
    }
  });
});
