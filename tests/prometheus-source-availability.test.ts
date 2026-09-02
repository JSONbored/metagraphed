import { describe, expect, test } from "vitest";
import { buildChainPrometheus } from "../src/chain-prometheus.ts";
import {
  buildAccountPrometheus,
  loadAccountPrometheus,
} from "../src/account-prometheus.ts";
import {
  buildSubnetPrometheus,
  loadSubnetPrometheus,
} from "../src/subnet-prometheus.ts";
import { loadChainPrometheusColdTier } from "../src/chain-prometheus-loader.ts";
import { loadSubnetEventCardColdTier } from "../src/subnet-event-card-loader.ts";
import { CHAIN_PROMETHEUS_ROLLUP } from "../src/chain-event-rollup-cold-tier.ts";

describe.each(["7d", "30d"])(
  "Prometheus source availability for %s",
  (window) => {
    test("shared builders distinguish measured zeros from unavailable fallbacks", () => {
      for (const sourceAvailable of [false, true]) {
        const options = { window, sourceAvailable };
        const cards = [
          buildChainPrometheus([], options),
          buildAccountPrometheus([], "account", options),
          buildSubnetPrometheus(null, 112, options),
        ];
        for (const card of cards) {
          expect(card.degraded).toEqual(
            sourceAvailable ? undefined : { reason: "unavailable" },
          );
        }
      }
    });

    test("a successful empty chain or subnet query remains a measured answer", async () => {
      const query = async (_env: unknown, sql: string) =>
        sql.includes("ORDER BY")
          ? []
          : [
              {
                announcements: 0,
                distinct_exporters: 0,
                newest_observed: null,
              },
            ];
      const chain = await loadChainPrometheusColdTier({}, { window, query });
      const subnet = await loadSubnetEventCardColdTier(
        {},
        CHAIN_PROMETHEUS_ROLLUP,
        112,
        buildSubnetPrometheus,
        { windowLabel: window, windowDays: Number.parseInt(window, 10), query },
      );
      expect(chain?.network?.announcements).toBe(0);
      expect(subnet?.announcements).toBe(0);
      expect(chain?.degraded).toBeUndefined();
      expect(subnet?.degraded).toBeUndefined();
    });

    test("store loaders pass through an empty measurement", async () => {
      const account = await loadAccountPrometheus(async () => [], "account", {
        windowLabel: window,
      });
      const subnet = await loadSubnetPrometheus(async () => [], 112, {
        windowLabel: window,
        windowDays: Number.parseInt(window, 10),
      });
      expect(account.data.total_announcements).toBe(0);
      expect(account.data.degraded).toBeUndefined();
      expect(subnet.announcements).toBe(0);
      expect(subnet.degraded).toBeUndefined();
    });
  },
);
