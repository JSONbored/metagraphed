import * as identities from "../../src/indexed-subnet-identities.ts";
import { afterEach, beforeEach, vi } from "vitest";
import * as accounts from "../../src/indexed-account-feeds.ts";
import * as history from "../../src/indexed-history-store.ts";
import * as windows from "../../src/indexed-chain-windows.ts";
import * as daily from "../../src/account-history-indexed.ts";
import * as subnet from "../../src/subnet-indexed-aggregates.ts";
import * as weights from "../../src/account-weight-setters-native.ts";
import * as nominators from "../../src/validator-nominators-indexed.ts";
import * as stores from "../../src/d1-store.ts";
import { createProducerStore } from "../../src/producer-store.ts";
import { nativeAccountRow } from "./native-account-row.ts";
import { timed, TIMING_R2 } from "../../src/request-timing.ts";
import * as lease from "../../src/lease-presence-native.ts";
import { recordIndexedHistoryFailure } from "../../src/indexed-history-status.ts";
import { ChainEventsRowSchema } from "../../schemas-src/lakehouse.ts";
import type { AccountFeedSelector } from "../../src/history-account-feed.ts";
import type { AccountFeedGroup } from "../../src/history-account-feed-groups.ts";

type Row = Record<string, unknown>;
/** Adapt the existing surface row fixtures to the native storage boundary.
 * The legacy fixture callbacks use predicate strings to select their rows and
 * inspect filters. These strings are diagnostics produced from actual native
 * arguments, never production queries. Formatters, routers, guards and cursor
 * composition execute unchanged. Native physical reads and complete folds are
 * independently covered by immutable Parquet, SQLite-oracle and real D1 tests. */
export function installNativeSurfaceFixtures() {
  const originals = {
    page: accounts.loadIndexedAccountFeedPage,
    groups: accounts.loadIndexedAccountFeedGroups,
    block: history.readSelectedHistoryBlock,
    hash: history.readSelectedHistoryHash,
    window: windows.loadIndexedChainWindow,
    stats: windows.loadIndexedChainWindowStats,
    daily: daily.loadIndexedAccountHistoryRows,
    ohlc: subnet.loadIndexedSubnetOhlcRows,
    summary: subnet.loadIndexedSubnetEventSummaryRows,
    weights: weights.loadNativeAccountWeightSetters,
    nominators: nominators.loadIndexedValidatorNominators,
    store: stores.selectedD1Store,
  };
  const restores: (() => void)[] = [];
  const active = (env: unknown) =>
    !!env && typeof env === "object" && "NATIVE_HISTORY_FIXTURE" in env;
  const table = (name: string, network?: string) =>
    `${network === "testnet" ? "chain_testnet" : "chain"}.${name}`;
  async function rows(query: string): Promise<Row[] | null> {
    try {
      const response = await timed(TIMING_R2, () =>
        globalThis.fetch("https://native-history-fixture.invalid", {
          method: "POST",
          body: JSON.stringify({ query }),
        }),
      );
      if (!response.ok) throw Error("fixture unavailable");
      const value = (await response.json()) as {
        success?: boolean;
        result?: { rows?: Row[] };
      };
      if (value.success === false || !Array.isArray(value.result?.rows))
        throw Error("fixture unavailable");
      return value.result.rows;
    } catch {
      recordIndexedHistoryFailure();
      return null;
    }
  }
  function predicates(selectors: readonly AccountFeedSelector[]) {
    return selectors
      .map((s) =>
        [
          ...(s.side === "all" ? [] : [`${s.side} = '${s.account}'`]),
          ...(s.kind ? [`event_kind = '${s.kind}'`] : []),
          ...(s.netuid != null ? [`netuid = ${s.netuid}`] : []),
          ...(s.blockStart != null ? [`block_number >= ${s.blockStart}`] : []),
          ...(s.blockEnd != null ? [`block_number <= ${s.blockEnd}`] : []),
          ...(s.observedStart != null
            ? [`observed_at >= ${s.observedStart}`]
            : []),
          ...(s.observedEnd != null ? [`observed_at <= ${s.observedEnd}`] : []),
          ...(s.counterparty
            ? [
                `${s.side === "hotkey" ? "coldkey" : "hotkey"} = '${s.counterparty}'`,
              ]
            : []),
          ...(s.cursor
            ? [
                `(observed_at, block_number, event_index) < (${s.cursor.join(", ")})`,
              ]
            : []),
        ].join(" AND "),
      )
      .join(" OR ");
  }
  function accountRow(row: Row) {
    return nativeAccountRow({
      block_number: null,
      event_index: null,
      observed_at: null,
      event_kind: null,
      ...row,
    });
  }
  function chainRow(row: Row) {
    return ChainEventsRowSchema.required().parse({
      block_number: null,
      event_index: null,
      observed_at: null,
      pallet: null,
      method: null,
      args: null,
      phase: null,
      extrinsic_index: null,
      ...row,
    });
  }
  beforeEach(() => {
    const originalIdentity = identities.loadIndexedSubnetIdentities;
    restores.push(
      vi
        .spyOn(identities, "loadIndexedSubnetIdentities")
        .mockImplementation(
          async (env, spec, netuid, cutoff, limit, network) => {
            if (!active(env))
              return originalIdentity(
                env,
                spec,
                netuid,
                cutoff,
                limit,
                network,
              );
            const where = `FROM ${table("account_events", network)} WHERE netuid = ${netuid} AND event_kind = '${spec.eventKind}' AND observed_at >= ${cutoff}`;
            const page = await rows(
              `SELECT * ${where} GROUP BY netuid, ${spec.distinctColumn} ORDER BY ${spec.countField} DESC LIMIT ${limit}`,
            );
            const totals = await rows(
              `SELECT count(*) AS ${spec.countField}, max(observed_at) AS newest_observed ${where}`,
            );
            const distinct = await rows(
              `SELECT count(*) AS ${spec.distinctField} FROM (SELECT netuid, ${spec.distinctColumn} ${where} GROUP BY netuid, ${spec.distinctColumn})`,
            );
            return page && totals?.[0] && distinct?.[0]
              ? { rows: page, totals: { ...totals[0], ...distinct[0] } }
              : null;
          },
        ).mockRestore,
    );

    const originalLease = lease.loadNativeLeasePresence;
    restores.push(
      vi
        .spyOn(lease, "loadNativeLeasePresence")
        .mockImplementation(async (env, network) => {
          if (!active(env)) return originalLease(env, network);
          const data = await rows(
            `SELECT * FROM ${table("chain_events", network)} WHERE method = 'SubnetLeaseCreated' OR method = 'SubnetLeaseTerminated' LIMIT 1`,
          );
          return data === null ? null : data.length > 0;
        }).mockRestore,
    );

    restores.push(
      vi
        .spyOn(accounts, "loadIndexedAccountFeedPage")
        .mockImplementation(async (...args) => {
          const [env, selectors, limit, offset = 0, network] = args;
          if (!active(env)) return originals.page(...args);
          const result = await rows(
            `SELECT * FROM ${table("account_events", network)} WHERE ${predicates(selectors)} ORDER BY observed_at DESC, block_number DESC, event_index DESC LIMIT ${limit + offset}`,
          );
          return (
            result?.slice(offset, offset + limit).map((r) =>
              accountRow({
                ...r,
                event_kind: r.event_kind ?? selectors[0]?.kind ?? null,
              }),
            ) ?? null
          );
        }).mockRestore,
    );
    restores.push(
      vi
        .spyOn(accounts, "loadIndexedAccountFeedGroups")
        .mockImplementation(async (...args) => {
          const [env, selectors, network] = args;
          if (!active(env)) return originals.groups(...args);
          const result = await rows(
            `SELECT event_kind, netuid, COUNT(*) AS event_count, SUM(amount_tao) AS total_tao FROM ${table("account_events", network)} WHERE ${predicates(selectors)} GROUP BY ${selectors.some((s) => s.kind) ? "netuid, event_kind" : "event_kind, netuid"}`,
          );
          return (
            (result?.map((r) => ({
              event_kind: r.event_kind ?? r.kind ?? selectors[0]?.kind ?? null,
              netuid: r.netuid ?? null,
              event_count:
                r.event_count ??
                r.count ??
                r.movements ??
                r.registrations ??
                r.announcements ??
                0,
              total_tao: r.total_tao ?? null,
              total_alpha: r.total_alpha ?? null,
              first_block: r.first_block ?? r.fb ?? 0,
              last_block: r.last_block ?? r.lb ?? 0,
              first_observed: r.first_observed ?? r.fo ?? 0,
              last_observed: r.last_observed ?? r.lo ?? 0,
            })) as AccountFeedGroup[] | undefined) ?? null
          );
        }).mockRestore,
    );
    restores.push(
      vi
        .spyOn(history, "readSelectedHistoryBlock")
        .mockImplementation(async (...args) => {
          const [env, name, block, network] = args;
          if (!active(env)) return originals.block(...args);
          const result = await rows(
            `SELECT * FROM ${table(name, network)} WHERE block_number = ${block}`,
          );
          return (
            result?.map((r) =>
              name === "account_events"
                ? accountRow(r)
                : name === "chain_events"
                  ? chainRow(r)
                  : r,
            ) ?? null
          );
        }).mockRestore,
    );
    restores.push(
      vi
        .spyOn(history, "readSelectedHistoryHash")
        .mockImplementation(async (...args) => {
          const [env, name, hash, network] = args;
          if (!active(env)) return originals.hash(...args);
          const result = await rows(
            `SELECT * FROM ${table(name, network)} WHERE ${name === "blocks" ? "block_hash" : "extrinsic_hash"} = '${hash}' LIMIT 1`,
          );
          return result === null ? null : (result[0] ?? []);
        }).mockRestore,
    );
    restores.push(
      vi
        .spyOn(windows, "loadIndexedChainWindow")
        .mockImplementation(async (...args) => {
          const [env, q, network] = args;
          if (!active(env)) return originals.window(...args);
          const result = await rows(
            `SELECT * FROM ${table("chain_events", network)} WHERE block_number > ${q.first} AND block_number <= ${q.last}${q.pallet ? ` AND pallet = '${q.pallet}'` : ""}${q.method ? ` AND method = '${q.method}'` : ""}${q.cursor ? ` AND event_index < ${q.cursor[2]}` : ""} ORDER BY block_number DESC, event_index DESC LIMIT ${q.limit}`,
          );
          return result?.map(chainRow) ?? null;
        }).mockRestore,
    );
    restores.push(
      vi
        .spyOn(windows, "loadIndexedChainWindowStats")
        .mockImplementation(async (...args) => {
          const [env, first, last, network] = args;
          if (!active(env)) return originals.stats(...args);
          return rows(
            `SELECT pallet, method, COUNT(*) AS count FROM ${table("chain_events", network)} WHERE block_number > ${first - 1} AND block_number <= ${last} GROUP BY pallet, method`,
          );
        }).mockRestore,
    );
    restores.push(
      vi
        .spyOn(daily, "loadIndexedAccountHistoryRows")
        .mockImplementation(async (...args) => {
          const [env, account, bounds, limit] = args;
          if (!active(env)) return originals.daily(...args);
          const days = await rows(
            `SELECT * FROM chain.account_events WHERE ${predicates([{ side: "hotkey", account, ...bounds }])} GROUP BY day, netuid ORDER BY day DESC, netuid DESC LIMIT ${limit}`,
          );
          if (days === null) return null;
          const kinds = await rows(
            `SELECT event_kind FROM chain.account_events WHERE hotkey = '${account}' GROUP BY day, netuid, event_kind`,
          );
          if (kinds === null) return null;
          return days.map((r) => ({
            ...r,
            event_kinds: [
              ...new Set(
                kinds
                  .filter(
                    (k) =>
                      k.day === r.day &&
                      k.netuid === r.netuid &&
                      k.event_kind != null,
                  )
                  .map((k) => String(k.event_kind)),
              ),
            ]
              .sort()
              .join(","),
          }));
        }).mockRestore,
    );
    restores.push(
      vi
        .spyOn(subnet, "loadIndexedSubnetOhlcRows")
        .mockImplementation(async (...args) => {
          const [env, netuid, cutoff, interval] = args;
          if (!active(env)) return originals.ohlc(...args);
          return rows(
            `SELECT FLOOR(observed_at / ${interval}) * ${interval} AS bucket_start FROM chain.account_events WHERE netuid = ${netuid} AND observed_at >= ${cutoff} GROUP BY bucket_start ORDER BY bucket_start DESC LIMIT 5001`,
          );
        }).mockRestore,
    );
    restores.push(
      vi
        .spyOn(subnet, "loadIndexedSubnetEventSummaryRows")
        .mockImplementation(async (...args) => {
          const [env, netuid, cutoff, limit] = args;
          if (!active(env)) return originals.summary(...args);
          const kinds = await rows(
              `SELECT count(*) AS event_count FROM chain.account_events WHERE netuid = ${netuid} AND observed_at >= ${cutoff} GROUP BY event_kind`,
            ),
            recent = await rows(
              `SELECT * FROM chain.account_events WHERE netuid = ${netuid} AND observed_at >= ${cutoff} ORDER BY observed_at DESC LIMIT ${limit}`,
            );
          return kinds && recent
            ? { kinds, recent: recent.map(accountRow) }
            : null;
        }).mockRestore,
    );
    restores.push(
      vi
        .spyOn(weights, "loadNativeAccountWeightSetters")
        .mockImplementation(async (...args) => {
          const [env, hotkey, slots, cutoff] = args;
          if (!active(env)) return originals.weights(...args);
          return (await rows(
            `SELECT netuid, COUNT(*) AS weight_sets FROM chain.account_events WHERE event_kind = 'WeightsSet' AND (hotkey = '${hotkey}' OR ${slots.map((s) => `(netuid = ${s.netuid} AND uid = ${s.uid})`).join(" OR ")}) AND observed_at >= ${cutoff} GROUP BY netuid`,
          )) as Awaited<ReturnType<typeof originals.weights>>;
        }).mockRestore,
    );
    restores.push(
      vi
        .spyOn(nominators, "loadIndexedValidatorNominators")
        .mockImplementation(async (...args) => {
          const [env, hotkey, cutoff, q] = args;
          if (!active(env)) return originals.nominators(...args);
          const found = await rows(
            `SELECT coldkey, SUM(amount_tao) AS net_staked_tao FROM chain.account_events WHERE hotkey = '${hotkey}' AND observed_at >= ${cutoff}${q.coldkey ? ` AND coldkey = '${q.coldkey}'` : ""} GROUP BY coldkey ORDER BY ${q.sort === "gross_staked" ? "gross_staked_tao" : q.sort === "last_activity" ? "last_observed" : "net_staked_tao"} DESC, coldkey ASC LIMIT ${q.limit + q.offset}`,
          );
          if (found === null) return null;
          const total = await rows(
            `SELECT COUNT(*) AS n FROM chain.account_events WHERE hotkey = '${hotkey}' AND observed_at >= ${cutoff} GROUP BY coldkey`,
          );
          return {
            rows: found as Awaited<
              ReturnType<typeof originals.nominators>
            > extends infer T
              ? T extends { rows: infer R }
                ? R
                : never
              : never,
            totalCount: Number(total?.[0]?.n ?? total?.[0]?.c ?? found.length),
          };
        }).mockRestore,
    );
    restores.push(
      vi.spyOn(stores, "selectedD1Store").mockImplementation((env, tables) => {
        if (!active(env) || !tables.includes("nominator_positions"))
          return originals.store(env, tables);
        return createProducerStore("native-fixture", {
          clientFactory: () => ({
            connect: async () => {},
            end: async () => {},
            query: async (sql, values) => {
              const text = sql.replace(
                /\$(\d+)/g,
                (_, n) => `'${values?.[Number(n) - 1]}'`,
              );
              const result = await rows(
                text.replaceAll(
                  "FROM nominator_positions",
                  "FROM chain.nominator_positions",
                ),
              );
              if (result === null) throw Error("selected fixture unavailable");
              return { rows: result };
            },
          }),
        });
      }).mockRestore,
    );
  });
  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) restore();
  });
}
