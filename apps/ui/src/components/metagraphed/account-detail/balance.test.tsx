import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODERN_FINNEY_GENESIS } from "@/lib/metagraphed/modern-catalog";
import { modernBalanceKey } from "@/lib/metagraphed/modern-explorer";
import { AccountBalance, accountBalanceView } from "./balance";
import {
  modernBalanceFixture,
  MODERN_EXPLORER_ACCOUNT,
  MODERN_EXPLORER_PARTICIPANT,
} from "../../../../tests/e2e/modern-explorer-fixture";

const state = vi.hoisted(() => ({ configuration: null as unknown }));
vi.mock("@/lib/metagraphed/modern-explorer", async (original) => ({
  ...(await original<typeof import("@/lib/metagraphed/modern-explorer")>()),
  useModernExplorerConfiguration: () => state.configuration,
}));
const scope = {
  origin: "https://example.test",
  network: "finney",
  genesis: MODERN_FINNEY_GENESIS,
} as const;
const key = modernBalanceKey(scope, MODERN_EXPLORER_PARTICIPANT);
function render(client: QueryClient, ss58 = MODERN_EXPLORER_ACCOUNT) {
  return renderToStaticMarkup(
    createElement(QueryClientProvider, {
      client,
      children: createElement(AccountBalance, {
        ss58,
        children: (view) => createElement("output", null, JSON.stringify(view)),
      }),
    }),
  );
}
beforeEach(() => {
  state.configuration = null;
});

describe("exact observed account balance", () => {
  it("sums only free and reserved with integer precision and preserves one rao", () => {
    const data = modernBalanceFixture(MODERN_EXPLORER_PARTICIPANT);
    expect(accountBalanceView(data).value).toBe("9007199.254741τ");
    if (data.result.status !== "stored") throw new Error("Expected stored fixture");
    data.result.account.free_rao = "1";
    data.result.account.reserved_rao = "0";
    data.result.account.frozen_rao = "18446744073709551615";
    const view = accountBalanceView(data);
    expect(view.value).toBe("0.000000001τ");
    expect(view.rows).toContainEqual({
      label: "Balance frozen (rao, overlapping constraint)",
      value: "18446744073709551615",
    });
    data.result.account.free_rao = "18446744073709551615";
    data.result.account.reserved_rao = "18446744073709551615";
    expect(accountBalanceView(data).value).toBe("36893488147.41910323τ");
  });
  it("keeps observed zero, runtime defaults, pending and unavailable distinct", () => {
    const data = modernBalanceFixture(MODERN_EXPLORER_PARTICIPANT);
    if (data.result.status !== "stored") throw new Error("Expected stored fixture");
    data.result.account.free_rao = "0";
    data.result.account.reserved_rao = "0";
    expect(accountBalanceView(data).value).toBe("0τ");
    const absent = accountBalanceView(
      modernBalanceFixture(MODERN_EXPLORER_PARTICIPANT, "not_stored"),
    );
    expect(absent.value).toBe("—");
    expect(absent.notice).toContain("No account entry is stored at block");
    expect(absent.notice).toContain("runtime default");
    expect(absent.rows).toContainEqual({ label: "Balance status", value: "not_stored" });
    expect(accountBalanceView(undefined, true)).toMatchObject({
      value: "—",
      loading: true,
      notice: "",
    });
    expect(accountBalanceView(undefined, false, true)).toMatchObject({
      value: "—",
      loading: false,
      notice: "Balance is unavailable.",
    });
  });
  it("dates stale or unknown evidence and hides a monetary claim after failed refresh", () => {
    const data = modernBalanceFixture(MODERN_EXPLORER_PARTICIPANT);
    for (const status of ["current", "stale", "unknown"] as const) {
      data.freshness.status = status;
      const view = accountBalanceView(data);
      expect(view.notice).toContain(`freshness at response: ${status}`);
      expect(view.rows).toContainEqual({
        label: "Balance observed at",
        value: data.balance.observed_at,
      });
      expect(view.rows).toContainEqual({
        label: "Balance publication",
        value: data.balance.publication_id,
      });
    }
    const failed = accountBalanceView(data, false, true);
    expect(failed.value).toBe("—");
    expect(failed.notice).toContain("Balance refresh failed");
    expect(failed.rows).toContainEqual({
      label: "Balance status",
      value: "refresh failed; retained stored",
    });
    expect(failed.rows).toContainEqual({ label: "Balance free (rao)", value: "9007199254740993" });
  });
});

describe("selected account balance observer", () => {
  it("keeps reads disabled before hydration or for invalid account/network/source", () => {
    const client = new QueryClient();
    try {
      expect(render(client)).toContain("loading");
      state.configuration = { status: "unsupported-network" };
      expect(render(client)).toContain("no other network was queried");
      state.configuration = { status: "invalid-origin" };
      expect(render(client)).toContain("selected API source");
      state.configuration = { status: "ready", scope };
      expect(render(client, MODERN_EXPLORER_ACCOUNT.slice(0, -1) + "Z")).toContain(
        "no balance was queried",
      );
      expect(
        client
          .getQueryCache()
          .findAll()
          .every((query) => query.state.fetchStatus === "idle" && query.state.data === undefined),
      ).toBe(true);
    } finally {
      client.clear();
    }
  });
  it("reads only the selected account and origin and hides cached value after refresh failure", () => {
    state.configuration = { status: "ready", scope };
    const client = new QueryClient();
    try {
      client.setQueryData(key, modernBalanceFixture(MODERN_EXPLORER_PARTICIPANT));
      expect(render(client)).toContain("9007199.254741τ");
      expect(render(client)).toContain(scope.origin);
      state.configuration = {
        status: "ready",
        scope: { ...scope, origin: "https://other.example" },
      };
      expect(render(client)).not.toContain("9007199.254741τ");
      state.configuration = { status: "ready", scope };
      client
        .getQueryCache()
        .find({ queryKey: key })!
        .setState({ status: "error", error: new Error("refresh failed"), fetchStatus: "idle" });
      expect(render(client)).not.toContain("9007199.254741τ");
      expect(render(client)).toContain("Balance refresh failed");
    } finally {
      client.clear();
    }
  });
});
