// Unit tests for the Postgres-serving data Worker (workers/data-api.mjs). postgres.js
// is mocked so the routing + response shaping are tested with no real DB — the live
// Hyperdrive→Railway path is validated separately.
import { beforeEach, test, expect, vi } from "vitest";
import { BLOCK_PAGINATION, MAX_OFFSET } from "../workers/request-params.mjs";
import { encodeCursor } from "../src/cursor.mjs";
import { formatSubnetHyperparams } from "../src/subnet-hyperparams.mjs";
import { hyperparamsHash } from "../src/subnet-hyperparams-history.mjs";
import { IDENTITY_FIELDS } from "../src/account-identity.mjs";
import { identityHash } from "../src/account-identity-history.mjs";
import {
  identityHash as subnetIdentityHash,
  identitySnapshotFromProfile,
} from "../src/subnet-identity-history.mjs";

const sqlCalls = vi.hoisted(() => []);
const sqlBeginOptions = vi.hoisted(() => []);
const mockRows = vi.hoisted(() => ({
  current: [
    {
      block_number: "123",
      event_index: 0,
      pallet: "System",
      method: "ExtrinsicSuccess",
      args: { x: 1 },
      phase: "ApplyExtrinsic",
      extrinsic_index: 2,
      observed_at: "100",
    },
  ],
}));
// A per-test queue of results for handlers that issue more than one query per
// request (the new blocks/extrinsics detail routes: main row + a prev/next
// neighbor lookup, or main row + embedded account_events) -- each top-level
// sql`` call shifts the next queued result; once empty, falls back to the
// single shared `mockRows.current` (preserving every existing chain-events
// test's simpler one-shape-fits-all behavior unchanged).
const mockQueue = vi.hoisted(() => ({ current: [] }));
// State for the neurons-sync write route's tests only (#4771) -- unused by
// every GET-route test above.
const neuronsSyncFailure = vi.hoisted(() => ({ error: null }));
// State for the backfill-neuron-daily write route's tests only -- separate
// from neuronsSyncFailure above so injecting one never affects the other's
// tests (both match on an INSERT INTO neuron_daily-adjacent pattern).
const neuronDailyBackfillFailure = vi.hoisted(() => ({ error: null }));
const neuronsSyncPruneRows = vi.hoisted(() => ({ current: [] }));
// State for the account-events-daily rollup write route's tests only (#4832).
const rollupFailure = vi.hoisted(() => ({ error: null }));
// State for the subnet-hyperparams-sync write route's tests only (#4832
// gap-closure): a failure hook mirroring neuronsSyncFailure/rollupFailure, a
// prune-rows hook mirroring neuronsSyncPruneRows, and the "latest hash per
// netuid" SELECT DISTINCT ON result the history diff reads before deciding
// which rows changed.
const subnetHyperparamsSyncFailure = vi.hoisted(() => ({ error: null }));
const subnetHyperparamsPruneRows = vi.hoisted(() => ({ current: [] }));
const subnetHyperparamsLatestHashes = vi.hoisted(() => ({ current: [] }));
// State for the account-identity-sync write route's tests only (#4832
// gap-closure). No prune-rows hook -- unlike subnet_hyperparams, this table
// has no purge step (see handleAccountIdentitySync's own header comment).
const accountIdentitySyncFailure = vi.hoisted(() => ({ error: null }));
const accountIdentityLatestHashes = vi.hoisted(() => ({ current: [] }));
// State for the validator-nominator-counts-sync write route's tests only
// (#2549). No prune/history hooks -- a single latest-only upsert, like
// health-checks-sync below, not a diff-and-append table.
const validatorNominatorCountsSyncFailure = vi.hoisted(() => ({
  error: null,
}));
// State for the subnet-identity-sync write route's tests only (#4832
// gap-closure). No prune-rows hook -- like account_identity, this table has
// no purge step. Its "latest hash per netuid" query shares subnet_hyperparams'
// `SELECT DISTINCT ON (netuid)` shape, so the mock below disambiguates on the
// hash column name (hyperparams_hash vs identity_hash) rather than the netuid
// grouping alone.
const subnetIdentitySyncFailure = vi.hoisted(() => ({ error: null }));
const subnetIdentityLatestHashes = vi.hoisted(() => ({ current: [] }));
// State for the health-checks-sync write route's tests only (#4832
// gap-closure). No hash-diff / latest-lookup query -- unlike the identity
// sync routes, this one just bulk-inserts + upserts the same probed batch
// D1/KV already received, so there's nothing to prime beyond the failure hook.
const healthChecksSyncFailure = vi.hoisted(() => ({ error: null }));
const healthUptimeRollupSyncFailure = vi.hoisted(() => ({ error: null }));
const subnetSnapshotSyncFailure = vi.hoisted(() => ({ error: null }));
const rpcUsageSyncFailure = vi.hoisted(() => ({ error: null }));
// State for the rpc-usage-prune write route's tests only (#5497
// gap-closure) -- a failure hook mirroring rpcUsageSyncFailure above, plus
// a controllable row count since this route's DELETE has no RETURNING
// clause (a plain array's mockRows.current wouldn't simulate `.count`).
const rpcUsagePruneFailure = vi.hoisted(() => ({ error: null }));
const rpcUsagePruneCount = vi.hoisted(() => ({ current: 0 }));
// State for the featured_validators read (#5166) tests only -- lets a test
// simulate the table not existing yet (pre-migration) without touching any
// other query's mock plumbing.
const featuredValidatorsQueryFailure = vi.hoisted(() => ({ error: null }));
// State for the /api/v1/validators + /api/v1/validators/:hotkey
// account_identity join (#5234) tests only. Dispatched by its own text match
// (like the DELETE FROM neurons / DELETE FROM subnet_hyperparams sql.unsafe
// branches below) rather than the shared mockQueue, so priming it never
// shifts any existing validators test's mockQueue-ordering assumptions.
const accountIdentityJoinRows = vi.hoisted(() => ({ current: [] }));
const accountIdentityJoinQueryFailure = vi.hoisted(() => ({ error: null }));
// State for the validator_nominator_counts READ (#2549) tests only -- same
// isolation purpose as featuredValidatorsQueryFailure above, but for the
// SELECT loadValidatorNominatorCounts issues (distinct from
// validatorNominatorCountsSyncFailure, which only matches the sync route's
// own INSERT).
const validatorNominatorCountsQueryFailure = vi.hoisted(() => ({
  error: null,
}));
// State for the subnet_hyperparams tempo READ (#2551) tests only -- same
// isolation purpose as validatorNominatorCountsQueryFailure above, but for
// loadSubnetTempos' own SELECT.
const subnetTemposQueryFailure = vi.hoisted(() => ({ error: null }));
// State for the nominator-positions-sync WRITE (#5233) tests only.
const nominatorPositionsSyncFailure = vi.hoisted(() => ({ error: null }));
// State for the account-balances-sync WRITE (#6742) tests only.
const accountBalancesSyncFailure = vi.hoisted(() => ({ error: null }));
// State for the nominator_positions READ (#5233) tests only -- same
// isolation purpose as subnetTemposQueryFailure above, but for
// loadNominatorPositions' own SELECT.
const nominatorPositionsQueryFailure = vi.hoisted(() => ({ error: null }));
// State for the /positions route's second query (#6769 gap-closure) --
// loadNeuronStakeByHotkeys' own sql.unsafe IN-list SELECT, isolated from
// nominatorPositionsQueryFailure above so a test can fail just this one
// without also failing the read it depends on.
const neuronStakeByHotkeyQueryFailure = vi.hoisted(() => ({ error: null }));
// State for GET /api/v1/accounts/:ss58/history's own SELECT (#6769
// gap-closure) -- this route has no per-query try/catch of its own, so a
// failure here is the one that reaches the router's OUTERMOST generic
// catch (captureDataApiError(err, url.pathname)), unlike every other flag
// above which targets a route with its own dedicated fallback.
const accountHistoryQueryFailure = vi.hoisted(() => ({ error: null }));
// State for the GET /api/v1/blocks/:ref retry test (METAGRAPHED-7) only. Unlike every failure
// hook above (which rejects every matching call for the test's duration), remainingFailures
// counts DOWN so a test can simulate "fails once, then the retry with a fresh client succeeds"
// (remainingFailures: 1) vs. "fails on both the original attempt and the retry" (2+). `code`
// controls whether the rejection looks like postgres.js's own retryable connection error
// (RETRYABLE_CONNECTION_ERROR_CODES in workers/data-api.mjs) or an unrelated error.
const blockDetailConnectionFailure = vi.hoisted(() => ({
  remainingFailures: 0,
  code: "CONNECTION_CLOSED",
}));

vi.mock("postgres", () => ({
  default: () => {
    // sql(rowsArray, ...columns) -- the bulk-insert helper (#4771's
    // handleNeuronsSync). Called as a plain function with a plain array (no
    // `.raw`), unlike a tagged-template call's strings array below -- returns
    // a marker the tagged-template branch expands when it appears as a `${}`
    // interpolation, mirroring postgres.js's real "insert multiple rows" helper.
    function sql(first, ...rest) {
      if (
        Array.isArray(first) &&
        !Object.prototype.hasOwnProperty.call(first, "raw")
      ) {
        const columns = rest.length ? rest : Object.keys(first[0] || {});
        return { __bulkInsert: true, rows: first, columns };
      }
      // Every tagged-template call (top-level query OR nested fragment)
      // resolves to rows; the handler awaits the outer query. A bulk-insert
      // marker interpolation expands to its own column list + VALUES tuples
      // instead of binding as a single opaque parameter.
      const strings = first;
      const values = rest;
      let text = strings[0];
      const boundValues = [];
      for (let i = 0; i < values.length; i += 1) {
        const v = values[i];
        if (v && v.__bulkInsert) {
          const cols = v.columns;
          text += `(${cols.join(",")}) VALUES ${v.rows
            .map(() => `(${cols.map(() => "?").join(",")})`)
            .join(",")}`;
          for (const row of v.rows) {
            for (const col of cols) boundValues.push(row[col] ?? null);
          }
        } else {
          text += "?";
          boundValues.push(v);
        }
        text += strings[i + 1];
      }
      sqlCalls.push({ text, values: boundValues });
      if (neuronsSyncFailure.error && /INSERT INTO neurons\b/.test(text)) {
        return Promise.reject(neuronsSyncFailure.error);
      }
      if (
        neuronDailyBackfillFailure.error &&
        /INSERT INTO neuron_daily\b/.test(text)
      ) {
        return Promise.reject(neuronDailyBackfillFailure.error);
      }
      if (
        rollupFailure.error &&
        /INSERT INTO account_events_daily/.test(text)
      ) {
        return Promise.reject(rollupFailure.error);
      }
      if (
        accountHistoryQueryFailure.error &&
        /FROM account_events_daily\b/.test(text)
      ) {
        return Promise.reject(accountHistoryQueryFailure.error);
      }
      if (
        subnetHyperparamsSyncFailure.error &&
        /INSERT INTO subnet_hyperparams\b/.test(text)
      ) {
        return Promise.reject(subnetHyperparamsSyncFailure.error);
      }
      if (
        accountIdentitySyncFailure.error &&
        /INSERT INTO account_identity\b/.test(text)
      ) {
        return Promise.reject(accountIdentitySyncFailure.error);
      }
      if (
        validatorNominatorCountsSyncFailure.error &&
        /INSERT INTO validator_nominator_counts\b/.test(text)
      ) {
        return Promise.reject(validatorNominatorCountsSyncFailure.error);
      }
      if (
        nominatorPositionsSyncFailure.error &&
        /INSERT INTO nominator_positions\b/.test(text)
      ) {
        return Promise.reject(nominatorPositionsSyncFailure.error);
      }
      if (
        accountBalancesSyncFailure.error &&
        /INSERT INTO account_balances\b/.test(text)
      ) {
        return Promise.reject(accountBalancesSyncFailure.error);
      }
      if (
        nominatorPositionsQueryFailure.error &&
        /FROM nominator_positions\b/.test(text)
      ) {
        return Promise.reject(nominatorPositionsQueryFailure.error);
      }
      if (
        subnetSnapshotSyncFailure.error &&
        /INSERT INTO subnet_snapshots\b/.test(text)
      ) {
        return Promise.reject(subnetSnapshotSyncFailure.error);
      }
      if (
        rpcUsageSyncFailure.error &&
        /INSERT INTO rpc_proxy_events\b/.test(text)
      ) {
        return Promise.reject(rpcUsageSyncFailure.error);
      }
      if (
        rpcUsagePruneFailure.error &&
        /DELETE FROM rpc_proxy_events\b/.test(text)
      ) {
        return Promise.reject(rpcUsagePruneFailure.error);
      }
      if (
        subnetIdentitySyncFailure.error &&
        /INSERT INTO subnet_identity_history\b/.test(text)
      ) {
        return Promise.reject(subnetIdentitySyncFailure.error);
      }
      if (
        healthChecksSyncFailure.error &&
        /INSERT INTO surface_checks\b/.test(text)
      ) {
        return Promise.reject(healthChecksSyncFailure.error);
      }
      if (
        featuredValidatorsQueryFailure.error &&
        /FROM featured_validators\b/.test(text)
      ) {
        return Promise.reject(featuredValidatorsQueryFailure.error);
      }
      if (
        validatorNominatorCountsQueryFailure.error &&
        /FROM validator_nominator_counts\b/.test(text)
      ) {
        return Promise.reject(validatorNominatorCountsQueryFailure.error);
      }
      if (
        subnetTemposQueryFailure.error &&
        /FROM subnet_hyperparams\b/.test(text)
      ) {
        return Promise.reject(subnetTemposQueryFailure.error);
      }
      if (
        healthUptimeRollupSyncFailure.error &&
        /INSERT INTO surface_uptime_daily\b/.test(text)
      ) {
        return Promise.reject(healthUptimeRollupSyncFailure.error);
      }
      if (/DELETE FROM neurons/.test(text)) {
        return Promise.resolve(neuronsSyncPruneRows.current);
      }
      if (/DELETE FROM rpc_proxy_events\b/.test(text)) {
        return Promise.resolve({ count: rpcUsagePruneCount.current });
      }
      if (/SELECT DISTINCT ON \(netuid\) netuid, hyperparams_hash/.test(text)) {
        return Promise.resolve(subnetHyperparamsLatestHashes.current);
      }
      if (/SELECT DISTINCT ON \(netuid\) netuid, identity_hash/.test(text)) {
        return Promise.resolve(subnetIdentityLatestHashes.current);
      }
      if (/SELECT DISTINCT ON \(account\)/.test(text)) {
        return Promise.resolve(accountIdentityLatestHashes.current);
      }
      if (
        blockDetailConnectionFailure.remainingFailures > 0 &&
        /FROM blocks WHERE block_number = \?/.test(text)
      ) {
        blockDetailConnectionFailure.remainingFailures -= 1;
        return Promise.reject(
          Object.assign(
            new Error(
              `write ${blockDetailConnectionFailure.code} mock.hyperdrive.local:5432`,
            ),
            { code: blockDetailConnectionFailure.code },
          ),
        );
      }
      if (mockQueue.current.length) {
        return Promise.resolve(mockQueue.current.shift());
      }
      return Promise.resolve(mockRows.current);
    }
    sql.end = () => Promise.resolve();
    // sql.unsafe(text, params) -- the neurons-sync prune's per-netuid VALUES
    // join (#4771 hotfix: a bound JS array broke under this Worker's real
    // Hyperdrive `fetch_types: false` setting, so the prune builds its own
    // placeholder text instead of relying on tagged-template array binding).
    // Recorded into the SAME sqlCalls list so existing assertions work
    // unchanged regardless of which call form produced them.
    sql.unsafe = (text, params = []) => {
      sqlCalls.push({ text, values: params });
      if (/DELETE FROM neurons/.test(text)) {
        return Promise.resolve(neuronsSyncPruneRows.current);
      }
      if (/DELETE FROM subnet_hyperparams\b/.test(text)) {
        return Promise.resolve(subnetHyperparamsPruneRows.current);
      }
      if (/FROM account_identity WHERE account IN/.test(text)) {
        if (accountIdentityJoinQueryFailure.error) {
          return Promise.reject(accountIdentityJoinQueryFailure.error);
        }
        return Promise.resolve(accountIdentityJoinRows.current);
      }
      if (/stake_tao FROM neurons WHERE hotkey IN/.test(text)) {
        if (neuronStakeByHotkeyQueryFailure.error) {
          return Promise.reject(neuronStakeByHotkeyQueryFailure.error);
        }
        return Promise.resolve(mockRows.current);
      }
      return Promise.resolve(mockRows.current);
    };
    // sql.begin(["read only",] cb) reserves a connection for cb in real
    // postgres.js; the mock invokes cb with a wrapped sql so every existing
    // tagged-template assertion (sqlCalls, mockQueue) still sees the
    // identical call stream, and resolves to whatever cb returns.
    //
    // #5220: this wrapper also mirrors a real postgres.js behavior that an
    // earlier, naive `cb(sql)` pass-through did NOT reproduce and that let a
    // production bug ship past this suite -- every query issued directly
    // against a `begin()` transaction's `sql` poisons the whole transaction
    // if it rejects, even when the *caller* catches that rejection locally
    // (postgres.js tracks it via each query's own internal `.catch()`; see
    // node_modules/postgres/src/index.js's `scope()`/`uncaughtError`).
    // `sql.savepoint(fn)` is the only way to isolate a query's failure from
    // the enclosing transaction, so it runs `fn` against the unwrapped sql
    // (no poisoning) instead.
    sql.begin = (optionsOrCb, maybeCb) => {
      const cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
      sqlBeginOptions.push(typeof optionsOrCb === "string" ? optionsOrCb : "");
      let uncaughtError;
      function scopedSql(...args) {
        const result = sql(...args);
        Promise.resolve(result).catch((e) => {
          if (!uncaughtError) uncaughtError = e;
        });
        return result;
      }
      Object.assign(scopedSql, sql);
      scopedSql.savepoint = (fn) => fn(sql);
      return Promise.resolve(cb(scopedSql)).then((result) => {
        if (uncaughtError) throw uncaughtError;
        return result;
      });
    };
    return sql;
  },
}));

const { default: worker } = await import("../workers/data-api.mjs");
const NEURONS_SYNC_SECRET = "test-neurons-sync-secret";
const NEURON_DAILY_BACKFILL_SECRET = "test-neuron-daily-backfill-secret";
const ROLLUP_SYNC_SECRET = "test-rollup-sync-secret";
const SUBNET_HYPERPARAMS_SYNC_SECRET = "test-subnet-hyperparams-sync-secret";
const ACCOUNT_IDENTITY_SYNC_SECRET = "test-account-identity-sync-secret";
const VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET =
  "test-validator-nominator-counts-sync-secret";
const SUBNET_IDENTITY_SYNC_SECRET = "test-subnet-identity-sync-secret";
const HEALTH_CHECKS_SYNC_SECRET = "test-health-checks-sync-secret";
const SUBNET_SNAPSHOT_SYNC_SECRET = "test-subnet-snapshot-sync-secret";
const RPC_USAGE_SYNC_SECRET = "test-rpc-usage-sync-secret";
const NOMINATOR_POSITIONS_SYNC_SECRET = "test-nominator-positions-sync-secret";
const ACCOUNT_BALANCES_SYNC_SECRET = "test-account-balances-sync-secret";
const env = {
  HYPERDRIVE: { connectionString: "postgres://mock" },
  NEURONS_SYNC_SECRET,
  NEURON_DAILY_BACKFILL_SECRET,
  ROLLUP_SYNC_SECRET,
  SUBNET_HYPERPARAMS_SYNC_SECRET,
  ACCOUNT_IDENTITY_SYNC_SECRET,
  VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET,
  SUBNET_IDENTITY_SYNC_SECRET,
  HEALTH_CHECKS_SYNC_SECRET,
  SUBNET_SNAPSHOT_SYNC_SECRET,
  RPC_USAGE_SYNC_SECRET,
  NOMINATOR_POSITIONS_SYNC_SECRET,
  ACCOUNT_BALANCES_SYNC_SECRET,
};
const ctx = { waitUntil() {} };
const req = (path, init) =>
  worker.fetch(new Request(`https://d${path}`, init), env, ctx);
const queryText = () => sqlCalls.map((call) => call.text).join("\n");

beforeEach(() => {
  sqlCalls.length = 0;
  sqlBeginOptions.length = 0;
  mockQueue.current = [];
  neuronsSyncFailure.error = null;
  neuronDailyBackfillFailure.error = null;
  neuronsSyncPruneRows.current = [];
  rollupFailure.error = null;
  subnetHyperparamsSyncFailure.error = null;
  subnetHyperparamsPruneRows.current = [];
  subnetHyperparamsLatestHashes.current = [];
  accountIdentitySyncFailure.error = null;
  accountIdentityLatestHashes.current = [];
  validatorNominatorCountsSyncFailure.error = null;
  validatorNominatorCountsQueryFailure.error = null;
  subnetTemposQueryFailure.error = null;
  nominatorPositionsSyncFailure.error = null;
  nominatorPositionsQueryFailure.error = null;
  accountBalancesSyncFailure.error = null;
  neuronStakeByHotkeyQueryFailure.error = null;
  accountHistoryQueryFailure.error = null;
  subnetIdentitySyncFailure.error = null;
  subnetIdentityLatestHashes.current = [];
  healthChecksSyncFailure.error = null;
  subnetSnapshotSyncFailure.error = null;
  healthUptimeRollupSyncFailure.error = null;
  rpcUsageSyncFailure.error = null;
  rpcUsagePruneFailure.error = null;
  rpcUsagePruneCount.current = 0;
  featuredValidatorsQueryFailure.error = null;
  accountIdentityJoinRows.current = [];
  accountIdentityJoinQueryFailure.error = null;
  blockDetailConnectionFailure.remainingFailures = 0;
  blockDetailConnectionFailure.code = "CONNECTION_CLOSED";
  mockRows.current = [
    {
      block_number: "123",
      event_index: 0,
      pallet: "System",
      method: "ExtrinsicSuccess",
      args: { x: 1 },
      phase: "ApplyExtrinsic",
      extrinsic_index: 2,
      observed_at: "100",
    },
  ];
});

test("chain-events coerces blank bigint cells to null, not zero", async () => {
  mockRows.current = [
    {
      block_number: "",
      event_index: "   ",
      pallet: "System",
      method: "ExtrinsicSuccess",
      args: { x: 1 },
      phase: "ApplyExtrinsic",
      extrinsic_index: 2,
      observed_at: "",
    },
  ];
  const res = await req("/api/v1/chain-events?limit=1");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.events[0].block_number).toBeNull();
  expect(body.events[0].observed_at).toBeNull();
  // Blank seek keys must not produce a lossless cursor token.
  expect(body.next_cursor).toBeNull();
});

test("chain-events coerces null and non-numeric bigint cells to null", async () => {
  mockRows.current = [
    {
      block_number: null,
      event_index: 0,
      pallet: "System",
      method: "ExtrinsicSuccess",
      args: { x: 1 },
      phase: "ApplyExtrinsic",
      extrinsic_index: 2,
      observed_at: "not-a-number",
    },
  ];
  const res = await req("/api/v1/blocks/123/chain-events");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.events[0].block_number).toBeNull();
  expect(body.events[0].observed_at).toBeNull();
});

test("GET /api/v1/blocks/:n/chain-events returns the block's events", async () => {
  const res = await req("/api/v1/blocks/123/chain-events");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.block_number).toBe(123);
  expect(body.count).toBe(1);
  expect(body.events[0].pallet).toBe("System");
  expect(body.events[0].method).toBe("ExtrinsicSuccess");
  // observed_at is coerced from the postgres.js BIGINT string to a number.
  expect(body.events[0].observed_at).toBe(100);
  expect(typeof body.events[0].observed_at).toBe("number");
});

// #4685: chain_events.args decodes AccountId32 byte arrays to SS58 (or hex
// for non-account/untagged values) -- fixtures below are real production
// rows, independently re-verified directly against Postgres during this
// session, not synthetic examples.
test("chain-events decodes an account-keyed field (TransactionFeePaid.who) to SS58", async () => {
  mockRows.current = [
    {
      block_number: "8587754",
      event_index: 412,
      pallet: "TransactionPayment",
      method: "TransactionFeePaid",
      args: {
        tip: 0,
        who: [
          [
            230, 177, 94, 10, 88, 222, 149, 217, 176, 218, 228, 3, 237, 17, 117,
            251, 19, 70, 95, 132, 123, 114, 171, 235, 189, 66, 130, 2, 183, 175,
            143, 88,
          ],
        ],
        actual_fee: 2131419,
      },
      phase: "ApplyExtrinsic",
      extrinsic_index: 200,
      observed_at: "100",
    },
  ];
  const res = await req("/api/v1/chain-events?limit=1");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.events[0].args.who).toBe(
    "5HHBZRFX9UiyG77qU1pn1qMceRYKeg2a4yGBwPCHCyDocX4i",
  );
  expect(body.events[0].args.tip).toBe(0);
  expect(body.events[0].args.actual_fee).toBe(2131419);
});

test("chain-events decodes both account-keyed fields of a Balances.Transfer (to and from)", async () => {
  mockRows.current = [
    {
      block_number: "8587754",
      event_index: 119,
      pallet: "Balances",
      method: "Transfer",
      args: {
        to: [
          [
            109, 111, 100, 108, 115, 117, 98, 116, 101, 110, 115, 114, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          ],
        ],
        from: [
          [
            109, 111, 100, 108, 115, 117, 98, 116, 101, 110, 115, 114, 15, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          ],
        ],
        amount: 30681,
      },
      phase: "ApplyExtrinsic",
      extrinsic_index: 100,
      observed_at: "100",
    },
  ];
  const res = await req("/api/v1/blocks/123/chain-events");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.events[0].args.to).toBe(
    "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F",
  );
  expect(body.events[0].args.from).toBe(
    "5EYCAe5jLQhn6ofDSvuKE7htj4zVF4Tq1J7DTNzTePVJucfX",
  );
  expect(body.events[0].args.amount).toBe(30681);
});

test("chain-events decodes a positional SubtensorModule.TimelockedWeightsRevealed [netuid, who] to SS58 via coerceEvent's ctx (#5359/#61, fixed 2026-07-14)", async () => {
  // Real SubtensorModule.TimelockedWeightsRevealed row (block 8587756, event
  // 2). Previously hex-encoded the who field for lack of a key hint at any
  // depth -- coerceEvent already passed row.pallet/row.method as ctx, but
  // decodeChainEventArgs only used ctx for the TEXTUAL/HEX_BLOB/ENUM_PAYLOAD
  // allowlists, never to recover a positional tuple's field names. Fixed by
  // POSITIONAL_FIELD_NAMES (src/chain-event-args.mjs) -- see
  // tests/chain-event-args.test.mjs for the exhaustive per-event-kind unit
  // coverage; this is the one route-level regression test proving the fix
  // reaches a real REST response, not just the decoder in isolation.
  mockRows.current = [
    {
      block_number: "8587756",
      event_index: 2,
      pallet: "SubtensorModule",
      method: "TimelockedWeightsRevealed",
      args: [
        78,
        [
          [
            162, 193, 121, 87, 196, 67, 129, 183, 243, 158, 111, 10, 171, 37,
            31, 122, 9, 152, 89, 131, 234, 97, 249, 41, 16, 168, 179, 154, 146,
            252, 209, 69,
          ],
        ],
      ],
      phase: "ApplyExtrinsic",
      extrinsic_index: 50,
      observed_at: "100",
    },
  ];
  const res = await req("/api/v1/blocks/123/chain-events");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.events[0].args).toEqual([
    78,
    "5Fk765B4CRBekwErwE5VxvveWhHztHSfsnsLt8cbDayDWsuk",
  ]);
});

test("GET /api/v1/chain-events returns the feed with a cursor (filters + before)", async () => {
  const res = await req(
    "/api/v1/chain-events?limit=1&pallet=System&method=ExtrinsicSuccess&before=500",
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.count).toBe(1);
  expect(body.next_before).toBe(123); // rows.length === limit → cursor is the last row
  expect(body.next_cursor).toBe("100.123.0"); // lossless observed_at.block_number.event_index cursor
  // BIGINT columns are coerced from postgres.js strings to numbers (D1-route parity).
  expect(body.events[0].block_number).toBe(123);
  expect(typeof body.events[0].block_number).toBe("number");
  expect(body.events[0].observed_at).toBe(100);
  expect(typeof body.events[0].observed_at).toBe("number");
});

test("chain-events cursor seeks by observed_at, block_number and event_index", async () => {
  const res = await req(
    "/api/v1/chain-events?limit=1&cursor=50.123.4&before=500",
  );
  expect(res.status).toBe(200);
  expect(queryText()).toContain(
    "AND (observed_at, block_number, event_index) < (?, ?, ?)",
  );
  expect(queryText()).not.toContain("AND block_number <");
  const cursorCall = sqlCalls.find((call) =>
    call.text.includes("(observed_at, block_number, event_index) <"),
  );
  expect(cursorCall.values).toEqual([50, 123, 4]);
});

test("limit is clamped and defaults safely", async () => {
  const res = await req("/api/v1/chain-events?limit=99999");
  expect(res.status).toBe(200); // clamp to MAX_LIMIT, no error
});

test("chain-events preserves a minimum limit after flooring a fractional value", async () => {
  // A fractional 0<n<1 limit floored to 0 binds LIMIT 0 and then dereferences
  // rows[-1] for the cursor (TypeError → 502); it must clamp up to 1 instead.
  const res = await req("/api/v1/chain-events?limit=0.5");
  expect(res.status).toBe(200);
  expect(sqlCalls.at(-1).values).toContain(1);
  expect(sqlCalls.at(-1).values).not.toContain(0);
});

test("chain-events accepts block + extrinsic filters (extrinsic-detail view)", async () => {
  const res = await req("/api/v1/chain-events?block=5870000&extrinsic=3");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.count).toBe(1);
  expect(queryText()).toContain("AND block_number =");
  expect(queryText()).toContain("AND extrinsic_index =");
  // non-numeric filter values are ignored, not errors:
  const res2 = await req("/api/v1/chain-events?block=abc&extrinsic=");
  expect(res2.status).toBe(200);
});

test("chain-events ignores malformed integer position filters", async () => {
  const cases = [
    "/api/v1/chain-events?block=1.5&extrinsic=2&before=3",
    "/api/v1/chain-events?block=-1&extrinsic=2&before=3",
    "/api/v1/chain-events?block=1e3&extrinsic=2&before=3",
    "/api/v1/chain-events?block=9007199254740993&extrinsic=2&before=3",
    "/api/v1/chain-events?block=12&extrinsic=3.5",
    "/api/v1/chain-events?block=12&extrinsic=-3",
    "/api/v1/chain-events?before=3.5",
    "/api/v1/chain-events?before=-3",
    "/api/v1/chain-events?before=1e3",
    "/api/v1/chain-events?before=9007199254740993",
  ];

  for (const path of cases) {
    sqlCalls.length = 0;
    const res = await req(path);
    expect(res.status).toBe(200);
    const values = sqlCalls.flatMap((call) => call.values);
    expect(values).not.toContain(1.5);
    expect(values).not.toContain(3.5);
    expect(values).not.toContain(-1);
    expect(values).not.toContain(-3);
    expect(values).not.toContain(1000);
  }
});

test("chain-events ignores extrinsic without block to avoid global scans", async () => {
  const res = await req("/api/v1/chain-events?extrinsic=999999&limit=1");
  expect(res.status).toBe(200);
  expect(queryText()).not.toContain("AND extrinsic_index =");
  expect(queryText()).not.toContain("AND block_number =");
});

test("chain-events rejects method-only feed filters without a block scope", async () => {
  const res = await req("/api/v1/chain-events?method=ExtrinsicSuccess");
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/method filter requires pallet/);
});

test("chain-events/stats returns the activity aggregate with a clamped window", async () => {
  const res = await req("/api/v1/chain-events/stats?blocks=500");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window_blocks).toBe(500);
  expect(Array.isArray(body.activity)).toBe(true);
  // window clamps: oversized → 5000, non-numeric → default 1000
  expect(
    (await (await req("/api/v1/chain-events/stats?blocks=99999")).json())
      .window_blocks,
  ).toBe(5000);
  expect(
    (await (await req("/api/v1/chain-events/stats?blocks=abc")).json())
      .window_blocks,
  ).toBe(1000);
});

test("chain-events/stats ranks with a deterministic tie-break on the group key", async () => {
  const res = await req("/api/v1/chain-events/stats?blocks=500");
  expect(res.status).toBe(200);
  // count is non-unique; the ranking must tie-break on the GROUP BY key so the
  // order and the LIMIT 100 boundary membership are stable across identical
  // requests rather than left to Postgres' unordered equal-count grouping.
  const stats = sqlCalls.at(-1).text;
  expect(stats).toContain("ORDER BY count DESC, pallet ASC, method ASC");
  expect(stats).not.toMatch(/ORDER BY count DESC\s+LIMIT/);
});

test("chain-events/stats floors fractional blocks before binding", async () => {
  const res = await req("/api/v1/chain-events/stats?blocks=1.5");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window_blocks).toBe(1);
  expect(sqlCalls.at(-1).values).toContain(1);
  expect(sqlCalls.at(-1).values).not.toContain(1.5);
});

test("chain-events/stats preserves minimum block window after flooring", async () => {
  const res = await req("/api/v1/chain-events/stats?blocks=0.5");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window_blocks).toBe(1);
  expect(sqlCalls.at(-1).values).toContain(1);
  expect(sqlCalls.at(-1).values).not.toContain(0);
});

test("chain-events rejects overlong or non-enumerable pallet/method filters", async () => {
  const res = await req(`/api/v1/chain-events?pallet=${"A".repeat(65)}`);
  expect(res.status).toBe(400);
  const punct = await req("/api/v1/chain-events?pallet=System;DROP");
  expect(punct.status).toBe(400);
});

// ---- D1 serving-cutover routes (#4656 followup): blocks + extrinsics -------

const BLOCK_ROW = {
  block_number: "8586300",
  block_hash: "0xabc",
  parent_hash: "0xdef",
  author: "5Author",
  extrinsic_count: 5,
  event_count: 10,
  spec_version: 424,
  observed_at: "1783600000000",
};

const EXTRINSIC_HASH = `0x${"a".repeat(64)}`;

const EXTRINSIC_ROW = {
  block_number: "8586300",
  extrinsic_index: 2,
  extrinsic_hash: EXTRINSIC_HASH,
  signer: "5Signer",
  call_module: "SubtensorModule",
  call_function: "set_weights",
  call_args: '{"a":1}', // simulates the ::text cast of a JSONB column
  success: true,
  fee_tao: "0.01",
  tip_tao: "0",
  observed_at: "1783600000000",
};

const SS58 = "5Hot";
const ACCOUNT_EVENT_ROW = {
  block_number: "8586300",
  event_index: 0,
  extrinsic_index: 2,
  event_kind: "StakeAdded",
  hotkey: SS58,
  coldkey: "5Cold",
  netuid: 4,
  uid: 1,
  amount_tao: "1.5",
  alpha_amount: "0",
  observed_at: "1783600000000",
};

test("GET /api/v1/blocks returns a block feed shaped like the D1 route", async () => {
  mockRows.current = [BLOCK_ROW];
  const res = await req("/api/v1/blocks?limit=1");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.schema_version).toBe(1);
  expect(body.block_count).toBe(1);
  expect(body.blocks[0].block_number).toBe(8586300);
  expect(typeof body.blocks[0].block_number).toBe("number");
  expect(body.blocks[0].author).toBe("5Author");
  expect(body.next_cursor).toBe("8586300"); // rows.length === limit
});

test("GET /api/v1/blocks applies the same filter set as loadBlocks", async () => {
  mockRows.current = [BLOCK_ROW];
  await req(
    "/api/v1/blocks?author=5A&spec_version=424&block_start=1&block_end=2&from=1&to=2&min_extrinsics=1&min_events=1",
  );
  const text = queryText();
  expect(text).toContain("AND author =");
  expect(text).toContain("AND spec_version =");
  expect(text).toContain("AND block_number >=");
  expect(text).toContain("AND block_number <=");
  expect(text).toContain("AND observed_at >=");
  expect(text).toContain("AND observed_at <=");
  expect(text).toContain("AND extrinsic_count >=");
  expect(text).toContain("AND event_count >=");
});

test("GET /api/v1/blocks uses a cursor seek instead of OFFSET when cursor is present", async () => {
  mockRows.current = [BLOCK_ROW];
  await req("/api/v1/blocks?cursor=8586300");
  const text = queryText();
  expect(text).toContain("AND block_number <");
  expect(text).not.toContain("OFFSET");
});

test("GET /api/v1/blocks clamps page size and offset before querying Postgres", async () => {
  mockRows.current = [BLOCK_ROW];
  await req("/api/v1/blocks?limit=999999&offset=999999999");

  const queryValues = sqlCalls.flatMap((call) => call.values);
  expect(queryValues).toContain(BLOCK_PAGINATION.maxLimit);
  expect(queryValues).toContain(MAX_OFFSET);
  expect(queryValues).not.toContain(999999);
  expect(queryValues).not.toContain(999999999);
});

test("GET /api/v1/blocks/:ref resolves a numeric ref + neighbors", async () => {
  // Queue slot 0 is the unconditional `SET statement_timeout` call every
  // request issues before any route matching runs.
  mockQueue.current = [[], [BLOCK_ROW], [{ prev: 8586299, next: 8586301 }]];
  const res = await req("/api/v1/blocks/8586300");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.block.block_number).toBe(8586300);
  expect(body.prev_block_number).toBe(8586299);
  expect(body.next_block_number).toBe(8586301);
});

test("GET /api/v1/blocks/:ref resolves a lowercased hash ref", async () => {
  mockQueue.current = [[], [BLOCK_ROW], [{ prev: null, next: null }]];
  const upperHash = `0x${"ABC".repeat(21)}D`; // 64 hex chars, mixed-case
  const res = await req(`/api/v1/blocks/${upperHash}`);
  expect(res.status).toBe(200);
  expect(sqlCalls.some((c) => c.values.includes(upperHash.toLowerCase()))).toBe(
    true,
  );
});

test("GET /api/v1/blocks/:ref on a malformed ref skips the query entirely (block:null)", async () => {
  const res = await req("/api/v1/blocks/not-a-real-ref");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.block).toBeNull();
  expect(sqlCalls.length).toBe(1); // only the unconditional SET call
});

test("GET /api/v1/blocks/:ref on an unknown block skips the neighbor query", async () => {
  mockRows.current = [];
  const res = await req("/api/v1/blocks/999999999");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.block).toBeNull();
  expect(body.prev_block_number).toBeNull();
  expect(body.next_block_number).toBeNull();
  expect(sqlCalls.length).toBe(2); // SET + the main lookup, no neighbor query
});

test("GET /api/v1/blocks/:ref retries once with a fresh client after a Hyperdrive CONNECTION_CLOSED, then succeeds (METAGRAPHED-7)", async () => {
  blockDetailConnectionFailure.remainingFailures = 1;
  // 4 slots: SET (attempt 1, discarded before the connection error), SET (attempt 2), the
  // block-lookup row (attempt 2, the one that failed on attempt 1), the neighbor lookup.
  mockQueue.current = [[], [], [BLOCK_ROW], [{ prev: 8586299, next: 8586301 }]];
  const res = await req("/api/v1/blocks/8586300");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.block.block_number).toBe(8586300);
  expect(body.prev_block_number).toBe(8586299);
  expect(body.next_block_number).toBe(8586301);
});

test("GET /api/v1/blocks/:ref falls through to the generic 502 when the retry also hits a connection error (METAGRAPHED-7)", async () => {
  blockDetailConnectionFailure.remainingFailures = 2; // fails the original attempt AND the retry
  const res = await req("/api/v1/blocks/8586300");
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.error).toBe("data query failed");
});

test("GET /api/v1/blocks/:ref does not retry a non-connection error, even once (METAGRAPHED-7 scoping)", async () => {
  // remainingFailures would allow a "successful" retry if the code retried blindly -- asserting
  // 502 here proves the retry is scoped to RETRYABLE_CONNECTION_ERROR_CODES, not every error.
  blockDetailConnectionFailure.remainingFailures = 1;
  blockDetailConnectionFailure.code = "SOME_OTHER_ERROR";
  mockQueue.current = [[], [], [BLOCK_ROW], [{ prev: 8586299, next: 8586301 }]];
  const res = await req("/api/v1/blocks/8586300");
  expect(res.status).toBe(502);
});

test("GET /api/v1/blocks/summary is matched before /blocks/:ref (never treats 'summary' as a ref)", async () => {
  mockRows.current = [BLOCK_ROW];
  const res = await req("/api/v1/blocks/summary");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.block_count).toBe(1);
  expect(body.last_block).toBe(8586300);
  expect(queryText()).toContain("FROM blocks ORDER BY block_number DESC LIMIT");
});

test("GET /api/v1/blocks/summary with no rows returns the zeroed card, not a throw", async () => {
  mockRows.current = [];
  const res = await req("/api/v1/blocks/summary");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.block_count).toBe(0);
});

test("GET /api/v1/blocks/:ref/extrinsics resolves the ref then reads the block's extrinsics in index order", async () => {
  mockQueue.current = [
    [], // SET
    [{ block_number: 8586300 }], // resolveBlockNumberPg
    [EXTRINSIC_ROW],
  ];
  const res = await req("/api/v1/blocks/8586300/extrinsics");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.block_number).toBe(8586300);
  expect(body.data.extrinsics[0].signer).toBe("5Signer");
  expect(queryText()).toContain("ORDER BY extrinsic_index ASC");
});

test("GET /api/v1/blocks/:ref/extrinsics on an unresolved ref returns block_number:null, extrinsics:[] without querying extrinsics", async () => {
  mockQueue.current = [[], []]; // SET, resolveBlockNumberPg finds nothing
  const res = await req("/api/v1/blocks/999999999/extrinsics");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.block_number).toBeNull();
  expect(body.data.extrinsics).toEqual([]);
  expect(sqlCalls.length).toBe(2); // SET + the resolve query, no extrinsics query
});

test("GET /api/v1/blocks/:ref/events resolves the ref then reads the block's account_events in index order", async () => {
  mockQueue.current = [
    [], // SET
    [{ block_number: 8586300 }], // resolveBlockNumberPg
    [ACCOUNT_EVENT_ROW],
  ];
  const res = await req("/api/v1/blocks/8586300/events");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.block_number).toBe(8586300);
  expect(body.data.events[0].event_kind).toBe("StakeAdded");
  expect(queryText()).toContain("FROM account_events WHERE block_number");
  expect(queryText()).toContain("ORDER BY event_index ASC");
});

test("GET /api/v1/blocks/:ref/events on an unresolved ref returns block_number:null, events:[] without querying account_events", async () => {
  mockQueue.current = [[], []]; // SET, resolveBlockNumberPg finds nothing
  const res = await req("/api/v1/blocks/999999999/events");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.block_number).toBeNull();
  expect(body.data.events).toEqual([]);
  expect(sqlCalls.length).toBe(2); // SET + the resolve query, no events query
});

test("GET /api/v1/blocks/:ref/extrinsics resolves a 0x block_hash ref", async () => {
  const upperHash = `0x${"ABC".repeat(21)}D`; // 64 hex chars, mixed-case
  mockQueue.current = [
    [], // SET
    [{ block_number: 8586300 }], // resolveBlockNumberPg
    [EXTRINSIC_ROW],
  ];
  const res = await req(`/api/v1/blocks/${upperHash}/extrinsics`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.block_number).toBe(8586300);
  expect(sqlCalls.some((c) => c.values.includes(upperHash.toLowerCase()))).toBe(
    true,
  );
});

test("GET /api/v1/blocks/:ref/extrinsics on a malformed ref skips every query but SET", async () => {
  const res = await req("/api/v1/blocks/not-a-real-ref/extrinsics");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.block_number).toBeNull();
  expect(body.data.extrinsics).toEqual([]);
  expect(sqlCalls.length).toBe(1); // only the unconditional SET call
});

test("GET /api/v1/blocks/:ref/extrinsics on a numeric ref past MAX_SAFE_INTEGER skips every query but SET", async () => {
  const res = await req("/api/v1/blocks/99999999999999999999/extrinsics");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.block_number).toBeNull();
  expect(sqlCalls.length).toBe(1); // only the unconditional SET call
});

test("GET /api/v1/extrinsics returns a feed with call_args parsed from the ::text cast", async () => {
  mockRows.current = [EXTRINSIC_ROW];
  const res = await req("/api/v1/extrinsics?limit=1");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.extrinsic_count).toBe(1);
  const ex = body.extrinsics[0];
  expect(ex.block_number).toBe(8586300);
  expect(ex.success).toBe(true);
  expect(ex.call_args).toEqual({ a: 1 }); // parsed, not the raw string
  expect(queryText()).toContain("call_args::text AS call_args");
});

test("GET /api/v1/extrinsics applies the same filter set as loadExtrinsics", async () => {
  mockRows.current = [EXTRINSIC_ROW];
  await req(
    "/api/v1/extrinsics?signer=5S&call_module=SubtensorModule&call_function=set_weights&success=true&block=1&block_start=1&block_end=2&from=1&to=2",
  );
  const text = queryText();
  expect(text).toContain("AND block_number =");
  expect(text).toContain("AND signer =");
  expect(text).toContain("AND call_module =");
  expect(text).toContain("AND call_function =");
  expect(text).toContain("AND success =");
  expect(text).toContain("AND block_number >=");
  expect(text).toContain("AND block_number <=");
  expect(text).toContain("AND observed_at >=");
  expect(text).toContain("AND observed_at <=");
});

test("GET /api/v1/extrinsics with success=false filters correctly, distinct from absent", async () => {
  mockRows.current = [{ ...EXTRINSIC_ROW, success: false }];
  const res = await req("/api/v1/extrinsics?success=false");
  const body = await res.json();
  expect(body.extrinsics[0].success).toBe(false);
  expect(queryText()).toContain("AND success =");
  sqlCalls.length = 0;
  await req("/api/v1/extrinsics");
  expect(queryText()).not.toContain("AND success =");
});

test("GET /api/v1/extrinsics matches call_hash against the cast call_args text", async () => {
  mockRows.current = [EXTRINSIC_ROW];
  const hash = `0x${"a".repeat(64)}`;
  await req(`/api/v1/extrinsics?call_hash=${hash}`);
  expect(queryText()).toContain("AND call_args::text LIKE");
  const call = sqlCalls.find((c) => c.text.includes("call_args::text LIKE"));
  expect(call.values).toContain(`%"${hash}"%`);
});

test("GET /api/v1/extrinsics ignores a malformed call_hash instead of erroring", async () => {
  mockRows.current = [EXTRINSIC_ROW];
  const res = await req("/api/v1/extrinsics?call_hash=not-a-hash");
  expect(res.status).toBe(200);
  expect(queryText()).not.toContain("call_args::text LIKE");
});

test("GET /api/v1/extrinsics uses a composite cursor seek instead of OFFSET", async () => {
  mockRows.current = [EXTRINSIC_ROW];
  await req("/api/v1/extrinsics?cursor=1783600000000.8586300.2");
  const text = queryText();
  expect(text).toContain("AND (observed_at, block_number, extrinsic_index) <");
  expect(text).not.toContain("OFFSET");
});

test("GET /api/v1/extrinsics clamps page size and offset before querying Postgres", async () => {
  mockRows.current = [EXTRINSIC_ROW];
  await req("/api/v1/extrinsics?limit=999999&offset=999999999");

  const queryValues = sqlCalls.flatMap((call) => call.values);
  expect(queryValues).toContain(BLOCK_PAGINATION.maxLimit);
  expect(queryValues).toContain(MAX_OFFSET);
  expect(queryValues).not.toContain(999999);
  expect(queryValues).not.toContain(999999999);
});

test("GET /api/v1/extrinsics/:ref resolves a hash ref with embedded account_events", async () => {
  const eventRow = {
    block_number: "8586300",
    event_index: 0,
    extrinsic_index: 2,
    event_kind: "WeightsSet",
    hotkey: "5Hot",
    coldkey: "5Cold",
    netuid: 4,
    uid: 1,
    amount_tao: "1.5",
    alpha_amount: "0",
    observed_at: "1783600000000",
  };
  // Queue slot 0 is the unconditional `SET statement_timeout` call.
  mockQueue.current = [[], [EXTRINSIC_ROW], [eventRow]];
  const res = await req(`/api/v1/extrinsics/${EXTRINSIC_HASH}`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.extrinsic.extrinsic_hash).toBe(EXTRINSIC_HASH);
  expect(body.events).toHaveLength(1);
  expect(body.events[0].event_kind).toBe("WeightsSet");
});

test("GET /api/v1/extrinsics/:ref resolves a composite block-index ref", async () => {
  mockQueue.current = [[], [EXTRINSIC_ROW], []];
  const res = await req("/api/v1/extrinsics/8586300-2");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.extrinsic.extrinsic_index).toBe(2);
  expect(body.events).toEqual([]);
});

test("GET /api/v1/extrinsics/:ref on a malformed ref skips the query (extrinsic:null)", async () => {
  const res = await req("/api/v1/extrinsics/not-a-real-ref");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.extrinsic).toBeNull();
  expect(body.events).toEqual([]);
  expect(sqlCalls.length).toBe(1); // only the unconditional SET call
});

test("GET /api/v1/extrinsics/:ref skips the embedded-events query on an unresolved ref", async () => {
  mockRows.current = [];
  const res = await req(`/api/v1/extrinsics/0x${"a".repeat(64)}`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.extrinsic).toBeNull();
  expect(body.events).toEqual([]);
  expect(sqlCalls.length).toBe(2); // SET + the main lookup, no events query
});

test("GET /api/v1/accounts/:ss58 shapes the cross-subnet summary from two merged, re-capped bounded scans", async () => {
  mockQueue.current = [
    [], // SET
    [ACCOUNT_EVENT_ROW], // hotkeyScanRows
    [{ ...ACCOUNT_EVENT_ROW, netuid: 5 }], // coldkeyScanRows
    [{ netuid: 4, uid: 1, stake_tao: "10", validator_permit: 1, active: 1 }], // regRows
    [
      {
        tx_count: "3",
        last_tx_block: 8586300,
        last_tx_at: "1783600000000",
        total_fee_tao: "0.03",
      },
    ], // activityRows
    [{ call_module: "SubtensorModule", count: "3" }], // moduleRows
  ];
  const res = await req(`/api/v1/accounts/${SS58}`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.event_count).toBe(2);
  expect(body.subnet_count).toBe(2);
  expect(body.event_kinds[0].kind).toBe("StakeAdded");
  expect(body.event_kinds[0].count).toBe(2);
  expect(body.registrations[0].netuid).toBe(4);
  expect(body.recent_events.length).toBe(2);
  expect(body.activity.tx_count).toBe(3);
  expect(body.activity.modules_called[0].call_module).toBe("SubtensorModule");
  const text = queryText();
  expect(text).toContain("FROM account_events WHERE hotkey =");
  expect(text).toContain("FROM account_events WHERE coldkey =");
  expect(text).toContain("hotkey IS NULL OR hotkey <>");
  expect(text).not.toContain("WHERE (hotkey =");
});

test("GET /api/v1/accounts/:ss58 ignores null netuid events in subnet_count", async () => {
  mockQueue.current = [
    [], // SET
    [ACCOUNT_EVENT_ROW], // hotkeyScanRows
    [{ ...ACCOUNT_EVENT_ROW, netuid: null }], // coldkeyScanRows
    [], // regRows
    [], // activityRows
    [], // moduleRows
  ];
  const res = await req(`/api/v1/accounts/${SS58}`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.event_count).toBe(2);
  expect(body.subnet_count).toBe(1);
  expect(body.recent_events.map((event) => event.netuid)).toEqual([4, null]);
});

test("GET /api/v1/accounts/:ss58 merges, re-sorts, and re-caps events from BOTH the hotkey and coldkey branches", async () => {
  // An address with genuine activity under both hotkey and coldkey (e.g. a
  // hotkey it owns, plus a separate account whose coldkey it is) must have
  // both branches' rows merged into one newest-first, correctly-capped
  // window -- not just whichever branch happened to be queried.
  const hotkeyRow = {
    ...ACCOUNT_EVENT_ROW,
    block_number: "100",
    event_index: 0,
    event_kind: "StakeAdded",
    hotkey: SS58,
    coldkey: "5ColdOther",
  };
  const coldkeyRowNewer = {
    ...ACCOUNT_EVENT_ROW,
    block_number: "200",
    event_index: 1,
    event_kind: "StakeRemoved",
    hotkey: "5HotOther",
    coldkey: SS58,
  };
  const coldkeyRowOlder = {
    ...ACCOUNT_EVENT_ROW,
    block_number: "50",
    event_index: 2,
    event_kind: "WeightsSet",
    hotkey: "5HotOther2",
    coldkey: SS58,
  };
  mockQueue.current = [
    [], // SET
    [hotkeyRow], // hotkeyScanRows
    [coldkeyRowNewer, coldkeyRowOlder], // coldkeyScanRows
    [], // regRows
    [], // activityRows
    [], // moduleRows
  ];
  const res = await req(`/api/v1/accounts/${SS58}`);
  expect(res.status).toBe(200);
  const body = await res.json();
  // 3 distinct rows across both branches, correctly re-sorted newest-first
  // by (block_number DESC, event_index DESC) regardless of which branch
  // each row came from.
  expect(body.event_count).toBe(3);
  expect(body.recent_events.map((e) => e.block_number)).toEqual([200, 100, 50]);
  expect(body.recent_events.map((e) => e.event_kind)).toEqual([
    "StakeRemoved",
    "StakeAdded",
    "WeightsSet",
  ]);
});

test("GET /api/v1/accounts/:ss58 breaks a same-block tie between branches by event_index DESC", async () => {
  // Two rows sharing the SAME block_number (one from each branch) exercise the
  // merge sort's tie-break path (blockDelta === 0), distinct from the
  // block_number-DESC path the test above already covers.
  const hotkeyRow = {
    ...ACCOUNT_EVENT_ROW,
    block_number: "500",
    event_index: 1,
    event_kind: "StakeAdded",
    hotkey: SS58,
    coldkey: "5ColdOther",
  };
  const coldkeyRow = {
    ...ACCOUNT_EVENT_ROW,
    block_number: "500",
    event_index: 4,
    event_kind: "StakeRemoved",
    hotkey: "5HotOther",
    coldkey: SS58,
  };
  mockQueue.current = [
    [], // SET
    [hotkeyRow], // hotkeyScanRows
    [coldkeyRow], // coldkeyScanRows
    [], // regRows
    [], // activityRows
    [], // moduleRows
  ];
  const res = await req(`/api/v1/accounts/${SS58}`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.recent_events.map((e) => e.event_index)).toEqual([4, 1]);
  expect(body.recent_events.map((e) => e.event_kind)).toEqual([
    "StakeRemoved",
    "StakeAdded",
  ]);
});

test("GET /api/v1/accounts/:ss58's coldkey scan excludes rows the hotkey scan already matched", async () => {
  // A row where hotkey === coldkey === ss58 would match BOTH branches' raw
  // WHERE predicates if the coldkey branch had no guard -- the query text
  // must carry the `hotkey IS NULL OR hotkey <> $1` exclusion so Postgres
  // itself never returns that row twice across the two result sets (the
  // merge step has no separate app-level dedup; it trusts this SQL guard,
  // mirroring the D1 predecessor's own coldkey-branch exclusion).
  await req(`/api/v1/accounts/${SS58}`);
  const coldkeyQuery = sqlCalls.find((call) =>
    call.text.includes("FROM account_events WHERE coldkey ="),
  );
  expect(coldkeyQuery.text).toContain("(hotkey IS NULL OR hotkey <>");
  expect(coldkeyQuery.values).toContain(SS58);
});

test("GET /api/v1/accounts/:ss58 with no matching rows returns a schema-stable empty summary", async () => {
  mockRows.current = [];
  const res = await req(`/api/v1/accounts/${SS58}`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.event_count).toBe(0);
  expect(body.registrations).toEqual([]);
  expect(body.recent_events).toEqual([]);
});

test("GET /api/v1/accounts/:ss58/subnets returns the current registrations from neurons", async () => {
  mockRows.current = [
    { netuid: 4, uid: 1, stake_tao: "10", validator_permit: 1, active: 1 },
  ];
  const res = await req(`/api/v1/accounts/${SS58}/subnets`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnets[0].netuid).toBe(4);
  expect(body.subnet_count).toBe(1);
  expect(queryText()).toContain("FROM neurons");
});

test("GET /api/v1/accounts/:ss58/events returns a feed shaped like the D1 route", async () => {
  mockRows.current = [ACCOUNT_EVENT_ROW];
  const res = await req(`/api/v1/accounts/${SS58}/events?limit=1`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ss58).toBe(SS58);
  expect(body.event_count).toBe(1);
  const ev = body.events[0];
  expect(ev.block_number).toBe(8586300);
  expect(ev.event_kind).toBe("StakeAdded");
  expect(ev.amount_tao).toBe(1.5);
});

test("GET /api/v1/accounts/:ss58/events matches hotkey OR coldkey in one flat WHERE, no INDEXED BY / dedup guard", async () => {
  mockRows.current = [ACCOUNT_EVENT_ROW];
  await req(`/api/v1/accounts/${SS58}/events`);
  const text = queryText();
  expect(text).toContain("WHERE (hotkey =");
  expect(text).toContain("OR coldkey =");
  expect(text).not.toContain("INDEXED BY");
  expect(text).not.toContain("UNION");
  expect(text).not.toContain("hotkey <>");
});

test("GET /api/v1/accounts/:ss58/events applies the same filter set as the former account event-feed D1 loader", async () => {
  mockRows.current = [ACCOUNT_EVENT_ROW];
  await req(
    `/api/v1/accounts/${SS58}/events?kind=StakeAdded&netuid=4&block_start=1&block_end=2`,
  );
  const text = queryText();
  expect(text).toContain("AND event_kind =");
  expect(text).toContain("AND netuid =");
  expect(text).toContain("AND block_number >=");
  expect(text).toContain("AND block_number <=");
});

test("GET /api/v1/accounts/:ss58/events caps oversized offsets before Postgres", async () => {
  mockRows.current = [ACCOUNT_EVENT_ROW];
  await req(`/api/v1/accounts/${SS58}/events?limit=1&offset=999999999999`);
  const accountEventsCall = sqlCalls.find((call) =>
    call.text.includes("FROM account_events"),
  );
  expect(accountEventsCall).toBeTruthy();
  const boundValues = sqlCalls.flatMap((call) => call.values);
  expect(boundValues).toContain(1_000_000);
  expect(boundValues).not.toContain(999999999999);
});

test("GET /api/v1/accounts/:ss58/events uses a composite cursor seek instead of OFFSET", async () => {
  mockRows.current = [ACCOUNT_EVENT_ROW];
  await req(`/api/v1/accounts/${SS58}/events?cursor=8586300.0`);
  const text = queryText();
  expect(text).toContain("AND (block_number, event_index) <");
  expect(text).not.toContain("OFFSET");
});

test("GET /api/v1/accounts/:ss58/events with no matching rows returns a schema-stable empty feed", async () => {
  mockRows.current = [];
  const res = await req(`/api/v1/accounts/${SS58}/events`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ss58).toBe(SS58);
  expect(body.event_count).toBe(0);
  expect(body.events).toEqual([]);
  expect(body.next_cursor).toBeNull();
});

// #5474: the three events feeds document a <=1000 / default-100 profile at their
// entities.mjs handlers, but the Postgres tier (which always wins in production
// after the D1 retirement) used to silently re-cap them at the local 200/50 via
// clampLimit. clampEventsLimit now applies the shared FEED_PAGINATION so the
// effective, production-serving cap matches the documentation.
test("GET /api/v1/accounts/:ss58/events honors the documented 1000 feed cap, not the local 200 (#5474)", async () => {
  mockRows.current = [];
  const res = await req(`/api/v1/accounts/${SS58}/events?limit=1000`);
  expect(res.status).toBe(200);
  expect((await res.json()).limit).toBe(1000);
});

test("GET /api/v1/subnets/:netuid/events honors the documented 1000 feed cap (#5474)", async () => {
  mockRows.current = [];
  const res = await req("/api/v1/subnets/4/events?limit=1000");
  expect(res.status).toBe(200);
  expect((await res.json()).limit).toBe(1000);
});

test("GET /api/v1/blocks/:ref/events honors the documented 1000 feed cap (#5474)", async () => {
  mockQueue.current = [[], [{ block_number: 8586300 }], []];
  const res = await req("/api/v1/blocks/8586300/events?limit=1000");
  expect(res.status).toBe(200);
  expect((await res.json()).data.limit).toBe(1000);
});

test("events feeds fall back to the documented default of 100, not the local 50 (#5474)", async () => {
  mockRows.current = [];
  const res = await req(`/api/v1/accounts/${SS58}/events`);
  expect(res.status).toBe(200);
  expect((await res.json()).limit).toBe(100);
});

test("GET /api/v1/accounts/:ss58/extrinsics matches the signer column only, not hotkey/coldkey", async () => {
  mockRows.current = [EXTRINSIC_ROW];
  const res = await req(`/api/v1/accounts/${SS58}/extrinsics`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.extrinsic_count).toBe(1);
  expect(body.extrinsics[0].signer).toBe("5Signer");
  expect(queryText()).toContain("WHERE signer =");
});

test("GET /api/v1/accounts/:ss58/extrinsics applies block_start/block_end bounds", async () => {
  mockRows.current = [];
  await req(`/api/v1/accounts/${SS58}/extrinsics?block_start=1&block_end=2`);
  const text = queryText();
  expect(text).toContain("AND block_number >=");
  expect(text).toContain("AND block_number <=");
});

test("GET /api/v1/accounts/:ss58/extrinsics with an inverted block range short-circuits to empty, never querying Postgres", async () => {
  const res = await req(
    `/api/v1/accounts/${SS58}/extrinsics?block_start=5&block_end=1`,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.extrinsics).toEqual([]);
  expect(sqlCalls.length).toBe(1); // only the unconditional SET call
});

test("GET /api/v1/accounts/:ss58/extrinsics uses a composite cursor seek instead of OFFSET", async () => {
  mockRows.current = [EXTRINSIC_ROW];
  await req(`/api/v1/accounts/${SS58}/extrinsics?cursor=8586300.2`);
  const text = queryText();
  expect(text).toContain("AND (block_number, extrinsic_index) <");
  expect(text).not.toContain("OFFSET");
});

test("GET /api/v1/accounts/:ss58/extrinsics returns a next_cursor when the page is full", async () => {
  mockRows.current = [EXTRINSIC_ROW];
  const res = await req(`/api/v1/accounts/${SS58}/extrinsics?limit=1`);
  const body = await res.json();
  expect(body.next_cursor).toBe("8586300.2");
});

test("GET /api/v1/sudo filters to call_module='Sudo' and never exposes signer/call_module params", async () => {
  mockRows.current = [{ ...EXTRINSIC_ROW, call_module: "Sudo" }];
  const res = await req("/api/v1/sudo?call_function=sudo&success=true");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.extrinsics[0].call_module).toBe("Sudo");
  const text = queryText();
  expect(text).toContain("WHERE call_module =");
  expect(text).toContain("AND call_function =");
  expect(text).toContain("AND success =");
  const call = sqlCalls.find((c) => c.text.includes("WHERE call_module ="));
  expect(call.values).toContain("Sudo");
});

test("GET /api/v1/governance/config-changes filters to call_module='AdminUtils'", async () => {
  mockRows.current = [{ ...EXTRINSIC_ROW, call_module: "AdminUtils" }];
  const res = await req("/api/v1/governance/config-changes");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.extrinsics[0].call_module).toBe("AdminUtils");
  const call = sqlCalls.find((c) => c.text.includes("WHERE call_module ="));
  expect(call.values).toContain("AdminUtils");
});

test("GET /api/v1/sudo applies block/block_start/block_end/from/to filters and a cursor seek", async () => {
  mockRows.current = [];
  await req(
    "/api/v1/sudo?block=1&block_start=1&block_end=2&from=1&to=2&cursor=1783600000000.8586300.2",
  );
  const text = queryText();
  expect(text).toContain("AND block_number =");
  expect(text).toContain("AND block_number >=");
  expect(text).toContain("AND block_number <=");
  expect(text).toContain("AND observed_at >=");
  expect(text).toContain("AND observed_at <=");
  expect(text).toContain("AND (observed_at, block_number, extrinsic_index) <");
  expect(text).not.toContain("OFFSET");
});

test("GET /api/v1/sudo with success=false filters correctly, distinct from absent", async () => {
  mockRows.current = [
    { ...EXTRINSIC_ROW, call_module: "Sudo", success: false },
  ];
  const res = await req("/api/v1/sudo?success=false");
  const body = await res.json();
  expect(body.extrinsics[0].success).toBe(false);
  expect(queryText()).toContain("AND success =");
});

test("GET /api/v1/sudo returns a next_cursor when the page is full", async () => {
  mockRows.current = [{ ...EXTRINSIC_ROW, call_module: "Sudo" }];
  const res = await req("/api/v1/sudo?limit=1");
  const body = await res.json();
  expect(body.next_cursor).toBe("1783600000000.8586300.2");
});

test("GET /api/v1/runtime returns the spec-version transition timeline", async () => {
  mockQueue.current = [
    [], // SET
    [
      {
        spec_version: 423,
        block_number: 8000000,
        observed_at: "1783500000000",
      },
    ],
    [{ spec_version: 424 }],
  ];
  const res = await req("/api/v1/runtime");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.transitions[0].spec_version).toBe(423);
  expect(body.current_spec_version).toBe(424);
  expect(queryText()).toContain("GROUP BY spec_version");
});

test("GET /api/v1/runtime with no readings returns the schema-stable empty timeline", async () => {
  mockRows.current = [];
  const res = await req("/api/v1/runtime");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.transitions).toEqual([]);
  expect(body.current_spec_version).toBeNull();
});

// #4771: per-UID metagraph tier, mirroring src/metagraph-neurons.mjs's D1
// loaders + builders unchanged. Rows carry native Postgres BOOLEAN (not D1's
// 0/1 INTEGER) and NUMERIC/BIGINT-as-string cells, exercising the same
// toD1Flag/nullableNumber/nonNegativeInt coercions those builders already use.
const NEURON_ROW = {
  uid: 3,
  hotkey: "5Hot",
  coldkey: "5Cold",
  active: true,
  validator_permit: true,
  rank: "0.5",
  trust: "0.9",
  validator_trust: "0.8",
  consensus: "0.7",
  incentive: "0.6",
  dividends: "0.4",
  emission_tao: "1.23",
  stake_tao: "456.7",
  registered_at_block: "100",
  is_immunity_period: false,
  axon: "1.2.3.4:9000",
  block_number: "5000000",
  captured_at: "1780000000000",
};

test("GET /api/v1/subnets/:netuid/metagraph returns a subnet metagraph shaped like the D1 route", async () => {
  mockRows.current = [NEURON_ROW];
  const res = await req("/api/v1/subnets/7/metagraph");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.netuid).toBe(7);
  expect(body.neuron_count).toBe(1);
  expect(body.neurons[0].uid).toBe(3);
  expect(body.neurons[0].active).toBe(true);
  expect(body.neurons[0].stake_tao).toBe(456.7);
  expect(queryText()).toMatch(/FROM neurons WHERE netuid = /);
  expect(queryText()).not.toMatch(/validator_permit = TRUE/);
});

test("GET /api/v1/subnets/:netuid/metagraph?validator_permit=true adds the validator filter", async () => {
  mockRows.current = [NEURON_ROW];
  const res = await req("/api/v1/subnets/7/metagraph?validator_permit=true");
  expect(res.status).toBe(200);
  expect(queryText()).toMatch(/validator_permit = TRUE/);
});

test("GET /api/v1/subnets/:netuid/neurons/:uid resolves a neuron detail", async () => {
  mockRows.current = [NEURON_ROW];
  const res = await req("/api/v1/subnets/7/neurons/3");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.netuid).toBe(7);
  expect(body.neuron.uid).toBe(3);
  expect(body.neuron.hotkey).toBe("5Hot");
});

test("GET /api/v1/subnets/:netuid/neurons/:uid on an unknown uid returns neuron:null, never 404", async () => {
  mockRows.current = [];
  const res = await req("/api/v1/subnets/7/neurons/999");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.neuron).toBeNull();
});

// #6640: deregistration-risk signal -- immunity_period is read live from
// subnet_hyperparams (never hardcoded, #5229 convention) alongside the
// neurons query, same Promise.all + savepoint-isolated shape as loadSubnetTempos
// (#2551).
const IMMUNE_ROW = {
  ...NEURON_ROW,
  is_immunity_period: true,
  registered_at_block: "5000000",
  block_number: "5000100",
  captured_at: "1780000000000",
};

test("GET /api/v1/subnets/:netuid/metagraph computes immunity_expires_at* from a live subnet_hyperparams read (#6640)", async () => {
  mockQueue.current = [
    [], // sql.begin's leading `SET statement_timeout`
    [IMMUNE_ROW], // main neurons query
    [{ immunity_period: 7200 }], // loadSubnetImmunityPeriod
  ];
  const res = await req("/api/v1/subnets/7/metagraph");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(queryText()).toMatch(/SELECT immunity_period FROM subnet_hyperparams/);
  expect(body.neurons[0].immunity_expires_at_block).toBe(5007200);
  expect(typeof body.neurons[0].immunity_expires_at).toBe("string");
});

test("GET /api/v1/subnets/:netuid/metagraph omits immunity_expires_at* when subnet_hyperparams has no row yet (cold)", async () => {
  mockQueue.current = [
    [], // sql.begin's leading `SET statement_timeout`
    [IMMUNE_ROW],
    [], // loadSubnetImmunityPeriod -- no row for this netuid
  ];
  const res = await req("/api/v1/subnets/7/metagraph");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect("immunity_expires_at_block" in body.neurons[0]).toBe(false);
});

test("GET /api/v1/subnets/:netuid/metagraph omits immunity_expires_at* for a negative immunity_period value (defensive, shouldn't occur on real chain data)", async () => {
  mockQueue.current = [
    [], // sql.begin's leading `SET statement_timeout`
    [IMMUNE_ROW],
    [{ immunity_period: -1 }], // loadSubnetImmunityPeriod
  ];
  const res = await req("/api/v1/subnets/7/metagraph");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect("immunity_expires_at_block" in body.neurons[0]).toBe(false);
});

test("GET /api/v1/subnets/:netuid/metagraph still serves neurons when the immunity_period read fails (#6640)", async () => {
  subnetTemposQueryFailure.error = new Error(
    'relation "subnet_hyperparams" does not exist',
  );
  mockQueue.current = [
    [], // sql.begin's leading `SET statement_timeout`
    [IMMUNE_ROW],
  ];
  const res = await req("/api/v1/subnets/7/metagraph");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.neurons[0].uid).toBe(3);
  expect("immunity_expires_at_block" in body.neurons[0]).toBe(false);
});

test("GET /api/v1/subnets/:netuid/neurons/:uid computes immunity_expires_at* from a live subnet_hyperparams read (#6640)", async () => {
  mockQueue.current = [
    [], // sql.begin's leading `SET statement_timeout`
    [IMMUNE_ROW], // main neuron-detail query
    [{ immunity_period: 7200 }], // loadSubnetImmunityPeriod
  ];
  const res = await req("/api/v1/subnets/7/neurons/3");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.neuron.immunity_expires_at_block).toBe(5007200);
  expect(typeof body.neuron.immunity_expires_at).toBe("string");
});

test("GET /api/v1/subnets/:netuid/validators ranks validator_permit rows by stake", async () => {
  mockRows.current = [NEURON_ROW];
  const res = await req("/api/v1/subnets/7/validators");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.netuid).toBe(7);
  expect(body.validator_count).toBe(1);
  expect(body.validators[0].uid).toBe(3);
  expect(queryText()).toMatch(/validator_permit = TRUE/);
  expect(queryText()).toMatch(/ORDER BY stake_tao DESC, uid ASC/);
});

test("GET /api/v1/subnets/:netuid/validators sets featured=true for a hotkey in featured_validators", async () => {
  // mockQueue is consumed in call order: the transaction's leading `SET
  // statement_timeout` (sql.begin, see workers/data-api.mjs) shifts first,
  // then the neurons query, then loadFeaturedHotkeys's own query.
  mockQueue.current = [[], [NEURON_ROW], [{ hotkey: "5Hot" }]];
  const res = await req("/api/v1/subnets/7/validators");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(queryText()).toMatch(/FROM featured_validators/);
  // The reorder overlay (workers/request-handlers/entities.mjs) has already
  // run by the time this route responds -- a single-row list just confirms
  // the flag itself made it through the read path.
  expect(body.validators[0].featured).toBe(true);
});

test("GET /api/v1/subnets/:netuid/validators sets featured=false when the hotkey isn't in featured_validators", async () => {
  mockQueue.current = [[], [NEURON_ROW], []];
  const res = await req("/api/v1/subnets/7/validators");
  const body = await res.json();
  expect(body.validators[0].featured).toBe(false);
});

test("GET /api/v1/subnets/:netuid/validators still serves the primary rows when the featured_validators read fails", async () => {
  // A pre-migration deployment (table not created yet) or any other read
  // failure must degrade to "nothing is featured", never break the route.
  featuredValidatorsQueryFailure.error = new Error(
    'relation "featured_validators" does not exist',
  );
  mockQueue.current = [[], [NEURON_ROW]];
  const res = await req("/api/v1/subnets/7/validators");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.validator_count).toBe(1);
  expect(body.validators[0].featured).toBe(false);
});

test("GET /api/v1/validators still serves the primary rows when the featured_validators read fails (#5220)", async () => {
  // Regression test for #5220: this network-wide route (unlike the single
  // /validators/:hotkey detail route, which never reads featured_validators)
  // returned validator_count: 0 in production because a bare sql`...` inside
  // loadFeaturedHotkeys poisoned the whole shared sql.begin() transaction --
  // even though this function's own try/catch handled the rejection -- so
  // the outer sql.begin() itself rejected after the route handler had
  // already built its response. See loadFeaturedHotkeys's header comment and
  // the sql.begin mock above for how postgres.js's real transaction-scoped
  // error tracking works.
  featuredValidatorsQueryFailure.error = new Error(
    'relation "featured_validators" does not exist',
  );
  mockQueue.current = [
    [], // sql.begin's leading `SET statement_timeout`
    [
      {
        netuid: 7,
        uid: 3,
        hotkey: "5Hot",
        coldkey: "5Cold",
        validator_trust: "0.8",
        emission_tao: "1.23",
        stake_tao: "456.7",
        block_number: "5000000",
        captured_at: "1780000000000",
      },
    ],
  ];
  const res = await req("/api/v1/validators");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.validator_count).toBe(1);
  expect(body.validators[0].hotkey).toBe("5Hot");
  expect(body.validators[0].featured).toBe(false);
});

test("GET /api/v1/validators returns the network-wide validator leaderboard with defaults", async () => {
  mockRows.current = [
    {
      netuid: 7,
      uid: 3,
      hotkey: "5Hot",
      coldkey: "5Cold",
      validator_trust: "0.8",
      emission_tao: "1.23",
      stake_tao: "456.7",
      block_number: "5000000",
      captured_at: "1780000000000",
    },
  ];
  const res = await req("/api/v1/validators");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.sort).toBe("subnet_count");
  expect(body.limit).toBe(20);
  expect(body.validators[0].hotkey).toBe("5Hot");
  expect(body.validators[0].total_stake_tao).toBe(456.7);
});

test("GET /api/v1/validators sets featured per hotkey, matched against featured_validators", async () => {
  // This route only sets the flag (via buildGlobalValidators) -- the "move to
  // front" reorder is a separate overlay applied downstream in
  // workers/request-handlers/entities.mjs (see request-handlers-entities.test.mjs),
  // so this test asserts the flag only, not row order.
  mockQueue.current = [
    [], // sql.begin's leading `SET statement_timeout`
    [
      {
        netuid: 1,
        uid: 0,
        hotkey: "hk-a",
        coldkey: "ck-a",
        validator_trust: "0.5",
        emission_tao: "1",
        stake_tao: "100",
        block_number: "10",
        captured_at: "1780000000000",
      },
      {
        netuid: 2,
        uid: 0,
        hotkey: "hk-b",
        coldkey: "ck-b",
        validator_trust: "0.9",
        emission_tao: "5",
        stake_tao: "9000",
        block_number: "10",
        captured_at: "1780000000000",
      },
    ],
    [{ hotkey: "hk-a" }],
  ];
  const res = await req("/api/v1/validators");
  const body = await res.json();
  expect(queryText()).toMatch(/FROM featured_validators/);
  const byHotkey = Object.fromEntries(
    body.validators.map((v) => [v.hotkey, v.featured]),
  );
  expect(byHotkey["hk-a"]).toBe(true);
  expect(byHotkey["hk-b"]).toBe(false);
});

test("GET /api/v1/validators respects an explicit valid sort + limit", async () => {
  mockRows.current = [];
  const res = await req("/api/v1/validators?sort=total_stake&limit=5");
  const body = await res.json();
  expect(body.sort).toBe("total_stake");
  expect(body.limit).toBe(5);
});

test("GET /api/v1/validators falls back to the default sort/limit on invalid values", async () => {
  mockRows.current = [];
  const res = await req("/api/v1/validators?sort=not-a-sort&limit=9999");
  const body = await res.json();
  expect(body.sort).toBe("subnet_count");
  expect(body.limit).toBe(20);
});

const IDENTITY_ROW = {
  account: "5Cold",
  name: "Acme Validators",
  url: "https://acme-validators.io",
  github: "https://github.com/acme-validators",
  image: "https://acme-validators.io/logo.png",
  discord: "acme#1234",
  description: "Professional validator operator",
  additional: "Est. 2023",
  captured_at: "1750000000000",
};

test("GET /api/v1/validators joins coldkey_identity from account_identity by coldkey (#5234)", async () => {
  mockRows.current = [{ ...NEURON_ROW, netuid: 7 }];
  accountIdentityJoinRows.current = [IDENTITY_ROW];
  const res = await req("/api/v1/validators");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.validators[0].coldkey).toBe("5Cold");
  expect(body.validators[0].coldkey_identity.has_identity).toBe(true);
  expect(body.validators[0].coldkey_identity.name).toBe("Acme Validators");
  expect(queryText()).toMatch(
    /FROM account_identity WHERE account IN \(\$1::text\)/,
  );
  const joinCall = sqlCalls.find((call) =>
    /FROM account_identity WHERE account IN/.test(call.text),
  );
  expect(joinCall.values).toEqual(["5Cold"]);
});

test("GET /api/v1/validators reports has_identity:false when no account_identity row matches the coldkey (#5234)", async () => {
  mockRows.current = [{ ...NEURON_ROW, netuid: 7 }];
  accountIdentityJoinRows.current = [];
  const res = await req("/api/v1/validators");
  const body = await res.json();
  expect(body.validators[0].coldkey_identity.has_identity).toBe(false);
  expect(body.validators[0].coldkey_identity.name).toBe(null);
});

test("GET /api/v1/validators skips the identity join query when there are no validator rows (#5234)", async () => {
  mockRows.current = [];
  const res = await req("/api/v1/validators");
  expect(res.status).toBe(200);
  expect(queryText()).not.toMatch(/FROM account_identity WHERE account IN/);
});

test("GET /api/v1/validators skips a row with no coldkey when collecting join keys, without erroring (#5234)", async () => {
  mockRows.current = [{ ...NEURON_ROW, netuid: 7, coldkey: null }];
  const res = await req("/api/v1/validators");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.validators[0].coldkey_identity).toBe(null);
  expect(queryText()).not.toMatch(/FROM account_identity WHERE account IN/);
});

test("GET /api/v1/validators still serves validators (has_identity:false) when the identity join query fails (#5234)", async () => {
  mockRows.current = [{ ...NEURON_ROW, netuid: 7 }];
  accountIdentityJoinQueryFailure.error = new Error(
    'relation "account_identity" does not exist',
  );
  const res = await req("/api/v1/validators");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.validators[0].hotkey).toBe("5Hot");
  expect(body.validators[0].coldkey_identity.has_identity).toBe(false);
});

test("GET /api/v1/validators/:hotkey resolves cross-subnet validator detail", async () => {
  mockRows.current = [{ ...NEURON_ROW, netuid: 7 }];
  const res = await req("/api/v1/validators/5Hot");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.hotkey).toBe("5Hot");
  expect(body.subnet_count).toBe(1);
  expect(body.subnets[0].netuid).toBe(7);
  expect(queryText()).toMatch(/WHERE hotkey = /);
  expect(queryText()).toMatch(/validator_permit = TRUE/);
});

test("GET /api/v1/validators/:hotkey joins coldkey_identity for its primary coldkey (#5234)", async () => {
  mockRows.current = [{ ...NEURON_ROW, netuid: 7 }];
  accountIdentityJoinRows.current = [IDENTITY_ROW];
  const res = await req("/api/v1/validators/5Hot");
  const body = await res.json();
  expect(body.coldkey).toBe("5Cold");
  expect(body.coldkey_identity.has_identity).toBe(true);
  expect(body.coldkey_identity.description).toBe(
    "Professional validator operator",
  );
});

test("GET /api/v1/validators/:hotkey sends one deduped identity lookup when every subnet row shares the same coldkey (#5234)", async () => {
  mockRows.current = [
    { ...NEURON_ROW, netuid: 7 },
    { ...NEURON_ROW, netuid: 12 },
  ];
  accountIdentityJoinRows.current = [IDENTITY_ROW];
  const res = await req("/api/v1/validators/5Hot");
  const body = await res.json();
  expect(body.subnet_count).toBe(2);
  expect(body.coldkey_identity.has_identity).toBe(true);
  const joinCalls = sqlCalls.filter((call) =>
    /FROM account_identity WHERE account IN/.test(call.text),
  );
  expect(joinCalls.length).toBe(1);
  expect(joinCalls[0].values).toEqual(["5Cold"]);
});

test("GET /api/v1/validators/:hotkey for an absent hotkey has coldkey_identity:null (no coldkey to look up) and skips the join query (#5234)", async () => {
  mockRows.current = [];
  const res = await req(`/api/v1/validators/${SS58}`);
  const body = await res.json();
  expect(body.coldkey).toBe(null);
  expect(body.coldkey_identity).toBe(null);
  expect(queryText()).not.toMatch(/FROM account_identity WHERE account IN/);
});

test("GET /api/v1/validators joins nominator_count by hotkey from validator_nominator_counts (#2549)", async () => {
  mockQueue.current = [
    [], // sql.begin's leading `SET statement_timeout`
    [
      {
        netuid: 1,
        uid: 0,
        hotkey: "hk-a",
        coldkey: "ck-a",
        validator_trust: "0.5",
        emission_tao: "1",
        stake_tao: "100",
        block_number: "10",
        captured_at: "1780000000000",
      },
      {
        netuid: 2,
        uid: 0,
        hotkey: "hk-b",
        coldkey: "ck-b",
        validator_trust: "0.9",
        emission_tao: "5",
        stake_tao: "9000",
        block_number: "10",
        captured_at: "1780000000000",
      },
    ],
    [], // loadFeaturedHotkeys
    [{ hotkey: "hk-a", nominator_count: 17 }],
  ];
  const res = await req("/api/v1/validators");
  const body = await res.json();
  expect(queryText()).toMatch(/FROM validator_nominator_counts/);
  const byHotkey = Object.fromEntries(
    body.validators.map((v) => [v.hotkey, v.nominator_count]),
  );
  expect(byHotkey["hk-a"]).toBe(17);
  expect(byHotkey["hk-b"]).toBe(null);
});

test("GET /api/v1/validators still serves the primary rows when the validator_nominator_counts read fails", async () => {
  validatorNominatorCountsQueryFailure.error = new Error(
    'relation "validator_nominator_counts" does not exist',
  );
  mockQueue.current = [
    [], // sql.begin's leading `SET statement_timeout`
    [{ ...NEURON_ROW, netuid: 7, hotkey: "5Hot" }],
    [], // loadFeaturedHotkeys
  ];
  const res = await req("/api/v1/validators");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.validators[0].hotkey).toBe("5Hot");
  expect(body.validators[0].nominator_count).toBe(null);
});

test("GET /api/v1/validators/:hotkey joins nominator_count from validator_nominator_counts (#2549)", async () => {
  mockQueue.current = [
    [], // sql.begin's leading `SET statement_timeout`
    [{ ...NEURON_ROW, hotkey: "5Hot", netuid: 7 }],
    [{ hotkey: "5Hot", nominator_count: 9 }],
  ];
  const res = await req("/api/v1/validators/5Hot");
  const body = await res.json();
  expect(body.nominator_count).toBe(9);
});

test("GET /api/v1/validators computes apy_estimate from a subnet_hyperparams tempo join (#2551)", async () => {
  mockQueue.current = [
    [], // sql.begin's leading `SET statement_timeout`
    [
      {
        ...NEURON_ROW,
        hotkey: "5Hot",
        netuid: 3,
        stake_tao: "1000",
        emission_tao: "0.85",
      },
    ],
    [], // loadFeaturedHotkeys
    [], // loadValidatorNominatorCounts
    [{ netuid: 3, tempo: 360 }],
  ];
  const res = await req("/api/v1/validators");
  const body = await res.json();
  expect(queryText()).toMatch(/FROM subnet_hyperparams/);
  // epochsPerYear = 31,536,000/(360*12) = 7,300; annualized = 0.85*7,300 =
  // 6,205; apy = 6,205/1,000 = 6.205 -- same worked example as the builder
  // unit tests (tests/metagraph-neurons.test.mjs).
  expect(body.validators[0].apy_estimate).toBe(6.205);
  expect(body.validators[0].apy_estimate_eligible_subnet_count).toBe(1);
});

test("GET /api/v1/validators still serves the primary rows when the subnet_hyperparams tempo read fails (#2551)", async () => {
  subnetTemposQueryFailure.error = new Error(
    'relation "subnet_hyperparams" does not exist',
  );
  mockQueue.current = [
    [], // sql.begin's leading `SET statement_timeout`
    [{ ...NEURON_ROW, netuid: 7, hotkey: "5Hot" }],
    [], // loadFeaturedHotkeys
    [], // loadValidatorNominatorCounts
  ];
  const res = await req("/api/v1/validators");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.validators[0].hotkey).toBe("5Hot");
  expect(body.validators[0].apy_estimate).toBe(null);
  expect(body.validators[0].apy_estimate_eligible_subnet_count).toBe(0);
});

test("GET /api/v1/validators/:hotkey computes apy_estimate from a subnet_hyperparams tempo join (#2551)", async () => {
  mockQueue.current = [
    [], // sql.begin's leading `SET statement_timeout`
    [
      {
        ...NEURON_ROW,
        hotkey: "5Hot",
        netuid: 3,
        stake_tao: "1000",
        emission_tao: "0.85",
      },
    ],
    [], // loadValidatorNominatorCounts
    [{ netuid: 3, tempo: 360 }],
  ];
  const res = await req("/api/v1/validators/5Hot");
  const body = await res.json();
  expect(body.apy_estimate).toBe(6.205);
  expect(body.apy_estimate_eligible_subnet_count).toBe(1);
});

// #4832 Tier 2: the live-`neurons` routes with no shared D1 loader (the
// handler builds its own inline SELECT) or a loader this Worker mirrors
// directly, matching the established metagraph/validators pattern above.

test("GET /api/v1/subnets/:netuid/concentration shapes the live stake/emission distribution", async () => {
  mockRows.current = [NEURON_ROW];
  const res = await req("/api/v1/subnets/4/concentration");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.netuid).toBe(4);
  expect(body.stake).not.toBeNull();
  expect(queryText()).toContain("FROM neurons WHERE netuid =");
});

test("GET /api/v1/subnets/:netuid/performance shapes the live reward-flow distribution", async () => {
  mockRows.current = [NEURON_ROW];
  const res = await req("/api/v1/subnets/4/performance");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.netuid).toBe(4);
  expect(queryText()).toContain("FROM neurons WHERE netuid =");
});

test("GET /api/v1/chain/concentration shapes the network-wide distribution across every subnet", async () => {
  mockRows.current = [{ ...NEURON_ROW, netuid: 4 }];
  const res = await req("/api/v1/chain/concentration");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(1);
  expect(queryText()).toContain("FROM neurons");
  expect(queryText()).not.toContain("WHERE netuid");
});

test("GET /api/v1/chain/performance shapes the network-wide reward-flow distribution", async () => {
  mockRows.current = [{ ...NEURON_ROW, netuid: 4 }];
  const res = await req("/api/v1/chain/performance");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(1);
});

test("GET /api/v1/subnets/:netuid/idle-stake shapes the live idle-stake scorecard", async () => {
  mockRows.current = [
    { ...NEURON_ROW, dividends: "0" },
    { ...NEURON_ROW, uid: 5, dividends: "0.4" },
  ];
  const res = await req("/api/v1/subnets/4/idle-stake");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.netuid).toBe(4);
  expect(body.neuron_count).toBe(2);
  expect(body.idle_neuron_count).toBe(1);
  expect(body.idle_stake_tao).toBe(456.7);
  expect(queryText()).toContain("FROM neurons WHERE netuid =");
});

test("GET /api/v1/chain/idle-stake shapes the network-wide idle-stake rollup", async () => {
  mockRows.current = [{ ...NEURON_ROW, netuid: 4, dividends: "0" }];
  const res = await req("/api/v1/chain/idle-stake");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(1);
  expect(body.total_idle_stake_tao).toBe(456.7);
  expect(queryText()).toContain("FROM neurons");
  expect(queryText()).not.toContain("WHERE netuid");
});

test("GET /api/v1/chain/yield shapes the network-wide emission-yield distribution", async () => {
  mockRows.current = [{ ...NEURON_ROW, netuid: 4 }];
  const res = await req("/api/v1/chain/yield");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(1);
});

test("GET /api/v1/subnets/:netuid/yield shapes one subnet's emission-yield distribution", async () => {
  mockRows.current = [NEURON_ROW];
  const res = await req("/api/v1/subnets/4/yield");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.netuid).toBe(4);
  expect(body.neurons[0].hotkey).toBe("5Hot");
  expect(queryText()).toContain("FROM neurons WHERE netuid =");
});

test("GET /api/v1/accounts/:ss58/portfolio shapes one wallet's cross-subnet neuron portfolio", async () => {
  mockRows.current = [{ ...NEURON_ROW, netuid: 4 }];
  const res = await req(`/api/v1/accounts/${SS58}/portfolio`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ss58).toBe(SS58);
  expect(body.positions[0].netuid).toBe(4);
  expect(queryText()).toContain("FROM neurons WHERE hotkey =");
});

test("GET /api/v1/accounts returns the global accounts leaderboard", async () => {
  mockRows.current = [{ ...NEURON_ROW, netuid: 4 }];
  const res = await req("/api/v1/accounts");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.accounts[0].hotkey).toBe("5Hot");
  expect(queryText()).toContain("WHERE hotkey IS NOT NULL");
});

test("GET /api/v1/accounts respects an explicit sort/limit", async () => {
  mockRows.current = [];
  const res = await req("/api/v1/accounts?sort=total_stake&limit=5");
  const body = await res.json();
  expect(body.sort).toBe("total_stake");
  expect(body.limit).toBe(5);
});

test("GET /api/v1/accounts/top-holders shapes the balance-based leaderboard from the FULL OUTER JOIN", async () => {
  mockRows.current = [
    {
      ss58: "5Whale1",
      free_tao: 1000.5,
      delegated_tao: 250.25,
      captured_at: 1750000000000,
    },
  ];
  const res = await req("/api/v1/accounts/top-holders");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.accounts[0].ss58).toBe("5Whale1");
  expect(body.accounts[0].total_tao).toBe(1250.75);
  expect(queryText()).toContain("FULL OUTER JOIN");
  expect(queryText()).toContain("FROM account_balances");
});

test("GET /api/v1/accounts/top-holders joins wallet_flow_daily and shapes the net-flow columns (#6886/#6887)", async () => {
  mockRows.current = [
    {
      ss58: "5Whale1",
      free_tao: 1000.5,
      delegated_tao: 250.25,
      net_flow_7d: -50,
      net_flow_30d: 200,
      net_flow_90d: 900,
      captured_at: 1750000000000,
    },
  ];
  const res = await req("/api/v1/accounts/top-holders?sort=net_flow_30d");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.accounts[0].net_flow_7d).toBe(-50);
  expect(body.accounts[0].net_flow_30d).toBe(200);
  expect(body.accounts[0].net_flow_90d).toBe(900);
  expect(queryText()).toContain("LEFT JOIN");
  expect(queryText()).toContain("FROM wallet_flow_daily");
});

test("GET /api/v1/accounts/top-holders respects an explicit sort/limit", async () => {
  mockRows.current = [];
  const res = await req("/api/v1/accounts/top-holders?sort=free_tao&limit=5");
  const body = await res.json();
  expect(body.sort).toBe("free_tao");
  expect(body.limit).toBe(5);
});

// #4832 Tier 2b: the neuron_daily-history routes -- structural history,
// concentration/performance/yield history, and chain/subnet turnover + movers
// (the boundary-snapshot routes translate SQLite's date(MAX(snapshot_date),
// '-N days') to Postgres's native `MAX(snapshot_date) - N::int`).

test("GET /api/v1/validators/:hotkey/history shapes the validator's cross-subnet daily trend", async () => {
  mockRows.current = [
    {
      snapshot_date: "2026-07-01",
      subnet_count: "2",
      total_stake_tao: "10",
      total_emission_tao: "1",
    },
  ];
  const res = await req(`/api/v1/validators/${SS58}/history`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.hotkey).toBe(SS58);
  expect(body.points[0].snapshot_date).toBe("2026-07-01");
  expect(queryText()).toContain("FROM neuron_daily");
  expect(queryText()).toContain("validator_permit = TRUE");
});

test("GET /api/v1/subnets/:netuid/neurons/:uid/history shapes the per-UID daily snapshot trend", async () => {
  mockRows.current = [{ ...NEURON_ROW, snapshot_date: "2026-07-01" }];
  const res = await req("/api/v1/subnets/7/neurons/3/history");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.netuid).toBe(7);
  expect(body.uid).toBe(3);
  expect(body.points[0].snapshot_date).toBe("2026-07-01");
  expect(queryText()).toContain("FROM neuron_daily");
  expect(queryText()).toContain("WHERE netuid =");
});

test("GET /api/v1/subnets/:netuid/history shapes the daily neuron/validator/stake trend", async () => {
  mockRows.current = [
    {
      snapshot_date: "2026-07-01",
      neuron_count: "5",
      validator_count: "2",
      total_stake_tao: "10",
      total_emission_tao: "1",
    },
  ];
  const res = await req("/api/v1/subnets/7/history");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.netuid).toBe(7);
  expect(body.points[0].neuron_count).toBe(5);
  expect(queryText()).toContain("SUM(validator_permit::int)");
});

test("GET /api/v1/subnets/:netuid/concentration/history shapes the per-day concentration trend", async () => {
  mockRows.current = [
    { snapshot_date: "2026-07-01", stake_tao: "10", emission_tao: "1" },
  ];
  const res = await req("/api/v1/subnets/7/concentration/history");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.netuid).toBe(7);
  expect(body.points[0].snapshot_date).toBe("2026-07-01");
  expect(queryText()).toContain("FROM neuron_daily");
});

test("GET /api/v1/subnets/:netuid/performance/history shapes the per-day reward-flow trend", async () => {
  mockRows.current = [
    {
      snapshot_date: "2026-07-01",
      incentive: "0.5",
      dividends: "0.3",
      trust: "0.9",
      consensus: "0.8",
      validator_permit: true,
      active: true,
    },
  ];
  const res = await req("/api/v1/subnets/7/performance/history");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.netuid).toBe(7);
  expect(body.points[0].snapshot_date).toBe("2026-07-01");
});

test("GET /api/v1/subnets/:netuid/yield/history shapes the per-day yield trend", async () => {
  mockRows.current = [
    {
      snapshot_date: "2026-07-01",
      validator_permit: true,
      stake_tao: "10",
      emission_tao: "1",
    },
  ];
  const res = await req("/api/v1/subnets/7/yield/history");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.netuid).toBe(7);
  expect(body.points[0].snapshot_date).toBe("2026-07-01");
});

test("GET /api/v1/chain/turnover shapes network-wide validator-set churn between boundary snapshots", async () => {
  // Queue slot 0 is the unconditional `SET statement_timeout` call, slot 1 the
  // MIN/MAX boundary-date bounds query, slot 2 the two boundary snapshots' rows.
  mockQueue.current = [
    [],
    [{ start_date: "2026-06-01", end_date: "2026-07-01" }],
    [
      {
        snapshot_date: "2026-06-01",
        netuid: 7,
        hotkey: "5Hot",
        validator_permit: true,
      },
      {
        snapshot_date: "2026-07-01",
        netuid: 7,
        hotkey: "5Hot2",
        validator_permit: true,
      },
    ],
  ];
  const res = await req("/api/v1/chain/turnover");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.comparable).toBe(true);
  expect(body.start_date).toBe("2026-06-01");
  expect(body.end_date).toBe("2026-07-01");
  expect(queryText()).toContain("MAX(snapshot_date)");
});

test("GET /api/v1/subnets/:netuid/turnover shapes one subnet's validator-set churn", async () => {
  mockQueue.current = [
    [],
    [{ start_date: "2026-06-01", end_date: "2026-07-01" }],
    [
      {
        snapshot_date: "2026-06-01",
        uid: 3,
        hotkey: "5Hot",
        validator_permit: true,
      },
      {
        snapshot_date: "2026-07-01",
        uid: 3,
        hotkey: "5Hot",
        validator_permit: true,
      },
    ],
  ];
  const res = await req("/api/v1/subnets/7/turnover");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.netuid).toBe(7);
  expect(body.comparable).toBe(true);
});

test("GET /api/v1/subnets/:netuid/turnover?changes=true includes the entered/exited detail", async () => {
  mockQueue.current = [
    [],
    [{ start_date: "2026-06-01", end_date: "2026-07-01" }],
    [
      {
        snapshot_date: "2026-06-01",
        uid: 3,
        hotkey: "5Hot",
        validator_permit: true,
      },
      {
        snapshot_date: "2026-07-01",
        uid: 4,
        hotkey: "5Hot2",
        validator_permit: true,
      },
    ],
  ];
  const res = await req("/api/v1/subnets/7/turnover?changes=true");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.changes).toBeDefined();
  expect(Array.isArray(body.changes.validators_entered)).toBe(true);
});

test("GET /api/v1/subnets/movers shapes every subnet ranked by its stake/emission/validator change", async () => {
  mockQueue.current = [
    [],
    [{ start_date: "2026-06-01", end_date: "2026-07-01" }],
    [
      {
        netuid: 7,
        snapshot_date: "2026-06-01",
        neuron_count: "5",
        validator_count: "2",
        total_stake_tao: "10",
        total_emission_tao: "1",
      },
      {
        netuid: 7,
        snapshot_date: "2026-07-01",
        neuron_count: "6",
        validator_count: "3",
        total_stake_tao: "20",
        total_emission_tao: "2",
      },
    ],
  ];
  const res = await req("/api/v1/subnets/movers");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(1);
  expect(body.movers[0].netuid).toBe(7);
  expect(queryText()).toContain("SUM(validator_permit::int)");
});

test("GET /api/v1/validators/:hotkey/history falls back to the default window on an unrecognized value", async () => {
  mockRows.current = [
    {
      snapshot_date: "2026-07-01",
      subnet_count: "1",
      total_stake_tao: "5",
      total_emission_tao: "0.5",
    },
  ];
  const res = await req(`/api/v1/validators/${SS58}/history?window=bogus`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window).toBe("30d");
  expect(queryText()).toContain("snapshot_date >=");
});

test("GET /api/v1/validators/:hotkey/history?window=all skips the snapshot_date cutoff", async () => {
  mockRows.current = [
    {
      snapshot_date: "2026-01-01",
      subnet_count: "1",
      total_stake_tao: "5",
      total_emission_tao: "0.5",
    },
  ];
  const res = await req(`/api/v1/validators/${SS58}/history?window=all`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window).toBe("all");
  expect(queryText()).not.toContain("snapshot_date >=");
});

test("GET /api/v1/subnets/:netuid/neurons/:uid/history?window=all skips the snapshot_date cutoff", async () => {
  mockRows.current = [{ ...NEURON_ROW, snapshot_date: "2026-01-01" }];
  const res = await req("/api/v1/subnets/7/neurons/3/history?window=all");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window).toBe("all");
  expect(queryText()).not.toContain("snapshot_date >=");
});

test("GET /api/v1/subnets/:netuid/history?window=all skips the snapshot_date cutoff", async () => {
  mockRows.current = [
    {
      snapshot_date: "2026-01-01",
      neuron_count: "5",
      validator_count: "2",
      total_stake_tao: "10",
      total_emission_tao: "1",
    },
  ];
  const res = await req("/api/v1/subnets/7/history?window=all");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window).toBe("all");
  expect(queryText()).not.toContain("snapshot_date >=");
});

test("GET /api/v1/chain/turnover falls back on an unrecognized window and respects an explicit limit", async () => {
  mockQueue.current = [
    [],
    [{ start_date: "2026-06-01", end_date: "2026-07-01" }],
    [
      {
        snapshot_date: "2026-06-01",
        netuid: 7,
        hotkey: "5Hot",
        validator_permit: true,
      },
      {
        snapshot_date: "2026-07-01",
        netuid: 7,
        hotkey: "5Hot2",
        validator_permit: true,
      },
    ],
  ];
  const res = await req("/api/v1/chain/turnover?window=bogus&limit=5");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window).toBe("30d");
});

test("GET /api/v1/chain/turnover reports comparable:false on a cold store (no boundary snapshots)", async () => {
  mockQueue.current = [[], []];
  const res = await req("/api/v1/chain/turnover");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.comparable).toBe(false);
  expect(body.start_date).toBeNull();
});

test("GET /api/v1/subnets/:netuid/turnover falls back on an unrecognized window", async () => {
  mockQueue.current = [
    [],
    [{ start_date: "2026-06-01", end_date: "2026-07-01" }],
    [
      {
        snapshot_date: "2026-06-01",
        uid: 3,
        hotkey: "5Hot",
        validator_permit: true,
      },
      {
        snapshot_date: "2026-07-01",
        uid: 3,
        hotkey: "5Hot",
        validator_permit: true,
      },
    ],
  ];
  const res = await req("/api/v1/subnets/7/turnover?window=bogus");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window).toBe("30d");
});

test("GET /api/v1/subnets/:netuid/turnover?window=all skips the newest-snapshot anchor", async () => {
  mockQueue.current = [
    [],
    [{ start_date: "2026-01-01", end_date: "2026-07-01" }],
    [
      {
        snapshot_date: "2026-01-01",
        uid: 3,
        hotkey: "5Hot",
        validator_permit: true,
      },
      {
        snapshot_date: "2026-07-01",
        uid: 3,
        hotkey: "5Hot",
        validator_permit: true,
      },
    ],
  ];
  const res = await req("/api/v1/subnets/7/turnover?window=all");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window).toBe("all");
  expect(queryText()).not.toContain("MAX(snapshot_date) -");
});

test("GET /api/v1/subnets/:netuid/turnover reports comparable:false on a cold store (no boundary snapshots)", async () => {
  mockQueue.current = [[], []];
  const res = await req("/api/v1/subnets/7/turnover");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.comparable).toBe(false);
});

test("GET /api/v1/subnets/movers falls back on an unrecognized window and respects an explicit limit", async () => {
  mockQueue.current = [
    [],
    [{ start_date: "2026-06-01", end_date: "2026-07-01" }],
    [
      {
        netuid: 7,
        snapshot_date: "2026-06-01",
        neuron_count: "5",
        validator_count: "2",
        total_stake_tao: "10",
        total_emission_tao: "1",
      },
      {
        netuid: 7,
        snapshot_date: "2026-07-01",
        neuron_count: "6",
        validator_count: "3",
        total_stake_tao: "20",
        total_emission_tao: "2",
      },
    ],
  ];
  const res = await req("/api/v1/subnets/movers?window=bogus&limit=5");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window).toBe("30d");
});

test("GET /api/v1/subnets/movers reports subnet_count:0 on a cold store (no boundary snapshots)", async () => {
  mockQueue.current = [[], []];
  const res = await req("/api/v1/subnets/movers");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(0);
});

// #4832 gap-closure: GET /api/v1/accounts/:ss58/subnets/:netuid/history, the
// read path for the account_position_daily rollup added to handleNeuronsSync.

test("GET /api/v1/accounts/:ss58/subnets/:netuid/history shapes one wallet's per-subnet position trend", async () => {
  mockRows.current = [
    {
      snapshot_date: "2026-07-01",
      captured_at: "1780000000000",
      uid: 3,
      coldkey: "5Cold",
      active: true,
      validator_permit: true,
      rank: "0.5",
      trust: "0.9",
      incentive: "0.6",
      dividends: "0.4",
      stake_tao: "10",
      emission_tao: "1",
    },
  ];
  const res = await req(`/api/v1/accounts/${SS58}/subnets/7/history`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ss58).toBe(SS58);
  expect(body.netuid).toBe(7);
  expect(body.points[0].snapshot_date).toBe("2026-07-01");
  expect(queryText()).toContain("FROM account_position_daily");
  expect(queryText()).toContain("WHERE account =");
});

test("GET /api/v1/accounts/:ss58/subnets/:netuid/history?window=all skips the snapshot_date cutoff", async () => {
  mockRows.current = [
    {
      snapshot_date: "2026-01-01",
      captured_at: "1780000000000",
      uid: 3,
      coldkey: "5Cold",
      active: true,
      validator_permit: true,
      rank: "0.5",
      trust: "0.9",
      incentive: "0.6",
      dividends: "0.4",
      stake_tao: "10",
      emission_tao: "1",
    },
  ];
  const res = await req(
    `/api/v1/accounts/${SS58}/subnets/7/history?window=all`,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window).toBe("all");
  expect(queryText()).not.toContain("snapshot_date >=");
});

// #4771: POST /api/v1/internal/neurons-sync -- the one write route in this
// otherwise-read-only Worker (see workers/data-api.mjs's handleNeuronsSync).
function neuronSyncRow(overrides = {}) {
  return {
    netuid: 8,
    uid: 3,
    hotkey: "5Hot",
    coldkey: "5Cold",
    active: 1,
    validator_permit: 1,
    rank: 1,
    trust: 0,
    validator_trust: 0.5,
    consensus: 0.4,
    incentive: 0.3,
    dividends: 0.2,
    emission_tao: 1.5,
    stake_tao: 100.25,
    registered_at_block: 1000,
    is_immunity_period: 0,
    axon: "1.2.3.4:9000",
    block_number: 5_000_000,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

function postNeurons(body, { secret, raw } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret !== undefined) headers["x-neurons-sync-token"] = secret;
  return req("/api/v1/internal/neurons-sync", {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body ?? []),
  });
}

test("neurons-sync rejects a missing or wrong token (401)", async () => {
  const wrong = await postNeurons([neuronSyncRow()], { secret: "wrong" });
  expect(wrong.status).toBe(401);
  const missing = await postNeurons([neuronSyncRow()]);
  expect(missing.status).toBe(401);
});

test("neurons-sync is disabled (503) when NEURONS_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/neurons-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-neurons-sync-token": NEURONS_SYNC_SECRET,
      },
      body: JSON.stringify([neuronSyncRow()]),
    }),
    { HYPERDRIVE: { connectionString: "postgres://mock" } },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("neurons-sync returns 503 when the HYPERDRIVE binding is unavailable", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/neurons-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-neurons-sync-token": NEURONS_SYNC_SECRET,
      },
      body: JSON.stringify([neuronSyncRow()]),
    }),
    { NEURONS_SYNC_SECRET },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("neurons-sync rejects a body over the byte cap (413)", async () => {
  const res = await postNeurons(null, {
    secret: NEURONS_SYNC_SECRET,
    raw: "[" + "1".repeat(33_000_000) + "]",
  });
  expect(res.status).toBe(413);
});

test("neurons-sync rejects malformed JSON (400)", async () => {
  const res = await postNeurons(null, {
    secret: NEURONS_SYNC_SECRET,
    raw: "{not json",
  });
  expect(res.status).toBe(400);
});

test("neurons-sync rejects a body that isn't an array or {rows:[...]} (400)", async () => {
  const res = await postNeurons(
    { not: "an array" },
    { secret: NEURONS_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("neurons-sync accepts the {rows:[...]} wrapped form, not just a bare array", async () => {
  const res = await postNeurons(
    { rows: [neuronSyncRow()] },
    { secret: NEURONS_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.neurons_written).toBe(1);
});

test("neurons-sync rejects more than the row cap (413)", async () => {
  const many = Array.from({ length: 50_001 }, (_, i) =>
    neuronSyncRow({ uid: i % 65_536 }),
  );
  const res = await postNeurons(many, { secret: NEURONS_SYNC_SECRET });
  expect(res.status).toBe(413);
});

test("neurons-sync rejects rows with an out-of-range netuid/uid (400)", async () => {
  const netuid = await postNeurons([neuronSyncRow({ netuid: 70_000 })], {
    secret: NEURONS_SYNC_SECRET,
  });
  expect(netuid.status).toBe(400);
  const uid = await postNeurons([neuronSyncRow({ uid: 70_000 })], {
    secret: NEURONS_SYNC_SECRET,
  });
  expect(uid.status).toBe(400);
});

test("neurons-sync rejects a non-object row (400)", async () => {
  const res = await postNeurons(["not-an-object"], {
    secret: NEURONS_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

test("neurons-sync rejects a row carrying an unknown column (400)", async () => {
  const res = await postNeurons([neuronSyncRow({ unexpected_field: "nope" })], {
    secret: NEURONS_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

// #5163 follow-up: handleNeuronDailyBackfill was fixed to strip a
// client-provided snapshot_date before validation, but handleNeuronsSync had
// the exact same bug (snapshot_date isn't in NEURON_INSERT_COLUMNS, so
// validNeuronSyncRow's key allowlist rejected the whole row) and was never
// patched alongside it -- caught by review, fixed here too.
test("neurons-sync ignores a client-provided snapshot_date instead of rejecting the row (400 bug, now fixed)", async () => {
  const capturedAt = Date.parse("2026-05-29T12:34:56.000Z");
  const res = await postNeurons(
    [neuronSyncRow({ captured_at: capturedAt, snapshot_date: "1999-01-01" })],
    { secret: NEURONS_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.neurons_written).toBe(1);
  const neuronDailyInsert = sqlCalls.find((call) =>
    /INSERT INTO neuron_daily\b/.test(call.text),
  );
  expect(neuronDailyInsert.values).toContain("2026-05-29");
  expect(neuronDailyInsert.values).not.toContain("1999-01-01");
});

test.each([
  ["null", null],
  ["a non-object primitive", "not-a-row"],
  ["a nested array", [1, 2, 3]],
])(
  "neurons-sync rejects a row that is %s (400, not a throw)",
  async (_label, malformedRow) => {
    const res = await postNeurons([neuronSyncRow(), malformedRow], {
      secret: NEURONS_SYNC_SECRET,
    });
    expect(res.status).toBe(400);
  },
);

test("neurons-sync rejects a row with a string field over the byte cap (400)", async () => {
  const res = await postNeurons([neuronSyncRow({ hotkey: "5".repeat(600) })], {
    secret: NEURONS_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

test("neurons-sync rejects a row with a numeric field that overflows to Infinity (400)", async () => {
  // JSON.stringify(NaN) silently serializes to `null` (not a reproduction of
  // this check), but a raw oversized literal like 1e400 is syntactically
  // valid JSON that JSON.parse genuinely parses to Infinity -- a real,
  // reachable way a non-finite number arrives here.
  const { stake_tao: _stakeTao, ...rest } = neuronSyncRow();
  const raw = JSON.stringify([rest]).replace(/}\]$/, `,"stake_tao":1e400}]`);
  const res = await postNeurons(null, { secret: NEURONS_SYNC_SECRET, raw });
  expect(res.status).toBe(400);
});

test("neurons-sync rejects a row carrying a nested object/array value instead of a scalar (400)", async () => {
  const res = await postNeurons(
    [neuronSyncRow({ hotkey: ["not", "a", "scalar"] })],
    { secret: NEURONS_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("neurons-sync rejects a row missing a valid captured_at (400)", async () => {
  const res = await postNeurons([neuronSyncRow({ captured_at: 0 })], {
    secret: NEURONS_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

test("neurons-sync rejects an empty array (400)", async () => {
  const res = await postNeurons([], { secret: NEURONS_SYNC_SECRET });
  expect(res.status).toBe(400);
});

test("neurons-sync upserts neurons + neuron_daily + account_position_daily and reports written counts", async () => {
  const res = await postNeurons(
    [neuronSyncRow(), neuronSyncRow({ uid: 4, netuid: 9 })],
    { secret: NEURONS_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({
    ok: true,
    neurons_written: 2,
    neuron_daily_written: 2,
    account_position_daily_written: 2,
    netuids_covered: 2,
  });
  expect(queryText()).toMatch(/INSERT INTO neurons\b/);
  expect(queryText()).toMatch(/INSERT INTO neuron_daily/);
  expect(queryText()).toMatch(/INSERT INTO account_position_daily/);
  expect(queryText()).toMatch(/DELETE FROM neurons/);
});

test("neurons-sync skips account_position_daily for a row with a null hotkey", async () => {
  const { hotkey: _hotkey, ...rest } = neuronSyncRow();
  const res = await postNeurons([{ ...rest, hotkey: null }], {
    secret: NEURONS_SYNC_SECRET,
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.account_position_daily_written).toBe(0);
  expect(queryText()).not.toMatch(/INSERT INTO account_position_daily/);
});

test("neurons-sync computes one max captured_at per netuid across its many UID rows (the realistic multi-UID-per-subnet case)", async () => {
  // Real payloads have ~256 UID rows per netuid sharing one captured_at; a
  // later row for a netuid already seen must not incorrectly lower or
  // duplicate its recorded threshold.
  await postNeurons(
    [
      neuronSyncRow({ netuid: 8, uid: 0, captured_at: 1000 }),
      neuronSyncRow({ netuid: 8, uid: 1, captured_at: 1000 }),
      neuronSyncRow({ netuid: 8, uid: 2, captured_at: 1000 }),
    ],
    { secret: NEURONS_SYNC_SECRET },
  );
  const pruneCall = sqlCalls.find((c) => /DELETE FROM neurons/.test(c.text));
  // One (netuid, captured_at) pair, not three -- the repeat rows for netuid 8
  // collapse to a single threshold entry.
  expect(pruneCall.values).toEqual([8, 1000]);
});

test("neurons-sync coerces 0/1 active/validator_permit/is_immunity_period to real booleans", async () => {
  await postNeurons(
    [
      neuronSyncRow({
        active: 1,
        validator_permit: 0,
        is_immunity_period: 1,
      }),
    ],
    { secret: NEURONS_SYNC_SECRET },
  );
  const neuronsInsert = sqlCalls.find((c) =>
    /INSERT INTO neurons\b/.test(c.text),
  );
  expect(neuronsInsert.values).toContain(true); // active / is_immunity_period
  expect(neuronsInsert.values).toContain(false); // validator_permit
});

test("neurons-sync defaults a missing optional column (e.g. axon) to null rather than undefined", async () => {
  const { axon: _axon, ...withoutAxon } = neuronSyncRow();
  const res = await postNeurons([withoutAxon], {
    secret: NEURONS_SYNC_SECRET,
  });
  expect(res.status).toBe(200);
  const neuronsInsert = sqlCalls.find((c) =>
    /INSERT INTO neurons\b/.test(c.text),
  );
  expect(neuronsInsert.values).toContain(null);
});

test("neurons-sync derives snapshot_date from captured_at for the neuron_daily row", async () => {
  await postNeurons(
    [neuronSyncRow({ captured_at: Date.parse("2026-06-20T12:00:00Z") })],
    { secret: NEURONS_SYNC_SECRET },
  );
  const dailyInsert = sqlCalls.find((c) =>
    /INSERT INTO neuron_daily/.test(c.text),
  );
  expect(dailyInsert.values).toContain("2026-06-20");
});

test("neurons-sync scopes the deregistered-UID prune to only the netuids present in this batch", async () => {
  await postNeurons(
    [neuronSyncRow({ netuid: 8 }), neuronSyncRow({ netuid: 9, uid: 1 })],
    { secret: NEURONS_SYNC_SECRET },
  );
  const pruneCall = sqlCalls.find((c) => /DELETE FROM neurons/.test(c.text));
  // Flat (netuid, captured_at) pairs -- sql.unsafe positional params, not a
  // bound array (see the #4771 hotfix comment in handleNeuronsSync).
  expect(pruneCall.values).toEqual(expect.arrayContaining([8, 9]));
  expect(pruneCall.values).toHaveLength(4);
  expect(pruneCall.text).toMatch(/\$1::int, \$2::bigint/);
});

// REGRESSION (Gittensory Gate finding, 2026-07-10): the prune threshold must
// be PER-NETUID, not one batch-wide max captured_at. A shared max let one
// netuid's later capture prune rows THIS SAME REQUEST just upserted for a
// different, earlier-captured netuid in the same batch (netuid 8's own rows,
// captured_at=1000, would satisfy a shared `captured_at < 2000` threshold
// driven by netuid 9's later capture and get wrongly deleted).
test("neurons-sync prunes each netuid against its OWN max captured_at, not the batch-wide max", async () => {
  await postNeurons(
    [
      neuronSyncRow({ netuid: 8, captured_at: 1000 }),
      neuronSyncRow({ netuid: 9, uid: 1, captured_at: 2000 }),
    ],
    { secret: NEURONS_SYNC_SECRET },
  );
  const pruneCall = sqlCalls.find((c) => /DELETE FROM neurons/.test(c.text));
  // Flat (netuid, captured_at) pairs, in netuid-first-seen order.
  const pairs = [];
  for (let i = 0; i < pruneCall.values.length; i += 2) {
    pairs.push([pruneCall.values[i], pruneCall.values[i + 1]]);
  }
  const byNetuid = new Map(pairs);
  // Each netuid's threshold must equal ITS OWN captured_at from this batch --
  // never the other netuid's (which the old shared-max bug would have used).
  expect(byNetuid.get(8)).toBe(1000);
  expect(byNetuid.get(9)).toBe(2000);
});

test("neurons-sync reports deregistered_pruned from the DELETE's returned row count", async () => {
  neuronsSyncPruneRows.current = [{ netuid: 8 }, { netuid: 8 }];
  const res = await postNeurons([neuronSyncRow()], {
    secret: NEURONS_SYNC_SECRET,
  });
  const body = await res.json();
  expect(body.deregistered_pruned).toBe(2);
});

test("neurons-sync maps a DB failure to a clean 502 instead of throwing", async () => {
  neuronsSyncFailure.error = new Error("connection reset");
  const res = await postNeurons([neuronSyncRow()], {
    secret: NEURONS_SYNC_SECRET,
  });
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("write failed");
});

// POST /api/v1/internal/backfill-neuron-daily -- deep-history ingest for
// scripts/backfill-neuron-history.py and scripts/backfill-stake-monthly.py
// (workers/data-api.mjs's handleNeuronDailyBackfill). Same row shape as
// neurons-sync (reuses neuronSyncRow), different route/secret, and critically
// must NEVER touch the latest-only `neurons` table.
function postNeuronDailyBackfill(body, { secret, raw } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret !== undefined) headers["x-neuron-daily-backfill-token"] = secret;
  return req("/api/v1/internal/backfill-neuron-daily", {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body ?? []),
  });
}

test("backfill-neuron-daily rejects a missing or wrong token (401)", async () => {
  const wrong = await postNeuronDailyBackfill([neuronSyncRow()], {
    secret: "wrong",
  });
  expect(wrong.status).toBe(401);
  const missing = await postNeuronDailyBackfill([neuronSyncRow()]);
  expect(missing.status).toBe(401);
});

test("backfill-neuron-daily is disabled (503) when NEURON_DAILY_BACKFILL_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/backfill-neuron-daily", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-neuron-daily-backfill-token": NEURON_DAILY_BACKFILL_SECRET,
      },
      body: JSON.stringify([neuronSyncRow()]),
    }),
    { HYPERDRIVE: { connectionString: "postgres://mock" } },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("backfill-neuron-daily returns 503 when the HYPERDRIVE binding is unavailable", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/backfill-neuron-daily", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-neuron-daily-backfill-token": NEURON_DAILY_BACKFILL_SECRET,
      },
      body: JSON.stringify([neuronSyncRow()]),
    }),
    { NEURON_DAILY_BACKFILL_SECRET },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("backfill-neuron-daily rejects malformed JSON (400)", async () => {
  const res = await postNeuronDailyBackfill(null, {
    secret: NEURON_DAILY_BACKFILL_SECRET,
    raw: "{not json",
  });
  expect(res.status).toBe(400);
});

test("backfill-neuron-daily rejects a body that isn't an array or {rows:[...]} (400)", async () => {
  const res = await postNeuronDailyBackfill(
    { not: "an array" },
    { secret: NEURON_DAILY_BACKFILL_SECRET },
  );
  expect(res.status).toBe(400);
});

test("backfill-neuron-daily rejects more than the row cap (413)", async () => {
  const many = Array.from({ length: 50_001 }, (_, i) =>
    neuronSyncRow({ uid: i % 65_536 }),
  );
  const res = await postNeuronDailyBackfill(many, {
    secret: NEURON_DAILY_BACKFILL_SECRET,
  });
  expect(res.status).toBe(413);
});

test("backfill-neuron-daily accepts a null stake_tao (backfill-neuron-history.py's deferred-stake row)", async () => {
  const res = await postNeuronDailyBackfill(
    [neuronSyncRow({ stake_tao: null })],
    { secret: NEURON_DAILY_BACKFILL_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.neuron_daily_written).toBe(1);
});

test("backfill-neuron-daily ignores client snapshot_date and derives it from captured_at", async () => {
  const capturedAt = Date.parse("2026-05-29T12:34:56.000Z");
  const res = await postNeuronDailyBackfill(
    [
      neuronSyncRow({
        captured_at: capturedAt,
        snapshot_date: "1999-01-01",
      }),
    ],
    { secret: NEURON_DAILY_BACKFILL_SECRET },
  );
  expect(res.status).toBe(200);
  expect((await res.json()).neuron_daily_written).toBe(1);
  const neuronDailyInsert = sqlCalls.find((call) =>
    /INSERT INTO neuron_daily\b/.test(call.text),
  );
  expect(neuronDailyInsert.values).toContain("2026-05-29");
  expect(neuronDailyInsert.values).not.toContain("1999-01-01");
});

// stripClientSnapshotDate's own null/non-object/array guard (mirrors
// validNeuronSyncRow's identical guard, workers/data-api.mjs) -- each malformed
// row still fails validation with the same 400, never a crash on destructuring.
test.each([
  ["null", null],
  ["a non-object primitive", "not-a-row"],
  ["a nested array", [1, 2, 3]],
])(
  "backfill-neuron-daily rejects a row that is %s (400, not a throw)",
  async (_label, malformedRow) => {
    const res = await postNeuronDailyBackfill([neuronSyncRow(), malformedRow], {
      secret: NEURON_DAILY_BACKFILL_SECRET,
    });
    expect(res.status).toBe(400);
  },
);

test("backfill-neuron-daily writes neuron_daily + account_position_daily but NEVER the latest-only neurons table", async () => {
  const res = await postNeuronDailyBackfill([neuronSyncRow()], {
    secret: NEURON_DAILY_BACKFILL_SECRET,
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({
    ok: true,
    neuron_daily_written: 1,
    account_position_daily_written: 1,
  });
  const text = queryText();
  expect(text).toMatch(/INSERT INTO neuron_daily\b/);
  expect(text).toMatch(/INSERT INTO account_position_daily\b/);
  // The critical invariant: a backfill batch must never touch the
  // latest-only `neurons` table or its deregistration prune (both are
  // wrong for historical dates -- see handleNeuronDailyBackfill's header).
  expect(text).not.toMatch(/INSERT INTO neurons\b/);
  expect(text).not.toMatch(/DELETE FROM neurons\b/);
});

test("backfill-neuron-daily accepts the {rows:[...]} wrapped form, not just a bare array", async () => {
  const res = await postNeuronDailyBackfill(
    { rows: [neuronSyncRow()] },
    { secret: NEURON_DAILY_BACKFILL_SECRET },
  );
  expect(res.status).toBe(200);
  expect((await res.json()).neuron_daily_written).toBe(1);
});

test("backfill-neuron-daily rejects a body over the byte cap (413)", async () => {
  const res = await postNeuronDailyBackfill(null, {
    secret: NEURON_DAILY_BACKFILL_SECRET,
    raw: "[" + "1".repeat(33_000_000) + "]",
  });
  expect(res.status).toBe(413);
});

test("backfill-neuron-daily rejects rows that don't match the neuron row shape (400)", async () => {
  const res = await postNeuronDailyBackfill(
    [neuronSyncRow({ netuid: 70_000 })],
    { secret: NEURON_DAILY_BACKFILL_SECRET },
  );
  expect(res.status).toBe(400);
});

test("backfill-neuron-daily excludes a null-hotkey row from account_position_daily", async () => {
  const res = await postNeuronDailyBackfill([neuronSyncRow({ hotkey: null })], {
    secret: NEURON_DAILY_BACKFILL_SECRET,
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.neuron_daily_written).toBe(1);
  expect(body.account_position_daily_written).toBe(0);
});

test("backfill-neuron-daily maps a DB failure to a clean 502 instead of throwing", async () => {
  neuronDailyBackfillFailure.error = new Error("connection reset");
  const res = await postNeuronDailyBackfill([neuronSyncRow()], {
    secret: NEURON_DAILY_BACKFILL_SECRET,
  });
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("write failed");
});

test("POST to a different path is rejected with 405 (neurons-sync route only accepts its own path)", async () => {
  const res = await req("/api/v1/chain-events", { method: "POST" });
  expect(res.status).toBe(405);
});

test("unknown path is 404", async () => {
  const res = await req("/api/v1/nope");
  expect(res.status).toBe(404);
});

test("missing Hyperdrive binding is 503", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/chain-events"),
    {},
    ctx,
  );
  expect(res.status).toBe(503);
});

// account_events-derived analytics routes (#4826): D1's account_events copy is
// frozen since the streamer stopped; these port each D1-only analytics route to
// this already-live Postgres account_events table. Every build*/window map is
// reused unchanged from its D1 sibling module (pure, store-agnostic) -- only the
// query + response-shape wiring is new here.

test("GET /api/v1/validators/:hotkey/nominators returns a nominators card shaped like the D1 route", async () => {
  mockRows.current = [
    {
      coldkey: "5Cold",
      staked_tao: "10",
      unstaked_tao: "2",
      event_count: 3,
      last_observed: "1783600000000",
      net_staked_tao: "8",
      gross_staked_tao: "12",
    },
  ];
  const res = await req(`/api/v1/validators/${SS58}/nominators?window=30d`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.nominator_count).toBe(1);
  expect(body.data.nominators[0].coldkey).toBe("5Cold");
  expect(body.data.nominators[0].net_staked_tao).toBeCloseTo(8);
});

test("GET /api/v1/validators/:hotkey/nominators applies an optional coldkey filter", async () => {
  mockRows.current = [];
  await req(`/api/v1/validators/${SS58}/nominators?coldkey=5Cold`);
  expect(queryText()).toContain("AND coldkey =");
});

test("GET /api/v1/validators/:hotkey/nominators sorts by the requested column", async () => {
  mockRows.current = [];
  await req(`/api/v1/validators/${SS58}/nominators?sort=gross_staked`);
  expect(queryText()).toContain("gross_staked_tao DESC, 1 ASC");
});

test("GET /api/v1/validators/:hotkey/nominators sorts by last_activity", async () => {
  mockRows.current = [];
  await req(`/api/v1/validators/${SS58}/nominators?sort=last_activity`);
  expect(queryText()).toContain("last_observed DESC, 1 ASC");
});

test("GET /api/v1/validators/:hotkey/nominators falls back to the default window for an unrecognized label", async () => {
  mockRows.current = [];
  const res = await req(`/api/v1/validators/${SS58}/nominators?window=bogus`);
  const body = await res.json();
  expect(body.data.window).toBe("30d");
});

test("GET /api/v1/validators/:hotkey/nominators computes generatedAt as the newest of multiple rows, ignoring a non-finite timestamp", async () => {
  mockRows.current = [
    {
      coldkey: "5A",
      staked_tao: "1",
      unstaked_tao: "0",
      event_count: 1,
      last_observed: "not-a-number",
      net_staked_tao: "1",
      gross_staked_tao: "1",
    },
    {
      coldkey: "5B",
      staked_tao: "1",
      unstaked_tao: "0",
      event_count: 1,
      last_observed: "1783600000000",
      net_staked_tao: "1",
      gross_staked_tao: "1",
    },
    {
      coldkey: "5C",
      staked_tao: "1",
      unstaked_tao: "0",
      event_count: 1,
      last_observed: "1783700000000",
      net_staked_tao: "1",
      gross_staked_tao: "1",
    },
  ];
  const res = await req(`/api/v1/validators/${SS58}/nominators`);
  const body = await res.json();
  expect(body.generatedAt).toBe(new Date(1783700000000).toISOString());
});

test("GET /api/v1/accounts/:ss58/weight-setters unions the direct-hotkey and neurons-join branches", async () => {
  mockRows.current = [
    {
      netuid: 4,
      weight_sets: "3",
      first_observed: "1783500000000",
      last_observed: "1783600000000",
    },
  ];
  const res = await req(`/api/v1/accounts/${SS58}/weight-setters?window=7d`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.subnets[0].netuid).toBe(4);
  expect(body.data.dominant_netuid).toBe(4);
  const text = queryText();
  expect(text).toContain("UNION ALL");
  expect(text).toContain("JOIN account_events e ON e.netuid = n.netuid");
});

test("GET /api/v1/subnets/:netuid/weights returns the aggregate WeightsSet card", async () => {
  mockRows.current = [
    {
      weight_sets: "5",
      distinct_setters: "3",
      newest_observed: "1783600000000",
    },
  ];
  const res = await req("/api/v1/subnets/4/weights?window=7d");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.weight_sets).toBe(5);
  expect(body.distinct_setters).toBe(3);
  expect(queryText()).toContain("event_kind = ");
});

test("GET /api/v1/subnets/:netuid/weights with no rows returns the zeroed card, not a throw", async () => {
  mockRows.current = [];
  const res = await req("/api/v1/subnets/4/weights");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.weight_sets).toBe(0);
});

test("GET /api/v1/subnets/:netuid/volume shapes a buy/sell alpha rollup", async () => {
  mockRows.current = [
    {
      event_kind: "StakeAdded",
      alpha_volume: "10",
      tao_volume: "20",
      event_count: 2,
      last_observed: "1783600000000",
    },
    {
      event_kind: "StakeRemoved",
      alpha_volume: "4",
      tao_volume: "8",
      event_count: 1,
      last_observed: "1783600000000",
    },
  ];
  const res = await req("/api/v1/subnets/4/volume");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.buy_volume_alpha).toBe(10);
  expect(body.data.sell_volume_alpha).toBe(4);
  expect(body.data.vol_mcap_ratio).toBeNull(); // no KV/R2 access from this Worker
  expect(queryText()).toContain("event_kind IN (");
});

test("GET /api/v1/subnets/:netuid/ohlc shapes raw account_events rows into candles", async () => {
  mockRows.current = [
    {
      event_kind: "StakeAdded",
      alpha_amount: "10",
      amount_tao: "20",
      observed_at: "1783600000000",
    },
    {
      event_kind: "StakeRemoved",
      alpha_amount: "5",
      amount_tao: "15",
      observed_at: "1783600060000",
    },
  ];
  const res = await req("/api/v1/subnets/4/ohlc");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.netuid).toBe(4);
  expect(body.data.interval).toBe("1h");
  expect(body.data.candles.length).toBe(1);
  expect(body.data.candles[0].open).toBe(2); // 20/10
  expect(body.data.candles[0].close).toBe(3); // 15/5
  expect(body.data.candles[0].event_count).toBe(2);
  // Raw-row query, not a GROUP BY/array_agg aggregation (src/subnet-ohlc.mjs
  // does the bucketing in JS) -- the SQL itself stays a plain filtered
  // SELECT ordered by observed_at.
  expect(queryText()).toContain("event_kind IN (");
  expect(queryText()).toContain("ORDER BY observed_at ASC");
  expect(queryText()).not.toContain("GROUP BY");
});

test("GET /api/v1/subnets/:netuid/ohlc honors ?interval=1d", async () => {
  mockRows.current = [
    {
      event_kind: "StakeAdded",
      alpha_amount: "10",
      amount_tao: "20",
      observed_at: "1783600000000",
    },
  ];
  const res = await req("/api/v1/subnets/4/ohlc?interval=1d");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.interval).toBe("1d");
});

test("GET /api/v1/subnets/:netuid/ohlc with no rows returns an empty candle array, not a throw", async () => {
  mockRows.current = [];
  const res = await req("/api/v1/subnets/4/ohlc");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.candles).toEqual([]);
});

test("GET /api/v1/subnets/0/ohlc (root) is schema-stable with root_excluded:true", async () => {
  mockRows.current = [];
  const res = await req("/api/v1/subnets/0/ohlc");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.root_excluded).toBe(true);
  expect(body.data.candles).toEqual([]);
});

test("GET /api/v1/subnets/:netuid/ohlc clamps an out-of-range ?days= to the max lookback rather than erroring", async () => {
  mockRows.current = [];
  const res = await req("/api/v1/subnets/4/ohlc?days=99999");
  expect(res.status).toBe(200);
});

test("GET /api/v1/subnets/:netuid/ownership-history shapes raw chain_events rows into decoded transfers", async () => {
  mockRows.current = [
    {
      block_number: "8587754",
      pallet: "SubtensorModule",
      method: "SubnetOwnerChanged",
      args: {
        netuid: 7,
        old_coldkey: [
          [
            230, 177, 94, 10, 88, 222, 149, 217, 176, 218, 228, 3, 237, 17, 117,
            251, 19, 70, 95, 132, 123, 114, 171, 235, 189, 66, 130, 2, 183, 175,
            143, 88,
          ],
        ],
        new_coldkey: [
          [
            109, 111, 100, 108, 115, 117, 98, 116, 101, 110, 115, 114, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          ],
        ],
      },
      observed_at: "1783600000000",
    },
  ];
  const res = await req("/api/v1/subnets/7/ownership-history");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.netuid).toBe(7);
  expect(body.count).toBe(1);
  expect(body.ownership_changes[0].old_coldkey).toBe(
    "5HHBZRFX9UiyG77qU1pn1qMceRYKeg2a4yGBwPCHCyDocX4i",
  );
  expect(body.ownership_changes[0].new_coldkey).toBe(
    "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F",
  );
  const text = queryText();
  expect(text).toContain("FROM chain_events");
  expect(text).toContain("pallet = 'SubtensorModule'");
  expect(text).toContain("(args->>'netuid')::int =");
});

test("GET /api/v1/subnets/:netuid/ownership-history with no rows returns an empty list, not a throw", async () => {
  mockRows.current = [];
  const res = await req("/api/v1/subnets/7/ownership-history");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.count).toBe(0);
  expect(body.ownership_changes).toEqual([]);
});

test("GET /api/v1/accounts/:coldkey/entities shapes a network-wide (unfiltered) chain_events scan into this coldkey's ownership ties", async () => {
  mockRows.current = [
    {
      block_number: "8587754",
      pallet: "SubtensorModule",
      method: "SubnetOwnerChanged",
      args: {
        netuid: 7,
        old_coldkey: [
          [
            230, 177, 94, 10, 88, 222, 149, 217, 176, 218, 228, 3, 237, 17, 117,
            251, 19, 70, 95, 132, 123, 114, 171, 235, 189, 66, 130, 2, 183, 175,
            143, 88,
          ],
        ],
        new_coldkey: [
          [
            109, 111, 100, 108, 115, 117, 98, 116, 101, 110, 115, 114, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          ],
        ],
      },
      observed_at: "1783600000000",
    },
  ];
  const res = await req(
    "/api/v1/accounts/5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F/entities",
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ss58).toBe("5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F");
  expect(body.ownership_tie_count).toBe(1);
  expect(body.ownership_ties[0].role).toBe("gained_ownership");
  expect(body.ownership_ties[0].netuid).toBe(7);
  const text = queryText();
  expect(text).toContain("FROM chain_events");
  expect(text).toContain("pallet = 'SubtensorModule'");
  expect(text).not.toContain("netuid");
});

test("GET /api/v1/accounts/:coldkey/entities with no matching rows returns an empty result, not a throw", async () => {
  mockRows.current = [];
  const res = await req(
    "/api/v1/accounts/5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F/entities",
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ownership_tie_count).toBe(0);
  expect(body.ownership_ties).toEqual([]);
});

test("GET /api/v1/subnets/:netuid/lease/history shapes raw account_events rows into lease-lifecycle events", async () => {
  mockRows.current = [
    {
      block_number: "8587754",
      event_kind: "SubnetLeaseCreated",
      coldkey: "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F",
      observed_at: "1783600000000",
    },
  ];
  const res = await req("/api/v1/subnets/7/lease/history");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.netuid).toBe(7);
  expect(body.count).toBe(1);
  expect(body.lease_events[0].event_kind).toBe("SubnetLeaseCreated");
  expect(body.lease_events[0].beneficiary).toBe(
    "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F",
  );
  const text = queryText();
  expect(text).toContain("FROM account_events");
  expect(text).toContain("netuid =");
  expect(text).toContain("event_kind IN");
});

test("GET /api/v1/subnets/:netuid/lease/history with no rows returns an empty list, not a throw", async () => {
  mockRows.current = [];
  const res = await req("/api/v1/subnets/7/lease/history");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.count).toBe(0);
  expect(body.lease_events).toEqual([]);
});

// conviction (#6638) combines a subnet_locks Postgres read (mocked via
// mockRows, same as every other route in this file) with a live
// UnlockRate/MaturityRate/chain-tip RPC lookup -- stub globalThis.fetch for
// just that part, mirroring tests/subnet-burn.test.mjs's own save/restore
// pattern.
function stubConvictionRpc({ unlockRateHex, maturityRateHex, blockHex }) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "state_getStorage") {
      const key = body.params[0];
      // Last few hex chars distinguish the two hardcoded storage keys --
      // matches how the real keys differ only in their twox128(item) half.
      const hex = key.endsWith("cadb") ? unlockRateHex : maturityRateHex;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: hex }),
      );
    }
    if (body.method === "chain_getHeader") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { number: blockHex } }),
      );
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }),
    );
  };
  return () => {
    globalThis.fetch = orig;
  };
}

test("GET /api/v1/subnets/:netuid/conviction rolls a real subnet_locks row forward using the live rates", async () => {
  const restore = stubConvictionRpc({
    // 934866 LE u64 hex (real live-verified value).
    unlockRateHex: "0xd2430e0000000000",
    // 311622 LE u64 hex (real live-verified value).
    maturityRateHex: "0x46c1040000000000",
    // block 8647076 in hex.
    blockHex: "0x83f1a4",
  });
  try {
    mockRows.current = [
      {
        hotkey: "5CsvRJXuR955WojnGMdok1hbhffZyB4N5ocrv82f3p5A2zVp",
        is_owner: false,
        is_perpetual: true,
        locked_mass: "12801009134",
        conviction_bits: "103052736623230389324344213370",
        last_update: "8639094",
      },
    ];
    const res = await req("/api/v1/subnets/1/conviction");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.netuid).toBe(1);
    expect(body.unlock_rate).toBe(934866);
    expect(body.maturity_rate).toBe(311622);
    expect(body.count).toBe(1);
    expect(body.king).toBe("5CsvRJXuR955WojnGMdok1hbhffZyB4N5ocrv82f3p5A2zVp");
    // Conviction must have grown (perpetual lock, existing conviction
    // matures toward locked_mass), never shrunk to 0 or gone negative.
    expect(body.leaderboard[0].conviction).toBeGreaterThan(5586500046);
    const text = queryText();
    expect(text).toContain("FROM subnet_locks");
  } finally {
    restore();
  }
});

test("GET /api/v1/subnets/:netuid/conviction with no rows returns an empty leaderboard, not a throw", async () => {
  const restore = stubConvictionRpc({
    unlockRateHex: "0x9282e40000000000",
    maturityRateHex: "0x0663c40400000000",
    blockHex: "0x83f1a4",
  });
  try {
    mockRows.current = [];
    const res = await req("/api/v1/subnets/999/conviction");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(body.leaderboard).toEqual([]);
    expect(body.king).toBe(null);
  } finally {
    restore();
  }
});

test("GET /api/v1/subnets/:netuid/events returns the per-subnet feed and applies filters", async () => {
  mockRows.current = [ACCOUNT_EVENT_ROW];
  const res = await req(
    "/api/v1/subnets/4/events?kind=StakeAdded&block_start=1&block_end=2",
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.events[0].event_kind).toBe("StakeAdded");
  const text = queryText();
  expect(text).toContain("WHERE netuid =");
  expect(text).toContain("AND event_kind =");
  expect(text).toContain("AND block_number >=");
  expect(text).toContain("AND block_number <=");
});

test("GET /api/v1/subnets/:netuid/events uses a composite cursor seek instead of OFFSET", async () => {
  mockRows.current = [ACCOUNT_EVENT_ROW];
  await req("/api/v1/subnets/4/events?cursor=8586300.0");
  const text = queryText();
  expect(text).toContain("AND (block_number, event_index) <");
  expect(text).not.toContain("OFFSET");
});

test("GET /api/v1/subnets/:netuid/events returns a next_cursor when the page is full", async () => {
  mockRows.current = [ACCOUNT_EVENT_ROW];
  const res = await req("/api/v1/subnets/4/events?limit=1");
  const body = await res.json();
  expect(body.next_cursor).toBe("8586300.0");
});

test("GET /api/v1/subnets/:netuid/event-summary shapes kind/category aggregates + recent evidence", async () => {
  mockQueue.current = [
    [], // SET
    [
      {
        event_kind: "StakeAdded",
        event_count: "3",
        hotkey_count: "2",
        amount_tao: "5",
        alpha_amount: "1",
        first_block: 100,
        last_block: 200,
        first_observed_at: "1783500000000",
        last_observed_at: "1783600000000",
      },
      {
        // No matching coldkeyRows entry below -- exercises the Map-miss ?? 0
        // fallback, distinct from the StakeAdded row's real lookup hit.
        event_kind: "StakeRemoved",
        event_count: "1",
        hotkey_count: "1",
        amount_tao: "1",
        alpha_amount: "0",
        first_block: 100,
        last_block: 100,
        first_observed_at: "1783500000000",
        last_observed_at: "1783500000000",
      },
    ],
    [{ event_kind: "StakeAdded", coldkey_count: "2" }],
    [ACCOUNT_EVENT_ROW],
  ];
  const res = await req("/api/v1/subnets/4/event-summary?window=7d");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.event_kinds[0].event_kind).toBe("StakeAdded");
  expect(body.event_kinds[0].coldkey_count).toBe(2);
  const removed = body.event_kinds.find((k) => k.event_kind === "StakeRemoved");
  expect(removed.coldkey_count).toBe(0);
  expect(body.recent_events[0].event_kind).toBe("StakeAdded");
  expect(queryText()).toContain(
    "GROUP BY event_kind ORDER BY event_count DESC",
  );
  expect(queryText()).toContain("AND coldkey IS NOT NULL");
});

test("GET /api/v1/subnets/:netuid/event-summary defaults the window when absent", async () => {
  mockQueue.current = [[], [], [], []];
  const res = await req("/api/v1/subnets/4/event-summary");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window).toBe("30d");
});

test("GET /api/v1/subnets/:netuid/event-summary falls back to the default window for an unrecognized label", async () => {
  mockQueue.current = [[], [], [], []];
  const res = await req("/api/v1/subnets/4/event-summary?window=bogus");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window).toBe("30d");
});

test("GET /api/v1/subnets/:netuid/weights/setters returns a leaderboard + totals", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [
      {
        hotkey: SS58,
        uid: 1,
        weight_sets: "5",
        first_set: "1783500000000",
        last_set: "1783600000000",
      },
    ],
    [
      {
        weight_sets: "5",
        distinct_setters: "1",
        newest_observed: "1783600000000",
      },
    ],
  ];
  const res = await req("/api/v1/subnets/4/weights/setters");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.setters[0].weight_sets).toBe(5);
  expect(body.distinct_setters).toBe(1);
  expect(body.schema_version).toBe(1);
});

test("GET /api/v1/subnets/:netuid/weights/setters falls back to a null totals row when the aggregate query returns none", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [
      {
        hotkey: SS58,
        uid: 1,
        weight_sets: "5",
        first_set: "1783500000000",
        last_set: "1783600000000",
      },
    ],
    [],
  ];
  const res = await req("/api/v1/subnets/4/weights/setters");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.setters[0].weight_sets).toBe(5);
  expect(body.distinct_setters).toBe(0);
});

test("GET /api/v1/accounts/:ss58/stake-flow defaults to summing both directions", async () => {
  mockRows.current = [
    {
      netuid: 4,
      event_kind: "StakeAdded",
      total_tao: "10",
      event_count: 2,
      last_observed: "1783600000000",
    },
  ];
  await req(`/api/v1/accounts/${SS58}/stake-flow`);
  expect(queryText()).toContain("event_kind IN (?, ?)");
});

test("GET /api/v1/accounts/:ss58/stake-flow matches the address as either hotkey or coldkey", async () => {
  // Regression test: this query used to filter on coldkey only, so an
  // address that only ever appears as a hotkey (e.g. a validator receiving
  // delegations) silently reported an all-zero flow card despite having
  // real account_events rows -- see the base /accounts/:ss58 route just
  // above, which has always matched (hotkey = $1 OR coldkey = $1).
  mockRows.current = [];
  await req(`/api/v1/accounts/${SS58}/stake-flow`);
  expect(queryText()).toContain("(hotkey = ? OR coldkey = ?)");
});

test("GET /api/v1/accounts/:ss58/stake-flow narrows to one side via ?direction=in", async () => {
  mockRows.current = [];
  await req(`/api/v1/accounts/${SS58}/stake-flow?direction=in`);
  const text = queryText();
  expect(text).toContain("AND event_kind =");
  expect(text).not.toContain("event_kind IN");
});

test("GET /api/v1/accounts/:ss58/stake-flow narrows to one side via ?direction=out", async () => {
  mockRows.current = [];
  await req(`/api/v1/accounts/${SS58}/stake-flow?direction=out`);
  const text = queryText();
  expect(text).toContain("AND event_kind =");
  expect(text).not.toContain("event_kind IN");
});

test("GET /api/v1/subnets/:netuid/stake-flow shapes a per-kind rollup", async () => {
  mockRows.current = [
    {
      event_kind: "StakeAdded",
      total_tao: "10",
      event_count: 2,
      last_observed: "1783600000000",
    },
  ];
  const res = await req("/api/v1/subnets/4/stake-flow?direction=out");
  expect(res.status).toBe(200);
  expect(queryText()).toContain("AND event_kind =");
});

test("GET /api/v1/subnets/:netuid/stake-flow narrows to one side via ?direction=in", async () => {
  mockRows.current = [];
  await req("/api/v1/subnets/4/stake-flow?direction=in");
  const text = queryText();
  expect(text).toContain("AND event_kind =");
  expect(text).not.toContain("event_kind IN");
});

test("GET /api/v1/subnets/:netuid/stake-flow defaults to summing both directions", async () => {
  mockRows.current = [];
  await req("/api/v1/subnets/4/stake-flow");
  expect(queryText()).toContain("event_kind IN (?, ?)");
});

test("GET /api/v1/accounts/:ss58/stake-moves matches the address as either hotkey or coldkey", async () => {
  // Regression test: same coldkey-only bug as stake-flow above -- a hotkey-only
  // address must still surface its StakeMoved re-delegation activity.
  mockRows.current = [];
  await req(`/api/v1/accounts/${SS58}/stake-moves`);
  expect(queryText()).toContain("(hotkey = ? OR coldkey = ?)");
});

test("GET /api/v1/accounts/:ss58/stake-moves groups movements per subnet", async () => {
  mockRows.current = [
    {
      netuid: 4,
      movements: "2",
      first_observed: "1783500000000",
      last_observed: "1783600000000",
    },
  ];
  const res = await req(`/api/v1/accounts/${SS58}/stake-moves`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.subnets[0].movements).toBe(2);
});

test("GET /api/v1/subnets/:netuid/stake-moves returns the single-row aggregate", async () => {
  mockRows.current = [
    { movements: "4", distinct_movers: "3", newest_observed: "1783600000000" },
  ];
  const res = await req("/api/v1/subnets/4/stake-moves");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.movements).toBe(4);
  expect(body.distinct_movers).toBe(3);
  // #6877: the distinct-movers subquery groups by coldkey only (GROUP BY 1), so it
  // must NOT also SELECT the ungrouped `observed_at` — Postgres 500s on a selected
  // column that is neither grouped nor aggregated. `observed_at` is unused inside the
  // subquery (the outer query computes its own MAX(observed_at)).
  const movesSql = queryText();
  expect(movesSql).not.toMatch(
    /SELECT\s+coldkey\s*,\s*observed_at\s+FROM\s+account_events/i,
  );
  expect(movesSql).toMatch(
    /SELECT\s+coldkey\s+AS\s+\w+\s+FROM\s+account_events/i,
  );
});

test("GET /api/v1/subnets/:netuid/stake-moves with no aggregate row returns the zeroed card, not a throw", async () => {
  mockRows.current = [];
  const res = await req("/api/v1/subnets/4/stake-moves");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.movements).toBe(0);
});

test("GET /api/v1/subnets/:netuid/stake-transfers returns the single-row aggregate", async () => {
  mockRows.current = [
    { transfers: "6", distinct_senders: "2", newest_observed: "1783600000000" },
  ];
  const res = await req("/api/v1/subnets/4/stake-transfers");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.transfers).toBe(6);
  expect(body.distinct_senders).toBe(2);
  // #6877: identical grouped-subquery fix for the distinct-senders count — the
  // `senders` subquery must SELECT only the grouped coldkey, never the ungrouped
  // `observed_at` (same Postgres GROUP BY 500 as the sibling stake-moves route).
  const transfersSql = queryText();
  expect(transfersSql).not.toMatch(
    /SELECT\s+coldkey\s*,\s*observed_at\s+FROM\s+account_events/i,
  );
  expect(transfersSql).toMatch(
    /SELECT\s+coldkey\s+AS\s+\w+\s+FROM\s+account_events/i,
  );
});

test("GET /api/v1/subnets/:netuid/stake-transfers with no aggregate row returns the zeroed card, not a throw", async () => {
  mockRows.current = [];
  const res = await req("/api/v1/subnets/4/stake-transfers");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.transfers).toBe(0);
});

const ACCOUNT_FOOTPRINT_ROUTES = [
  ["registrations", "registrations"],
  ["serving", "announcements"],
  ["axon-removals", "removals"],
  ["prometheus", "announcements"],
  ["deregistrations", "deregistrations"],
];

for (const [path, metric] of ACCOUNT_FOOTPRINT_ROUTES) {
  test(`GET /api/v1/accounts/:ss58/${path} groups the account_events footprint per subnet`, async () => {
    mockRows.current = [
      {
        netuid: 4,
        metric: "3",
        first_observed: "1783500000000",
        last_observed: "1783600000000",
      },
    ];
    const res = await req(`/api/v1/accounts/${SS58}/${path}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.subnets[0][metric]).toBe(3);
    expect(body.data.subnets[0].netuid).toBe(4);
  });
}

const SUBNET_FOOTPRINT_ROUTES = [
  ["registrations", "registrations", "distinct_registrants"],
  ["serving", "announcements", "distinct_servers"],
  ["axon-removals", "removals", "distinct_removers"],
  ["prometheus", "announcements", "distinct_exporters"],
  ["deregistrations", "deregistrations", "distinct_deregistered_hotkeys"],
];

for (const [path, metric, distinct] of SUBNET_FOOTPRINT_ROUTES) {
  test(`GET /api/v1/subnets/:netuid/${path} returns the single-row subnet aggregate`, async () => {
    mockRows.current = [
      { metric: "7", distinctx: "5", newest_observed: "1783600000000" },
    ];
    const res = await req(`/api/v1/subnets/4/${path}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[metric]).toBe(7);
    expect(body[distinct]).toBe(5);
  });

  test(`GET /api/v1/subnets/:netuid/${path} with no rows returns the zeroed card, not a throw`, async () => {
    mockRows.current = [];
    const res = await req(`/api/v1/subnets/4/${path}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[metric]).toBe(0);
  });
}

test("GET /api/v1/accounts/:ss58/transfers reuses buildAccountTransfers unchanged", async () => {
  mockRows.current = [ACCOUNT_EVENT_ROW];
  const res = await req(`/api/v1/accounts/${SS58}/transfers`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.transfers[0].amount_tao).toBe(1.5);
  expect(queryText()).toContain("event_kind = 'Transfer'");
});

test("GET /api/v1/accounts/:ss58/transfers?direction=sent narrows to the hotkey side only", async () => {
  mockRows.current = [];
  await req(`/api/v1/accounts/${SS58}/transfers?direction=sent`);
  const text = queryText();
  expect(text).toContain("AND hotkey =");
  expect(text).not.toContain("OR coldkey");
});

test("GET /api/v1/accounts/:ss58/transfers?direction=received narrows to the coldkey side only", async () => {
  mockRows.current = [];
  await req(`/api/v1/accounts/${SS58}/transfers?direction=received`);
  const text = queryText();
  expect(text).toContain("AND coldkey =");
  expect(text).not.toContain("OR coldkey");
});

test("GET /api/v1/accounts/:ss58/transfers applies block_start/block_end bounds", async () => {
  mockRows.current = [];
  await req(`/api/v1/accounts/${SS58}/transfers?block_start=1&block_end=2`);
  const text = queryText();
  expect(text).toContain("AND block_number >=");
  expect(text).toContain("AND block_number <=");
});

test("GET /api/v1/accounts/:ss58/transfers uses a composite cursor seek instead of OFFSET", async () => {
  mockRows.current = [];
  await req(`/api/v1/accounts/${SS58}/transfers?cursor=8586300.0`);
  const text = queryText();
  expect(text).toContain("AND (block_number, event_index) <");
  expect(text).not.toContain("OFFSET");
});

test("GET /api/v1/accounts/:ss58/transfers returns a next_cursor when the page is full", async () => {
  mockRows.current = [ACCOUNT_EVENT_ROW];
  const res = await req(`/api/v1/accounts/${SS58}/transfers?limit=1`);
  const body = await res.json();
  expect(body.next_cursor).toBe("8586300.0");
});

test("GET /api/v1/accounts/:ss58/counterparties returns a counterparty leaderboard", async () => {
  mockRows.current = [
    {
      hotkey: SS58,
      coldkey: "5Cold",
      amount_tao: "2",
      block_number: 100,
      event_index: 0,
    },
  ];
  const res = await req(`/api/v1/accounts/${SS58}/counterparties`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.counterparties[0].address).toBe("5Cold");
});

test("GET /api/v1/accounts/:ss58/counterparties?counterparty= returns the relationship drilldown", async () => {
  mockRows.current = [
    {
      hotkey: SS58,
      coldkey: "5Cold",
      amount_tao: "2",
      block_number: 100,
      event_index: 0,
    },
  ];
  const res = await req(
    `/api/v1/accounts/${SS58}/counterparties?counterparty=5Cold`,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.counterparty_count).toBe(1);
  expect(body.counterparties[0]).toMatchObject({
    address: "5Cold",
    sent_tao: 2,
    received_tao: 0,
    net_tao: -2,
    transfer_count: 1,
    last_block: 100,
  });
  expect(body.relationship.counterparty).toBe("5Cold");
  expect(body.relationship.transfer_count).toBe(1);
  expect(queryText()).toContain("(hotkey = ");
});

test("GET /api/v1/accounts/:ss58/counterparties?counterparty= with no matching transfers returns an empty counterparties array", async () => {
  mockRows.current = [];
  const res = await req(
    `/api/v1/accounts/${SS58}/counterparties?counterparty=5Cold`,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.counterparty_count).toBe(0);
  expect(body.counterparties).toEqual([]);
  expect(body.relationship.transfer_count).toBe(0);
});

// #4832 gap-closure: POST /api/v1/internal/rollup-account-events-daily -- the
// account_events_daily write path account_events itself lacked (indexer-rs
// writes account_events continuously, but nothing rolled it into the daily
// summary table in Postgres), plus its read path,
// GET /api/v1/accounts/:ss58/history.
function postRollup({ secret } = {}) {
  const headers = {};
  if (secret !== undefined) headers["x-rollup-sync-token"] = secret;
  return req("/api/v1/internal/rollup-account-events-daily", {
    method: "POST",
    headers,
  });
}

test("rollup-account-events-daily rejects a missing or wrong token (401)", async () => {
  const wrong = await postRollup({ secret: "wrong" });
  expect(wrong.status).toBe(401);
  const missing = await postRollup();
  expect(missing.status).toBe(401);
});

test("rollup-account-events-daily is disabled (503) when ROLLUP_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/rollup-account-events-daily", {
      method: "POST",
      headers: { "x-rollup-sync-token": ROLLUP_SYNC_SECRET },
    }),
    { HYPERDRIVE: { connectionString: "postgres://mock" } },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("rollup-account-events-daily returns 503 when the HYPERDRIVE binding is unavailable", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/rollup-account-events-daily", {
      method: "POST",
      headers: { "x-rollup-sync-token": ROLLUP_SYNC_SECRET },
    }),
    { ROLLUP_SYNC_SECRET },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("rollup-account-events-daily rolls up the two active UTC days and reports them", async () => {
  const res = await postRollup({ secret: ROLLUP_SYNC_SECRET });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.rolled).toHaveLength(2);
  expect(queryText()).toMatch(/INSERT INTO account_events_daily/);
  expect(queryText()).toMatch(/FROM account_events/);
  expect(queryText()).toMatch(/string_agg\(DISTINCT event_kind/);
});

test("rollup-account-events-daily also rolls up wallet_flow_daily in the same run (#6886/#6887)", async () => {
  const res = await postRollup({ secret: ROLLUP_SYNC_SECRET });
  expect(res.status).toBe(200);
  expect(queryText()).toMatch(/INSERT INTO wallet_flow_daily/);
  expect(queryText()).toMatch(/net_flow_tao/);
  expect(queryText()).toMatch(/GROUP BY \(coldkey\)/);
});

test("rollup-account-events-daily maps a DB failure to a clean 502 instead of throwing", async () => {
  rollupFailure.error = new Error("connection reset");
  const res = await postRollup({ secret: ROLLUP_SYNC_SECRET });
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("rollup failed");
});

test("GET /api/v1/accounts/:ss58/history shapes the durable per-day activity series", async () => {
  mockRows.current = [
    {
      day: "2026-07-01",
      netuid: 7,
      event_count: "3",
      event_kinds: "StakeAdded,WeightsSet",
      first_block: "100",
      last_block: "200",
    },
  ];
  const res = await req(`/api/v1/accounts/${SS58}/history`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ss58).toBe(SS58);
  expect(body.days[0].day).toBe("2026-07-01");
  expect(queryText()).toContain("FROM account_events_daily");
  expect(queryText()).toContain("WHERE hotkey =");
});

test("GET /api/v1/accounts/:ss58/history?netuid= filters to one subnet", async () => {
  mockRows.current = [
    {
      day: "2026-07-01",
      netuid: 7,
      event_count: "1",
      event_kinds: "StakeAdded",
      first_block: "100",
      last_block: "100",
    },
  ];
  const res = await req(`/api/v1/accounts/${SS58}/history?netuid=7`);
  expect(res.status).toBe(200);
  expect(queryText()).toContain("AND netuid =");
});

test("GET /api/v1/accounts/:ss58/history?from=&to= filters the day range", async () => {
  mockRows.current = [];
  const res = await req(
    `/api/v1/accounts/${SS58}/history?from=2026-06-01&to=2026-06-30`,
  );
  expect(res.status).toBe(200);
  expect(queryText()).toContain("AND day >=");
  expect(queryText()).toContain("AND day <=");
});

test("GET /api/v1/accounts/:ss58/history?cursor= seeks past the encoded (day, netuid) pair", async () => {
  mockRows.current = [];
  const cursor = encodeCursor([20260701, 7]);
  const res = await req(`/api/v1/accounts/${SS58}/history?cursor=${cursor}`);
  expect(res.status).toBe(200);
  expect(queryText()).toContain("AND (day, netuid) <");
  expect(queryText()).not.toContain("OFFSET");
});

test("GET /api/v1/accounts/:ss58/history?limit=1 emits a next_cursor when the page is full", async () => {
  mockRows.current = [
    {
      day: "2026-07-01",
      netuid: 7,
      event_count: "1",
      event_kinds: "StakeAdded",
      first_block: "100",
      last_block: "100",
    },
  ];
  const res = await req(`/api/v1/accounts/${SS58}/history?limit=1`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.next_cursor).not.toBeNull();
});

test("GET /api/v1/accounts/:ss58/history maps a DB failure to a clean 502 via the router's generic catch (#6769)", async () => {
  // This route has no per-query try/catch of its own -- a failure here is
  // the one path in this whole file that reaches the OUTERMOST generic
  // catch (captureDataApiError(err, url.pathname)) at the bottom of the
  // route dispatcher, rather than a route-specific fallback.
  accountHistoryQueryFailure.error = new Error("connection reset");
  const res = await req(`/api/v1/accounts/${SS58}/history`);
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.error).toBe("data query failed");
});

// #4832 gap-closure: POST /api/v1/internal/subnet-hyperparams-sync -- the
// write path into subnet_hyperparams/subnet_hyperparams_history (see
// workers/data-api.mjs's handleSubnetHyperparamsSync), plus its read paths,
// GET /api/v1/subnets/:netuid/hyperparameters[/history].
function hyperparamsSyncRow(overrides = {}) {
  return {
    netuid: 8,
    kappa_ratio: 0.5,
    immunity_period: 7200,
    min_allowed_weights: 8,
    max_weight_limit_ratio: 1,
    tempo: 360,
    weights_version: 1,
    weights_rate_limit: 100,
    activity_cutoff: 5000,
    activity_cutoff_factor: 1,
    registration_allowed: 1,
    target_regs_per_interval: 1,
    min_burn_tao: 0.001,
    max_burn_tao: 100,
    burn_half_life: 100_000,
    burn_increase_mult: 1,
    bonds_moving_avg_raw: 900_000,
    max_regs_per_block: 1,
    serving_rate_limit: 50,
    max_validators: 64,
    commit_reveal_period: 1,
    commit_reveal_enabled: 0,
    alpha_high_ratio: 0.9,
    alpha_low_ratio: 0.1,
    liquid_alpha_enabled: 0,
    alpha_sigmoid_steepness: 10,
    yuma_version: 3,
    subnet_is_active: 1,
    transfers_enabled: 1,
    bonds_reset_enabled: 0,
    user_liquidity_enabled: 0,
    owner_cut_enabled: 1,
    owner_cut_auto_lock_enabled: 1,
    min_childkey_take_ratio: 0,
    block_number: 5_000_000,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

function postSubnetHyperparams(body, { secret, raw } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret !== undefined) headers["x-subnet-hyperparams-sync-token"] = secret;
  return req("/api/v1/internal/subnet-hyperparams-sync", {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body ?? []),
  });
}

test("subnet-hyperparams-sync rejects a missing or wrong token (401)", async () => {
  const wrong = await postSubnetHyperparams([hyperparamsSyncRow()], {
    secret: "wrong",
  });
  expect(wrong.status).toBe(401);
  const missing = await postSubnetHyperparams([hyperparamsSyncRow()]);
  expect(missing.status).toBe(401);
});

test("subnet-hyperparams-sync is disabled (503) when SUBNET_HYPERPARAMS_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/subnet-hyperparams-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-subnet-hyperparams-sync-token": SUBNET_HYPERPARAMS_SYNC_SECRET,
      },
      body: JSON.stringify([hyperparamsSyncRow()]),
    }),
    { HYPERDRIVE: { connectionString: "postgres://mock" } },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("subnet-hyperparams-sync returns 503 when the HYPERDRIVE binding is unavailable", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/subnet-hyperparams-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-subnet-hyperparams-sync-token": SUBNET_HYPERPARAMS_SYNC_SECRET,
      },
      body: JSON.stringify([hyperparamsSyncRow()]),
    }),
    { SUBNET_HYPERPARAMS_SYNC_SECRET },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("subnet-hyperparams-sync rejects a body over the byte cap (413)", async () => {
  const res = await postSubnetHyperparams(null, {
    secret: SUBNET_HYPERPARAMS_SYNC_SECRET,
    raw: "[" + "1".repeat(2_000_000) + "]",
  });
  expect(res.status).toBe(413);
});

test("subnet-hyperparams-sync rejects malformed JSON (400)", async () => {
  const res = await postSubnetHyperparams(null, {
    secret: SUBNET_HYPERPARAMS_SYNC_SECRET,
    raw: "{not json",
  });
  expect(res.status).toBe(400);
});

test("subnet-hyperparams-sync rejects a body that isn't an array or {rows:[...]} (400)", async () => {
  const res = await postSubnetHyperparams(
    { not: "an array" },
    { secret: SUBNET_HYPERPARAMS_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("subnet-hyperparams-sync accepts the {rows:[...]} wrapped form, not just a bare array", async () => {
  const res = await postSubnetHyperparams(
    { rows: [hyperparamsSyncRow()] },
    { secret: SUBNET_HYPERPARAMS_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_hyperparams_written).toBe(1);
});

test("subnet-hyperparams-sync rejects more than the row cap (413)", async () => {
  const many = Array.from({ length: 2001 }, (_, i) =>
    hyperparamsSyncRow({ netuid: i % 65_536 }),
  );
  const res = await postSubnetHyperparams(many, {
    secret: SUBNET_HYPERPARAMS_SYNC_SECRET,
  });
  expect(res.status).toBe(413);
});

test("subnet-hyperparams-sync rejects a row with an out-of-range netuid (400)", async () => {
  const res = await postSubnetHyperparams(
    [hyperparamsSyncRow({ netuid: 70_000 })],
    { secret: SUBNET_HYPERPARAMS_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("subnet-hyperparams-sync rejects a non-object row (400)", async () => {
  const res = await postSubnetHyperparams(["not-an-object"], {
    secret: SUBNET_HYPERPARAMS_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

test("subnet-hyperparams-sync rejects a row carrying an unknown column (400)", async () => {
  const res = await postSubnetHyperparams(
    [hyperparamsSyncRow({ unexpected_field: 1 })],
    { secret: SUBNET_HYPERPARAMS_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("subnet-hyperparams-sync rejects a row with a non-numeric, non-null field (400)", async () => {
  const res = await postSubnetHyperparams(
    [hyperparamsSyncRow({ tempo: "360" })],
    { secret: SUBNET_HYPERPARAMS_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("subnet-hyperparams-sync rejects a row with a numeric field that overflows to Infinity (400)", async () => {
  const { tempo: _tempo, ...rest } = hyperparamsSyncRow();
  const raw = JSON.stringify([rest]).replace(/}\]$/, `,"tempo":1e400}]`);
  const res = await postSubnetHyperparams(null, {
    secret: SUBNET_HYPERPARAMS_SYNC_SECRET,
    raw,
  });
  expect(res.status).toBe(400);
});

test("subnet-hyperparams-sync rejects a row missing a valid captured_at (400)", async () => {
  const res = await postSubnetHyperparams(
    [hyperparamsSyncRow({ captured_at: 0 })],
    { secret: SUBNET_HYPERPARAMS_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("subnet-hyperparams-sync rejects an empty array (400)", async () => {
  const res = await postSubnetHyperparams([], {
    secret: SUBNET_HYPERPARAMS_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

test("subnet-hyperparams-sync upserts subnet_hyperparams and reports written/pruned counts", async () => {
  const res = await postSubnetHyperparams(
    [hyperparamsSyncRow({ netuid: 8 }), hyperparamsSyncRow({ netuid: 9 })],
    { secret: SUBNET_HYPERPARAMS_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, subnet_hyperparams_written: 2 });
  expect(queryText()).toMatch(/INSERT INTO subnet_hyperparams\b/);
  expect(queryText()).toMatch(/DELETE FROM subnet_hyperparams\b/);
});

test("subnet-hyperparams-sync prunes with scalar positional binds, not a bound array", async () => {
  await postSubnetHyperparams(
    [hyperparamsSyncRow({ netuid: 8 }), hyperparamsSyncRow({ netuid: 9 })],
    { secret: SUBNET_HYPERPARAMS_SYNC_SECRET },
  );
  const pruneCall = sqlCalls.find((c) =>
    /DELETE FROM subnet_hyperparams\b/.test(c.text),
  );
  expect(pruneCall.values).toEqual([8, 9]);
  expect(pruneCall.text).toMatch(/\$1::int, \$2::int/);
});

test("subnet-hyperparams-sync coerces 0/1 boolean-flag columns to real booleans", async () => {
  await postSubnetHyperparams(
    [
      hyperparamsSyncRow({
        registration_allowed: 1,
        commit_reveal_enabled: 0,
      }),
    ],
    { secret: SUBNET_HYPERPARAMS_SYNC_SECRET },
  );
  const insert = sqlCalls.find((c) =>
    /INSERT INTO subnet_hyperparams\b/.test(c.text),
  );
  expect(insert.values).toContain(true);
  expect(insert.values).toContain(false);
});

test("subnet-hyperparams-sync defaults a missing optional column to null rather than undefined", async () => {
  const { block_number: _blockNumber, ...withoutBlockNumber } =
    hyperparamsSyncRow();
  const res = await postSubnetHyperparams([withoutBlockNumber], {
    secret: SUBNET_HYPERPARAMS_SYNC_SECRET,
  });
  expect(res.status).toBe(200);
  const insert = sqlCalls.find((c) =>
    /INSERT INTO subnet_hyperparams\b/.test(c.text),
  );
  expect(insert.values).toContain(null);
});

test("subnet-hyperparams-sync reports deregistered_pruned from the DELETE's returned row count", async () => {
  subnetHyperparamsPruneRows.current = [{ netuid: 99 }];
  const res = await postSubnetHyperparams([hyperparamsSyncRow()], {
    secret: SUBNET_HYPERPARAMS_SYNC_SECRET,
  });
  const body = await res.json();
  expect(body.deregistered_pruned).toBe(1);
});

test("subnet-hyperparams-sync appends to subnet_hyperparams_history when the hash changed (cold history)", async () => {
  subnetHyperparamsLatestHashes.current = [];
  const res = await postSubnetHyperparams([hyperparamsSyncRow()], {
    secret: SUBNET_HYPERPARAMS_SYNC_SECRET,
  });
  const body = await res.json();
  expect(body.history_appended).toBe(1);
  expect(queryText()).toMatch(/INSERT INTO subnet_hyperparams_history/);
});

test("subnet-hyperparams-sync skips the history append when the hash is unchanged", async () => {
  const row = hyperparamsSyncRow();
  const hash = await hyperparamsHash(formatSubnetHyperparams(row));
  subnetHyperparamsLatestHashes.current = [
    { netuid: row.netuid, hyperparams_hash: hash },
  ];
  const res = await postSubnetHyperparams([row], {
    secret: SUBNET_HYPERPARAMS_SYNC_SECRET,
  });
  const body = await res.json();
  expect(body.history_appended).toBe(0);
  expect(queryText()).not.toMatch(/INSERT INTO subnet_hyperparams_history/);
});

test("subnet-hyperparams-sync maps a DB failure to a clean 502 instead of throwing", async () => {
  subnetHyperparamsSyncFailure.error = new Error("connection reset");
  const res = await postSubnetHyperparams([hyperparamsSyncRow()], {
    secret: SUBNET_HYPERPARAMS_SYNC_SECRET,
  });
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("write failed");
});

test("GET /api/v1/subnets/:netuid/hyperparameters returns the latest row", async () => {
  mockRows.current = [
    {
      kappa_ratio: 0.5,
      tempo: 360,
      registration_allowed: true,
      commit_reveal_enabled: false,
      liquid_alpha_enabled: false,
      subnet_is_active: true,
      transfers_enabled: true,
      bonds_reset_enabled: false,
      user_liquidity_enabled: false,
      owner_cut_enabled: true,
      owner_cut_auto_lock_enabled: true,
      block_number: "5000000",
      captured_at: "1780000000000",
    },
  ];
  const res = await req("/api/v1/subnets/8/hyperparameters");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.netuid).toBe(8);
  expect(body.hyperparameters.tempo).toBe(360);
  expect(body.hyperparameters.registration_allowed).toBe(true);
});

test("GET /api/v1/subnets/:netuid/hyperparameters on a cold store returns hyperparameters:null", async () => {
  mockRows.current = [];
  const res = await req("/api/v1/subnets/8/hyperparameters");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.hyperparameters).toBeNull();
});

test("GET /api/v1/subnets/:netuid/hyperparameters/history returns the change timeline", async () => {
  mockRows.current = [
    {
      id: "10",
      block_number: "100",
      observed_at: "1780000000000",
      kappa_ratio: 0.5,
      tempo: 360,
      registration_allowed: true,
      commit_reveal_enabled: false,
      liquid_alpha_enabled: false,
      subnet_is_active: true,
      transfers_enabled: true,
      bonds_reset_enabled: false,
      user_liquidity_enabled: false,
      owner_cut_enabled: true,
      owner_cut_auto_lock_enabled: true,
      hyperparams_hash: "abc123",
    },
  ];
  const res = await req("/api/v1/subnets/8/hyperparameters/history");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.entry_count).toBe(1);
  expect(body.entries[0].hyperparams_hash).toBe("abc123");
  expect(body.entries[0].hyperparameters.tempo).toBe(360);
});

test("GET /api/v1/subnets/:netuid/hyperparameters/history uses a cursor seek instead of OFFSET", async () => {
  mockRows.current = [];
  const cursor = encodeCursor([1780000000000, 10]);
  const res = await req(
    `/api/v1/subnets/8/hyperparameters/history?cursor=${cursor}`,
  );
  expect(res.status).toBe(200);
  expect(queryText()).toContain("AND (observed_at, id) <");
  expect(queryText()).not.toContain("OFFSET");
});

test("GET /api/v1/subnets/:netuid/hyperparameters/history?limit=1 emits a next_cursor when the page is full", async () => {
  mockRows.current = [
    {
      id: "10",
      block_number: "100",
      observed_at: "1780000000000",
      hyperparams_hash: "abc123",
    },
  ];
  const res = await req("/api/v1/subnets/8/hyperparameters/history?limit=1");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.next_cursor).not.toBeNull();
});

// #4832 gap-closure: POST /api/v1/internal/account-identity-sync -- the
// write path into account_identity/account_identity_history (see
// workers/data-api.mjs's handleAccountIdentitySync), plus its read paths,
// GET /api/v1/accounts/:ss58/identity[-history]. Unlike subnet-hyperparams-
// sync, this route has NO prune step (see that handler's own comment).
const IDENTITY_SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

function accountIdentitySyncRow(overrides = {}) {
  return {
    account: IDENTITY_SS58,
    name: "Example Team",
    url: "https://miao.example/",
    github: "https://github.com/miao-team/miao-repo",
    image: "https://miao.example/logo.png",
    discord: "examplehandle",
    description: "An example subnet operator.",
    additional: null,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

function postAccountIdentity(body, { secret, raw } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret !== undefined) headers["x-account-identity-sync-token"] = secret;
  return req("/api/v1/internal/account-identity-sync", {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body ?? []),
  });
}

test("account-identity-sync rejects a missing or wrong token (401)", async () => {
  const wrong = await postAccountIdentity([accountIdentitySyncRow()], {
    secret: "wrong",
  });
  expect(wrong.status).toBe(401);
  const missing = await postAccountIdentity([accountIdentitySyncRow()]);
  expect(missing.status).toBe(401);
});

test("account-identity-sync is disabled (503) when ACCOUNT_IDENTITY_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/account-identity-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-account-identity-sync-token": ACCOUNT_IDENTITY_SYNC_SECRET,
      },
      body: JSON.stringify([accountIdentitySyncRow()]),
    }),
    { HYPERDRIVE: { connectionString: "postgres://mock" } },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("account-identity-sync returns 503 when the HYPERDRIVE binding is unavailable", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/account-identity-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-account-identity-sync-token": ACCOUNT_IDENTITY_SYNC_SECRET,
      },
      body: JSON.stringify([accountIdentitySyncRow()]),
    }),
    { ACCOUNT_IDENTITY_SYNC_SECRET },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("account-identity-sync rejects a body over the byte cap (413)", async () => {
  const res = await postAccountIdentity(null, {
    secret: ACCOUNT_IDENTITY_SYNC_SECRET,
    raw: "[" + "1".repeat(5_000_000) + "]",
  });
  expect(res.status).toBe(413);
});

test("account-identity-sync rejects malformed JSON (400)", async () => {
  const res = await postAccountIdentity(null, {
    secret: ACCOUNT_IDENTITY_SYNC_SECRET,
    raw: "{not json",
  });
  expect(res.status).toBe(400);
});

test("account-identity-sync rejects a body that isn't an array or {rows:[...]} (400)", async () => {
  const res = await postAccountIdentity(
    { not: "an array" },
    { secret: ACCOUNT_IDENTITY_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("account-identity-sync accepts the {rows:[...]} wrapped form, not just a bare array", async () => {
  const res = await postAccountIdentity(
    { rows: [accountIdentitySyncRow()] },
    { secret: ACCOUNT_IDENTITY_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.account_identity_written).toBe(1);
});

test("account-identity-sync rejects more than the row cap (413)", async () => {
  // Minimal rows (account + captured_at only, no other fields) so the total
  // body stays well under the byte cap -- otherwise a full accountIdentitySyncRow()
  // fixture repeated 20,001x would trip the byte-cap 413 first and mask
  // whether the row-cap check itself is reachable.
  const many = Array.from({ length: 20_001 }, () => ({
    account: "5X",
    captured_at: 1_780_000_000_000,
  }));
  const res = await postAccountIdentity(many, {
    secret: ACCOUNT_IDENTITY_SYNC_SECRET,
  });
  expect(res.status).toBe(413);
});

test("account-identity-sync rejects a row with a missing/empty account (400)", async () => {
  const res = await postAccountIdentity(
    [accountIdentitySyncRow({ account: "" })],
    { secret: ACCOUNT_IDENTITY_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("account-identity-sync rejects a non-object row (400)", async () => {
  const res = await postAccountIdentity(["not-an-object"], {
    secret: ACCOUNT_IDENTITY_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

test("account-identity-sync rejects a row carrying an unknown column (400)", async () => {
  const res = await postAccountIdentity(
    [accountIdentitySyncRow({ unexpected_field: "nope" })],
    { secret: ACCOUNT_IDENTITY_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("account-identity-sync rejects a row with a numeric identity field (400)", async () => {
  // Unlike subnet-hyperparams-sync, every column but account/captured_at is
  // TEXT-only -- a bare number must be actively rejected here.
  const res = await postAccountIdentity(
    [accountIdentitySyncRow({ name: 123 })],
    { secret: ACCOUNT_IDENTITY_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("account-identity-sync rejects a row with a string field over the byte cap (400)", async () => {
  const res = await postAccountIdentity(
    [accountIdentitySyncRow({ name: "x".repeat(1100) })],
    { secret: ACCOUNT_IDENTITY_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("account-identity-sync rejects a row missing a finite captured_at (400)", async () => {
  const res = await postAccountIdentity(
    [accountIdentitySyncRow({ captured_at: "not-a-number" })],
    { secret: ACCOUNT_IDENTITY_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("account-identity-sync rejects an empty array (400)", async () => {
  const res = await postAccountIdentity([], {
    secret: ACCOUNT_IDENTITY_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

test("account-identity-sync upserts account_identity and reports written counts, no prune", async () => {
  const res = await postAccountIdentity(
    [
      accountIdentitySyncRow({ account: "5Account1" }),
      accountIdentitySyncRow({ account: "5Account2" }),
    ],
    { secret: ACCOUNT_IDENTITY_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, account_identity_written: 2 });
  expect(queryText()).toMatch(/INSERT INTO account_identity\b/);
  expect(queryText()).not.toMatch(/DELETE FROM account_identity/);
});

test("account-identity-sync defaults a missing optional column (e.g. additional) to null rather than undefined", async () => {
  const { additional: _additional, ...withoutAdditional } =
    accountIdentitySyncRow();
  const res = await postAccountIdentity([withoutAdditional], {
    secret: ACCOUNT_IDENTITY_SYNC_SECRET,
  });
  expect(res.status).toBe(200);
  const insert = sqlCalls.find((c) =>
    /INSERT INTO account_identity\b/.test(c.text),
  );
  expect(insert.values).toContain(null);
});

// REGRESSION (live-verified 2026-07-11): a real staged row's discord/
// additional fields were a literal U+0000 placeholder. SQLite tolerates an
// embedded NUL byte in TEXT storage (the D1 path never needed to guard
// against it), but Postgres rejects it outright ("invalid byte sequence for
// encoding UTF8: 0x00"), 502-ing the entire upsert -- confirmed by POSTing
// the real 455-row production envelope directly.
test("account-identity-sync strips embedded NUL bytes from string fields (Postgres TEXT can't store them)", async () => {
  const res = await postAccountIdentity(
    [
      accountIdentitySyncRow({
        discord: "\u0000",
        additional: "before\u0000after",
      }),
    ],
    { secret: ACCOUNT_IDENTITY_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const insert = sqlCalls.find((c) =>
    /INSERT INTO account_identity\b/.test(c.text),
  );
  expect(
    insert.values.some((v) => typeof v === "string" && v.includes("\u0000")),
  ).toBe(false);
  expect(insert.values).toContain("");
  expect(insert.values).toContain("beforeafter");
});

test("account-identity-sync appends to account_identity_history when the hash changed (cold history)", async () => {
  accountIdentityLatestHashes.current = [];
  const res = await postAccountIdentity([accountIdentitySyncRow()], {
    secret: ACCOUNT_IDENTITY_SYNC_SECRET,
  });
  const body = await res.json();
  expect(body.history_appended).toBe(1);
  expect(queryText()).toMatch(/INSERT INTO account_identity_history/);
});

test("account-identity-sync skips the history append when the hash is unchanged", async () => {
  const row = accountIdentitySyncRow();
  const snapshot = {};
  for (const field of IDENTITY_FIELDS) snapshot[field] = row[field] ?? null;
  const hash = await identityHash(snapshot);
  accountIdentityLatestHashes.current = [
    { account: row.account, identity_hash: hash },
  ];
  const res = await postAccountIdentity([row], {
    secret: ACCOUNT_IDENTITY_SYNC_SECRET,
  });
  const body = await res.json();
  expect(body.history_appended).toBe(0);
  expect(queryText()).not.toMatch(/INSERT INTO account_identity_history/);
});

test("account-identity-sync maps a DB failure to a clean 502 instead of throwing", async () => {
  accountIdentitySyncFailure.error = new Error("connection reset");
  const res = await postAccountIdentity([accountIdentitySyncRow()], {
    secret: ACCOUNT_IDENTITY_SYNC_SECRET,
  });
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("write failed");
});

// #2549: POST /api/v1/internal/validator-nominator-counts-sync -- the write
// path into validator_nominator_counts (see workers/data-api.mjs's
// handleValidatorNominatorCountsSync). Simpler than account-identity-sync
// above: latest-only upsert, no history/hash-diff table.
function validatorNominatorCountRow(overrides = {}) {
  return {
    hotkey: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
    nominator_count: 42,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

function postValidatorNominatorCounts(body, { secret, raw } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret !== undefined)
    headers["x-validator-nominator-counts-sync-token"] = secret;
  return req("/api/v1/internal/validator-nominator-counts-sync", {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body ?? []),
  });
}

test("validator-nominator-counts-sync rejects a missing or wrong token (401)", async () => {
  const wrong = await postValidatorNominatorCounts(
    [validatorNominatorCountRow()],
    { secret: "wrong" },
  );
  expect(wrong.status).toBe(401);
  const missing = await postValidatorNominatorCounts([
    validatorNominatorCountRow(),
  ]);
  expect(missing.status).toBe(401);
});

test("validator-nominator-counts-sync is disabled (503) when VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/validator-nominator-counts-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-validator-nominator-counts-sync-token":
          VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET,
      },
      body: JSON.stringify([validatorNominatorCountRow()]),
    }),
    { HYPERDRIVE: { connectionString: "postgres://mock" } },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("validator-nominator-counts-sync returns 503 when the HYPERDRIVE binding is unavailable", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/validator-nominator-counts-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-validator-nominator-counts-sync-token":
          VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET,
      },
      body: JSON.stringify([validatorNominatorCountRow()]),
    }),
    { VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("validator-nominator-counts-sync rejects a body over the byte cap (413)", async () => {
  const res = await postValidatorNominatorCounts(null, {
    secret: VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET,
    raw: "[" + "1".repeat(100_000_001) + "]",
  });
  expect(res.status).toBe(413);
});

test("validator-nominator-counts-sync rejects malformed JSON (400)", async () => {
  const res = await postValidatorNominatorCounts(null, {
    secret: VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET,
    raw: "{not json",
  });
  expect(res.status).toBe(400);
});

test("validator-nominator-counts-sync rejects a body that isn't an array or {rows:[...]} (400)", async () => {
  const res = await postValidatorNominatorCounts(
    { not: "an array" },
    { secret: VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("validator-nominator-counts-sync accepts the {rows:[...]} wrapped form, not just a bare array", async () => {
  const res = await postValidatorNominatorCounts(
    { rows: [validatorNominatorCountRow()] },
    { secret: VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.validator_nominator_counts_written).toBe(1);
});

test("validator-nominator-counts-sync rejects more than the row cap (413)", async () => {
  // MAX_ROWS is 1,000,000 (headroom above the real ~112k-hotkey scan, see
  // migrations/0043_validator_nominator_counts.sql) -- building/serializing
  // a cap+1 array this large routinely exceeds vitest's 5s default, unlike
  // the other sync endpoints' much smaller caps (e.g. account-identity's
  // 20,000), so this one test gets a raised timeout.
  const many = Array.from({ length: 1_000_001 }, (_, i) => ({
    hotkey: `5X${i}`,
    nominator_count: 0,
    captured_at: 1_780_000_000_000,
  }));
  const res = await postValidatorNominatorCounts(many, {
    secret: VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET,
  });
  expect(res.status).toBe(413);
}, 15_000);

test("validator-nominator-counts-sync rejects a row with a missing/empty hotkey (400)", async () => {
  const res = await postValidatorNominatorCounts(
    [validatorNominatorCountRow({ hotkey: "" })],
    { secret: VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("validator-nominator-counts-sync rejects a non-object row (400)", async () => {
  const res = await postValidatorNominatorCounts(["not-an-object"], {
    secret: VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

test("validator-nominator-counts-sync rejects a row carrying an unknown column (400)", async () => {
  const res = await postValidatorNominatorCounts(
    [validatorNominatorCountRow({ unexpected_field: "nope" })],
    { secret: VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("validator-nominator-counts-sync rejects a negative or non-integer nominator_count (400)", async () => {
  const negative = await postValidatorNominatorCounts(
    [validatorNominatorCountRow({ nominator_count: -1 })],
    { secret: VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET },
  );
  expect(negative.status).toBe(400);
  const fractional = await postValidatorNominatorCounts(
    [validatorNominatorCountRow({ nominator_count: 1.5 })],
    { secret: VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET },
  );
  expect(fractional.status).toBe(400);
});

test("validator-nominator-counts-sync rejects a row missing a finite captured_at (400)", async () => {
  const res = await postValidatorNominatorCounts(
    [validatorNominatorCountRow({ captured_at: "not-a-number" })],
    { secret: VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("validator-nominator-counts-sync rejects an empty array (400)", async () => {
  const res = await postValidatorNominatorCounts([], {
    secret: VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

test("validator-nominator-counts-sync writes a batch and reports the count written", async () => {
  const rows = [
    validatorNominatorCountRow({ hotkey: "5Hk1", nominator_count: 5 }),
    validatorNominatorCountRow({ hotkey: "5Hk2", nominator_count: 0 }),
  ];
  const res = await postValidatorNominatorCounts(rows, {
    secret: VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET,
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: true, validator_nominator_counts_written: 2 });
  expect(queryText()).toMatch(/INSERT INTO validator_nominator_counts/);
  expect(queryText()).toMatch(/ON CONFLICT \(hotkey\) DO UPDATE SET/);
});

test("validator-nominator-counts-sync maps a DB failure to a clean 502 instead of throwing", async () => {
  validatorNominatorCountsSyncFailure.error = new Error("connection reset");
  const res = await postValidatorNominatorCounts(
    [validatorNominatorCountRow()],
    { secret: VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET },
  );
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("write failed");
});

// #5352 live incident: a real 112,550-row sync (762,577-row Alpha scan
// output) hit Postgres' hard 65535-bound-parameters-per-statement ceiling
// (112,550 rows x 3 columns = 337,650 params) inside a single INSERT,
// failing every real-world sync at production scale even though every
// smaller test above passed. batchedUpsert (workers/data-api.mjs) splits
// into VALIDATOR_NOMINATOR_COUNTS_MAX_ROWS_PER_BATCH-sized statements inside
// one sql.begin() transaction -- this proves more than one INSERT actually
// gets issued for a payload over that threshold, not just that the response
// still reports the right total.
test("validator-nominator-counts-sync splits a payload over the per-statement param cap into multiple INSERT statements (#5352)", async () => {
  const MAX_ROWS_PER_BATCH = 20_000; // must match workers/data-api.mjs's own constant
  const rows = Array.from({ length: MAX_ROWS_PER_BATCH + 1 }, (_, i) =>
    validatorNominatorCountRow({ hotkey: `5Hk${i}`, nominator_count: i }),
  );
  const res = await postValidatorNominatorCounts(rows, {
    secret: VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET,
  });
  expect(res.status).toBe(200);
  expect((await res.json()).validator_nominator_counts_written).toBe(
    rows.length,
  );
  const insertCalls = sqlCalls.filter((call) =>
    call.text.includes("INSERT INTO validator_nominator_counts"),
  );
  expect(insertCalls.length).toBe(2);
});

test("validator-nominator-counts-sync issues a single INSERT for a payload at or under the per-statement batch size", async () => {
  const rows = [
    validatorNominatorCountRow({ hotkey: "5Hk1" }),
    validatorNominatorCountRow({ hotkey: "5Hk2" }),
  ];
  const res = await postValidatorNominatorCounts(rows, {
    secret: VALIDATOR_NOMINATOR_COUNTS_SYNC_SECRET,
  });
  expect(res.status).toBe(200);
  const insertCalls = sqlCalls.filter((call) =>
    call.text.includes("INSERT INTO validator_nominator_counts"),
  );
  expect(insertCalls.length).toBe(1);
});

// #5233: POST /api/v1/internal/nominator-positions-sync -- the write path
// into nominator_positions (see workers/data-api.mjs's
// handleNominatorPositionsSync). Same latest-only-upsert shape as
// validator-nominator-counts-sync above, just a wider composite key.
function nominatorPositionRow(overrides = {}) {
  return {
    coldkey: "5Cold1",
    hotkey: "5Hk1",
    netuid: 3,
    share_fraction: 0.25,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

function postNominatorPositions(body, { secret, raw } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret !== undefined)
    headers["x-nominator-positions-sync-token"] = secret;
  return req("/api/v1/internal/nominator-positions-sync", {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body ?? []),
  });
}

test("nominator-positions-sync rejects a missing or wrong token (401)", async () => {
  const wrong = await postNominatorPositions([nominatorPositionRow()], {
    secret: "nope",
  });
  expect(wrong.status).toBe(401);
  const missing = await postNominatorPositions([nominatorPositionRow()]);
  expect(missing.status).toBe(401);
});

test("nominator-positions-sync is disabled (503) when NOMINATOR_POSITIONS_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/nominator-positions-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nominator-positions-sync-token": NOMINATOR_POSITIONS_SYNC_SECRET,
      },
      body: JSON.stringify([nominatorPositionRow()]),
    }),
    { ...env, NOMINATOR_POSITIONS_SYNC_SECRET: undefined },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("nominator-positions-sync returns 503 when the HYPERDRIVE binding is unavailable", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/nominator-positions-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nominator-positions-sync-token": NOMINATOR_POSITIONS_SYNC_SECRET,
      },
      body: JSON.stringify([nominatorPositionRow()]),
    }),
    { ...env, HYPERDRIVE: undefined },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("nominator-positions-sync rejects malformed JSON (400)", async () => {
  const res = await postNominatorPositions(null, {
    secret: NOMINATOR_POSITIONS_SYNC_SECRET,
    raw: "{not json",
  });
  expect(res.status).toBe(400);
});

test("nominator-positions-sync rejects a body that isn't an array (400)", async () => {
  const res = await postNominatorPositions(null, {
    secret: NOMINATOR_POSITIONS_SYNC_SECRET,
    raw: JSON.stringify({ nope: true }),
  });
  expect(res.status).toBe(400);
});

test("nominator-positions-sync rejects an empty array (400)", async () => {
  const res = await postNominatorPositions([], {
    secret: NOMINATOR_POSITIONS_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

test("nominator-positions-sync rejects a row missing a required field or carrying an unknown key (400)", async () => {
  const missingColdkey = await postNominatorPositions(
    [nominatorPositionRow({ coldkey: "" })],
    { secret: NOMINATOR_POSITIONS_SYNC_SECRET },
  );
  expect(missingColdkey.status).toBe(400);

  const negativeFraction = await postNominatorPositions(
    [nominatorPositionRow({ share_fraction: -0.1 })],
    { secret: NOMINATOR_POSITIONS_SYNC_SECRET },
  );
  expect(negativeFraction.status).toBe(400);

  const unknownKey = await postNominatorPositions(
    [{ ...nominatorPositionRow(), extra: 1 }],
    { secret: NOMINATOR_POSITIONS_SYNC_SECRET },
  );
  expect(unknownKey.status).toBe(400);
});

test("nominator-positions-sync accepts the wrapped {rows:[...]} form and upserts on (coldkey, hotkey, netuid)", async () => {
  const res = await postNominatorPositions(
    { rows: [nominatorPositionRow()] },
    { secret: NOMINATOR_POSITIONS_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: true, nominator_positions_written: 1 });
  expect(queryText()).toMatch(/INSERT INTO nominator_positions/);
  expect(queryText()).toMatch(/ON CONFLICT \(coldkey, hotkey, netuid\)/);
});

test("nominator-positions-sync maps a DB failure to a clean 502 instead of throwing", async () => {
  nominatorPositionsSyncFailure.error = new Error("connection reset");
  const res = await postNominatorPositions([nominatorPositionRow()], {
    secret: NOMINATOR_POSITIONS_SYNC_SECRET,
  });
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("write failed");
});

// #5352 live incident (same root cause as validator-nominator-counts-sync's
// own batching test above): a real 132,505-row sync hit Postgres' 65535
// bound-parameters-per-statement ceiling even harder here (5 columns vs 3 --
// 132,505 x 5 = 662,525 params). batchedUpsert applies identically; this
// proves nominator-positions-sync actually issues multiple INSERT
// statements for a payload over its own (smaller, 5-column) batch size.
test("nominator-positions-sync splits a payload over the per-statement param cap into multiple INSERT statements (#5352)", async () => {
  const MAX_ROWS_PER_BATCH = 10_000; // must match workers/data-api.mjs's own constant
  const rows = Array.from({ length: MAX_ROWS_PER_BATCH + 1 }, (_, i) =>
    nominatorPositionRow({ hotkey: `5Hk${i}`, netuid: i % 128 }),
  );
  const res = await postNominatorPositions(rows, {
    secret: NOMINATOR_POSITIONS_SYNC_SECRET,
  });
  expect(res.status).toBe(200);
  expect((await res.json()).nominator_positions_written).toBe(rows.length);
  const insertCalls = sqlCalls.filter((call) =>
    call.text.includes("INSERT INTO nominator_positions"),
  );
  expect(insertCalls.length).toBe(2);
});

test("nominator-positions-sync issues a single INSERT for a payload at or under the per-statement batch size", async () => {
  const rows = [
    nominatorPositionRow({ hotkey: "5Hk1" }),
    nominatorPositionRow({ hotkey: "5Hk2" }),
  ];
  const res = await postNominatorPositions(rows, {
    secret: NOMINATOR_POSITIONS_SYNC_SECRET,
  });
  expect(res.status).toBe(200);
  const insertCalls = sqlCalls.filter((call) =>
    call.text.includes("INSERT INTO nominator_positions"),
  );
  expect(insertCalls.length).toBe(1);
});

// #6742: POST /api/v1/internal/account-balances-sync -- the write path into
// account_balances (see workers/data-api.mjs's handleAccountBalancesSync).
// Same latest-only-upsert shape as nominator-positions-sync above, a
// single-column key instead of a composite one.
function accountBalanceRow(overrides = {}) {
  return {
    ss58: "5Whale1",
    free_tao: 1000.5,
    reserved_tao: 25.25,
    captured_at: 1_780_000_000_000,
    ...overrides,
  };
}

function postAccountBalances(body, { secret, raw } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret !== undefined) headers["x-account-balances-sync-token"] = secret;
  return req("/api/v1/internal/account-balances-sync", {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body ?? []),
  });
}

test("account-balances-sync rejects a missing or wrong token (401)", async () => {
  const wrong = await postAccountBalances([accountBalanceRow()], {
    secret: "nope",
  });
  expect(wrong.status).toBe(401);
  const missing = await postAccountBalances([accountBalanceRow()]);
  expect(missing.status).toBe(401);
});

test("account-balances-sync is disabled (503) when ACCOUNT_BALANCES_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/account-balances-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-account-balances-sync-token": ACCOUNT_BALANCES_SYNC_SECRET,
      },
      body: JSON.stringify([accountBalanceRow()]),
    }),
    { ...env, ACCOUNT_BALANCES_SYNC_SECRET: undefined },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("account-balances-sync returns 503 when the HYPERDRIVE binding is unavailable", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/account-balances-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-account-balances-sync-token": ACCOUNT_BALANCES_SYNC_SECRET,
      },
      body: JSON.stringify([accountBalanceRow()]),
    }),
    { ...env, HYPERDRIVE: undefined },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("account-balances-sync rejects malformed JSON (400)", async () => {
  const res = await postAccountBalances(null, {
    secret: ACCOUNT_BALANCES_SYNC_SECRET,
    raw: "{not json",
  });
  expect(res.status).toBe(400);
});

test("account-balances-sync rejects a body that isn't an array (400)", async () => {
  const res = await postAccountBalances(null, {
    secret: ACCOUNT_BALANCES_SYNC_SECRET,
    raw: JSON.stringify({ nope: true }),
  });
  expect(res.status).toBe(400);
});

test("account-balances-sync rejects an empty array (400)", async () => {
  const res = await postAccountBalances([], {
    secret: ACCOUNT_BALANCES_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

test("account-balances-sync rejects a body over the byte cap (413)", async () => {
  const res = await postAccountBalances(null, {
    secret: ACCOUNT_BALANCES_SYNC_SECRET,
    raw: "[" + "1".repeat(200_000_001) + "]",
  });
  expect(res.status).toBe(413);
});

test("account-balances-sync rejects more rows than the per-request cap (413)", async () => {
  const rows = Array.from({ length: 1_000_001 }, (_, i) =>
    accountBalanceRow({ ss58: `5Whale${i}` }),
  );
  const res = await postAccountBalances(rows, {
    secret: ACCOUNT_BALANCES_SYNC_SECRET,
  });
  expect(res.status).toBe(413);
});

test("account-balances-sync rejects a non-object/array row (400)", async () => {
  const nullRow = await postAccountBalances(null, {
    secret: ACCOUNT_BALANCES_SYNC_SECRET,
    raw: JSON.stringify([null]),
  });
  expect(nullRow.status).toBe(400);

  const arrayRow = await postAccountBalances(null, {
    secret: ACCOUNT_BALANCES_SYNC_SECRET,
    raw: JSON.stringify([["not", "an", "object"]]),
  });
  expect(arrayRow.status).toBe(400);
});

test("account-balances-sync rejects a row missing a required field or carrying an unknown key (400)", async () => {
  const missingSs58 = await postAccountBalances(
    [accountBalanceRow({ ss58: "" })],
    { secret: ACCOUNT_BALANCES_SYNC_SECRET },
  );
  expect(missingSs58.status).toBe(400);

  const negativeFree = await postAccountBalances(
    [accountBalanceRow({ free_tao: -1 })],
    { secret: ACCOUNT_BALANCES_SYNC_SECRET },
  );
  expect(negativeFree.status).toBe(400);

  const negativeReserved = await postAccountBalances(
    [accountBalanceRow({ reserved_tao: -1 })],
    { secret: ACCOUNT_BALANCES_SYNC_SECRET },
  );
  expect(negativeReserved.status).toBe(400);

  const badCapturedAt = await postAccountBalances(
    [accountBalanceRow({ captured_at: "not-a-number" })],
    { secret: ACCOUNT_BALANCES_SYNC_SECRET },
  );
  expect(badCapturedAt.status).toBe(400);

  const unknownKey = await postAccountBalances(
    [{ ...accountBalanceRow(), extra: 1 }],
    { secret: ACCOUNT_BALANCES_SYNC_SECRET },
  );
  expect(unknownKey.status).toBe(400);
});

test("account-balances-sync accepts the wrapped {rows:[...]} form and upserts on ss58", async () => {
  const res = await postAccountBalances(
    { rows: [accountBalanceRow()] },
    { secret: ACCOUNT_BALANCES_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: true, account_balances_written: 1 });
  expect(queryText()).toMatch(/INSERT INTO account_balances/);
  expect(queryText()).toMatch(/ON CONFLICT \(ss58\)/);
});

test("account-balances-sync maps a DB failure to a clean 502 instead of throwing", async () => {
  accountBalancesSyncFailure.error = new Error("connection reset");
  const res = await postAccountBalances([accountBalanceRow()], {
    secret: ACCOUNT_BALANCES_SYNC_SECRET,
  });
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("write failed");
});

test("account-balances-sync splits a payload over the per-statement param cap into multiple INSERT statements", async () => {
  const MAX_ROWS_PER_BATCH = 10_000; // must match workers/data-api.mjs's own constant
  const rows = Array.from({ length: MAX_ROWS_PER_BATCH + 1 }, (_, i) =>
    accountBalanceRow({ ss58: `5Whale${i}` }),
  );
  const res = await postAccountBalances(rows, {
    secret: ACCOUNT_BALANCES_SYNC_SECRET,
  });
  expect(res.status).toBe(200);
  expect((await res.json()).account_balances_written).toBe(rows.length);
  const insertCalls = sqlCalls.filter((call) =>
    call.text.includes("INSERT INTO account_balances"),
  );
  expect(insertCalls.length).toBe(2);
});

test("account-balances-sync issues a single INSERT for a payload at or under the per-statement batch size", async () => {
  const rows = [
    accountBalanceRow({ ss58: "5Whale1" }),
    accountBalanceRow({ ss58: "5Whale2" }),
  ];
  const res = await postAccountBalances(rows, {
    secret: ACCOUNT_BALANCES_SYNC_SECRET,
  });
  expect(res.status).toBe(200);
  const insertCalls = sqlCalls.filter((call) =>
    call.text.includes("INSERT INTO account_balances"),
  );
  expect(insertCalls.length).toBe(1);
});

test("GET /api/v1/accounts/:ss58/positions joins share_fraction against live neurons stake_tao (#5233)", async () => {
  // loadNominatorPositions is a plain tagged-template call -- consumes
  // mockQueue. loadNeuronStakeByHotkeys goes through sql.unsafe (an IN-list
  // query), which this mock always answers from mockRows.current regardless
  // of mockQueue (see the sql.unsafe branch's own fallback), so the two rows
  // are primed separately rather than both queued.
  mockQueue.current = [
    [], // sql.begin's leading `SET statement_timeout`
    [
      {
        coldkey: "5Cold1",
        hotkey: "5Hk1",
        netuid: 3,
        share_fraction: 0.25,
        captured_at: "1780000000000",
      },
    ], // loadNominatorPositions
  ];
  mockRows.current = [{ hotkey: "5Hk1", netuid: 3, stake_tao: "1000" }]; // loadNeuronStakeByHotkeys
  const res = await req("/api/v1/accounts/5Cold1/positions");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(queryText()).toMatch(/FROM nominator_positions WHERE coldkey/);
  expect(queryText()).toMatch(/FROM neurons WHERE hotkey IN/);
  expect(body.ss58).toBe("5Cold1");
  expect(body.position_count).toBe(1);
  expect(body.positions[0].stake_tao).toBe(250);
  expect(body.total_stake_tao).toBe(250);
});

test("GET /api/v1/accounts/:ss58/positions returns an empty card for a coldkey with no positions", async () => {
  mockQueue.current = [
    [], // sql.begin's leading `SET statement_timeout`
    [], // loadNominatorPositions -- no rows, so distinctHotkeys is empty and loadNeuronStakeByHotkeys short-circuits without a query
  ];
  const res = await req("/api/v1/accounts/5NoPositions/positions");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.position_count).toBe(0);
  expect(body.total_stake_tao).toBe(0);
  expect(body.positions).toEqual([]);
});

test("GET /api/v1/accounts/:ss58/positions still serves an empty card when the nominator_positions read fails", async () => {
  nominatorPositionsQueryFailure.error = new Error(
    'relation "nominator_positions" does not exist',
  );
  const res = await req("/api/v1/accounts/5Cold1/positions");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.position_count).toBe(0);
  expect(body.positions).toEqual([]);
});

test("GET /api/v1/accounts/:ss58/positions still serves a card (with zeroed stake) when the neurons stake-by-hotkey join fails (#6769)", async () => {
  // nominator_positions succeeds with a real hotkey, so loadNeuronStakeByHotkeys
  // actually runs (an empty hotkeys array short-circuits before ever issuing
  // this query -- see the "no positions" test above).
  mockQueue.current = [
    [], // sql.begin's leading `SET statement_timeout`
    [
      {
        coldkey: "5Cold1",
        hotkey: "5Hk1",
        netuid: 3,
        share_fraction: 0.25,
        captured_at: "1780000000000",
      },
    ], // loadNominatorPositions
  ];
  neuronStakeByHotkeyQueryFailure.error = new Error("connection reset");
  const res = await req("/api/v1/accounts/5Cold1/positions");
  expect(res.status).toBe(200);
  const body = await res.json();
  // buildAccountPositions drops any position it can't resolve a stake_tao
  // for (src/account-nominator-positions.mjs: `if (hotkeyStake == null)
  // continue;`) rather than fabricating a zero -- the join failing for
  // every hotkey degrades to the same empty card the "no positions" and
  // "nominator_positions read fails" tests above assert, just reached via
  // the OTHER query in this route failing instead.
  expect(body.position_count).toBe(0);
  expect(body.positions).toEqual([]);
  expect(body.total_stake_tao).toBe(0);
});

test("GET /api/v1/accounts/:ss58/identity returns the latest row", async () => {
  mockRows.current = [
    {
      account: IDENTITY_SS58,
      name: "Example Team",
      url: "https://miao.example/",
      github: null,
      image: null,
      discord: null,
      description: null,
      additional: null,
      captured_at: "1780000000000",
    },
  ];
  const res = await req(`/api/v1/accounts/${IDENTITY_SS58}/identity`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.has_identity).toBe(true);
  expect(body.name).toBe("Example Team");
});

test("GET /api/v1/accounts/:ss58/identity on a cold store returns has_identity:false", async () => {
  mockRows.current = [];
  const res = await req(`/api/v1/accounts/${IDENTITY_SS58}/identity`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.has_identity).toBe(false);
});

test("GET /api/v1/accounts/:ss58/identity-history returns the change timeline", async () => {
  mockRows.current = [
    {
      id: "10",
      observed_at: "1780000000000",
      name: "Example Team",
      url: null,
      github: null,
      image: null,
      discord: null,
      description: null,
      additional: null,
      identity_hash: "abc123",
    },
  ];
  const res = await req(`/api/v1/accounts/${IDENTITY_SS58}/identity-history`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.entry_count).toBe(1);
  expect(body.entries[0].identity_hash).toBe("abc123");
  expect(body.entries[0].name).toBe("Example Team");
});

test("GET /api/v1/accounts/:ss58/identity-history uses a cursor seek instead of OFFSET", async () => {
  mockRows.current = [];
  const cursor = encodeCursor([1780000000000, 10]);
  const res = await req(
    `/api/v1/accounts/${IDENTITY_SS58}/identity-history?cursor=${cursor}`,
  );
  expect(res.status).toBe(200);
  expect(queryText()).toContain("AND (observed_at, id) <");
  expect(queryText()).not.toContain("OFFSET");
});

test("GET /api/v1/accounts/:ss58/identity-history?limit=1 emits a next_cursor when the page is full", async () => {
  mockRows.current = [
    {
      id: "10",
      observed_at: "1780000000000",
      identity_hash: "abc123",
    },
  ];
  const res = await req(
    `/api/v1/accounts/${IDENTITY_SS58}/identity-history?limit=1`,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.next_cursor).not.toBeNull();
});

const SUBNET_IDENTITY_NETUID = 8;

function subnetIdentityProfile(overrides = {}) {
  return {
    netuid: SUBNET_IDENTITY_NETUID,
    symbol: "MIAO",
    native_identity: {
      subnet_name: "Miao Subnet",
      description: "An example subnet operator.",
      github_url: "https://github.com/miao-team/miao-repo",
      website_url: "https://miao.example/",
      discord: "examplehandle",
      logo_url: "https://miao.example/logo.png",
    },
    ...overrides,
  };
}

function postSubnetIdentity(body, { secret, raw } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret !== undefined) headers["x-subnet-identity-sync-token"] = secret;
  return req("/api/v1/internal/subnet-identity-sync", {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body ?? []),
  });
}

test("subnet-identity-sync rejects a missing or wrong token (401)", async () => {
  const wrong = await postSubnetIdentity([subnetIdentityProfile()], {
    secret: "wrong",
  });
  expect(wrong.status).toBe(401);
  const missing = await postSubnetIdentity([subnetIdentityProfile()]);
  expect(missing.status).toBe(401);
});

test("subnet-identity-sync is disabled (503) when SUBNET_IDENTITY_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/subnet-identity-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-subnet-identity-sync-token": SUBNET_IDENTITY_SYNC_SECRET,
      },
      body: JSON.stringify([subnetIdentityProfile()]),
    }),
    { HYPERDRIVE: { connectionString: "postgres://mock" } },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("subnet-identity-sync returns 503 when the HYPERDRIVE binding is unavailable", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/subnet-identity-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-subnet-identity-sync-token": SUBNET_IDENTITY_SYNC_SECRET,
      },
      body: JSON.stringify([subnetIdentityProfile()]),
    }),
    { SUBNET_IDENTITY_SYNC_SECRET },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("subnet-identity-sync rejects a body over the byte cap (413)", async () => {
  const res = await postSubnetIdentity(null, {
    secret: SUBNET_IDENTITY_SYNC_SECRET,
    raw: "[" + "1".repeat(5_000_000) + "]",
  });
  expect(res.status).toBe(413);
});

test("subnet-identity-sync rejects malformed JSON (400)", async () => {
  const res = await postSubnetIdentity(null, {
    secret: SUBNET_IDENTITY_SYNC_SECRET,
    raw: "{not json",
  });
  expect(res.status).toBe(400);
});

test("subnet-identity-sync rejects a body that isn't an array or {profiles:[...]} (400)", async () => {
  const res = await postSubnetIdentity(
    { not: "an array" },
    { secret: SUBNET_IDENTITY_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("subnet-identity-sync accepts the {profiles:[...]} wrapped form, not just a bare array", async () => {
  const res = await postSubnetIdentity(
    { profiles: [subnetIdentityProfile()] },
    { secret: SUBNET_IDENTITY_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.history_appended).toBe(1);
});

test("subnet-identity-sync rejects more than the row cap (413)", async () => {
  const many = Array.from({ length: 2_001 }, (_, i) => ({ netuid: i }));
  const res = await postSubnetIdentity(many, {
    secret: SUBNET_IDENTITY_SYNC_SECRET,
  });
  expect(res.status).toBe(413);
});

test("subnet-identity-sync rejects an empty array (400)", async () => {
  const res = await postSubnetIdentity([], {
    secret: SUBNET_IDENTITY_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

test("subnet-identity-sync silently skips a profile with a non-integer netuid, no error", async () => {
  const res = await postSubnetIdentity(
    [subnetIdentityProfile({ netuid: "not-a-number" })],
    { secret: SUBNET_IDENTITY_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.history_appended).toBe(0);
});

test("subnet-identity-sync silently skips a profile with no native_identity, no error", async () => {
  // No dedicated per-field row validator here (unlike subnet-hyperparams-sync
  // and account-identity-sync) -- profiles.json is the same trust boundary
  // D1's own recordSubnetIdentityChanges reads directly, and
  // identitySnapshotFromProfile's own null-guard already skips a malformed
  // profile without erroring the batch.
  const res = await postSubnetIdentity(
    [subnetIdentityProfile({ native_identity: undefined })],
    { secret: SUBNET_IDENTITY_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.history_appended).toBe(0);
});

test("subnet-identity-sync appends to subnet_identity_history when the hash changed (cold history)", async () => {
  subnetIdentityLatestHashes.current = [];
  const res = await postSubnetIdentity([subnetIdentityProfile()], {
    secret: SUBNET_IDENTITY_SYNC_SECRET,
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, history_appended: 1 });
  expect(queryText()).toMatch(/INSERT INTO subnet_identity_history\b/);
});

test("subnet-identity-sync strips embedded NUL bytes before inserting Postgres TEXT", async () => {
  const res = await postSubnetIdentity(
    [
      subnetIdentityProfile({
        symbol: "MI\u0000AO",
        native_identity: {
          ...subnetIdentityProfile().native_identity,
          subnet_name: "Miao\u0000 Subnet",
          description: "An example\u0000 subnet operator.",
        },
      }),
    ],
    { secret: SUBNET_IDENTITY_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const insert = sqlCalls.find((c) =>
    /INSERT INTO subnet_identity_history\b/.test(c.text),
  );
  expect(
    insert.values.some((v) => typeof v === "string" && v.includes("\u0000")),
  ).toBe(false);
  expect(insert.values).toContain("MIAO");
  expect(insert.values).toContain("Miao Subnet");
  expect(insert.values).toContain("An example subnet operator.");
});

test("subnet-identity-sync skips the history append when the hash is unchanged", async () => {
  const profile = subnetIdentityProfile();
  const snapshot = identitySnapshotFromProfile(profile);
  const hash = await subnetIdentityHash(snapshot);
  subnetIdentityLatestHashes.current = [
    { netuid: profile.netuid, identity_hash: hash },
  ];
  const res = await postSubnetIdentity([profile], {
    secret: SUBNET_IDENTITY_SYNC_SECRET,
  });
  const body = await res.json();
  expect(body.history_appended).toBe(0);
  expect(queryText()).not.toMatch(/INSERT INTO subnet_identity_history\b/);
});

test("subnet-identity-sync resolves block_number from MAX(block_number), null when blocks is empty", async () => {
  subnetIdentityLatestHashes.current = [];
  mockRows.current = [];
  const res = await postSubnetIdentity([subnetIdentityProfile()], {
    secret: SUBNET_IDENTITY_SYNC_SECRET,
  });
  expect(res.status).toBe(200);
  const insert = sqlCalls.find((c) =>
    /INSERT INTO subnet_identity_history\b/.test(c.text),
  );
  expect(insert.values).toContain(null);
});

test("subnet-identity-sync maps a DB failure to a clean 502 instead of throwing", async () => {
  subnetIdentitySyncFailure.error = new Error("connection reset");
  const res = await postSubnetIdentity([subnetIdentityProfile()], {
    secret: SUBNET_IDENTITY_SYNC_SECRET,
  });
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("write failed");
});

// #4832 gap-closure: health-checks-sync -- best-effort Postgres mirror of
// src/health-prober.mjs's D1+KV write, called from the main Worker's own
// 15-minute cron (syncHealthChecksToPostgres), not an external workflow.
function probedRow(overrides = {}) {
  return {
    surface_id: "sn-1-example-api",
    surface_key: "srf-abc123",
    netuid: 1,
    kind: "subnet-api",
    provider: "example",
    url: "https://example.com/api",
    status: "ok",
    classification: "healthy",
    latency_ms: 120,
    status_code: 200,
    checked_at_ms: 1780000000000,
    last_ok_ms: 1780000000000,
    consecutive_failures: 0,
    ...overrides,
  };
}

function postHealthChecks(body, { secret, raw } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret !== undefined) headers["x-health-checks-sync-token"] = secret;
  return req("/api/v1/internal/health-checks-sync", {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body ?? { probed: [] }),
  });
}

test("health-checks-sync rejects a missing or wrong token (401)", async () => {
  const wrong = await postHealthChecks(
    { probed: [probedRow()] },
    { secret: "wrong" },
  );
  expect(wrong.status).toBe(401);
  const missing = await postHealthChecks({ probed: [probedRow()] });
  expect(missing.status).toBe(401);
});

test("health-checks-sync is disabled (503) when HEALTH_CHECKS_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/health-checks-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-health-checks-sync-token": HEALTH_CHECKS_SYNC_SECRET,
      },
      body: JSON.stringify({ probed: [probedRow()] }),
    }),
    { HYPERDRIVE: { connectionString: "postgres://mock" } },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("health-checks-sync returns 503 when the HYPERDRIVE binding is unavailable", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/health-checks-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-health-checks-sync-token": HEALTH_CHECKS_SYNC_SECRET,
      },
      body: JSON.stringify({ probed: [probedRow()] }),
    }),
    { HEALTH_CHECKS_SYNC_SECRET },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("health-checks-sync rejects a body over the byte cap (413)", async () => {
  const res = await postHealthChecks(null, {
    secret: HEALTH_CHECKS_SYNC_SECRET,
    raw: '{"probed":[' + "1".repeat(2_000_000) + "]}",
  });
  expect(res.status).toBe(413);
});

test("health-checks-sync rejects malformed JSON (400)", async () => {
  const res = await postHealthChecks(null, {
    secret: HEALTH_CHECKS_SYNC_SECRET,
    raw: "{not json",
  });
  expect(res.status).toBe(400);
});

test("health-checks-sync rejects a body without a probed array (400)", async () => {
  const res = await postHealthChecks(
    { not: "the right shape" },
    { secret: HEALTH_CHECKS_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("health-checks-sync rejects more than the row cap (413)", async () => {
  const many = Array.from({ length: 2_001 }, () => probedRow());
  const res = await postHealthChecks(
    { probed: many },
    { secret: HEALTH_CHECKS_SYNC_SECRET },
  );
  expect(res.status).toBe(413);
});

test("health-checks-sync on an empty probed array is a clean no-op (200)", async () => {
  const res = await postHealthChecks(
    { probed: [] },
    { secret: HEALTH_CHECKS_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: true, checks_written: 0, status_written: 0 });
});

test("health-checks-sync silently skips a row missing a required field, no error", async () => {
  const res = await postHealthChecks(
    { probed: [probedRow({ netuid: "not-a-number" })] },
    { secret: HEALTH_CHECKS_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: true, checks_written: 0, status_written: 0 });
});

test("health-checks-sync bulk-inserts surface_checks and upserts surface_status", async () => {
  const res = await postHealthChecks(
    { probed: [probedRow(), probedRow({ surface_id: "sn-2-other-api" })] },
    { secret: HEALTH_CHECKS_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({
    ok: true,
    checks_written: 2,
    status_written: 2,
  });
  expect(queryText()).toMatch(/INSERT INTO surface_checks\b/);
  expect(queryText()).toMatch(
    /INSERT INTO surface_status\b[\s\S]*ON CONFLICT \(surface_id\) DO UPDATE/,
  );
});

test("health-checks-sync defaults every optional field to null/0 when absent", async () => {
  const minimal = {
    surface_id: "sn-3-minimal",
    netuid: 3,
    kind: "subnet-api",
    status: "failed",
    checked_at_ms: 1780000000000,
    // surface_key, classification, latency_ms, status_code, url, provider,
    // last_ok_ms, consecutive_failures all intentionally absent.
  };
  const res = await postHealthChecks(
    { probed: [minimal] },
    { secret: HEALTH_CHECKS_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: true, checks_written: 1, status_written: 1 });
  const statusInsert = sqlCalls.find((c) =>
    /INSERT INTO surface_status\b/.test(c.text),
  );
  expect(statusInsert.values).toContain(0); // consecutive_failures default
});

test("health-checks-sync maps a DB failure to a clean 502 instead of throwing", async () => {
  healthChecksSyncFailure.error = new Error("connection reset");
  const res = await postHealthChecks(
    { probed: [probedRow()] },
    { secret: HEALTH_CHECKS_SYNC_SECRET },
  );
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("write failed");
});

// #4832 gap-closure: health-uptime-rollup-sync -- best-effort Postgres
// mirror of rollupDailyUptime, reusing HEALTH_CHECKS_SYNC_SECRET (same
// conceptual sync boundary, not a separate secret). Unlike health-checks-
// sync, the body carries only UTC day boundaries; Postgres computes its own
// rollup from its own surface_checks via PERCENTILE_CONT.
function dayBounds(date, start, end) {
  return { date, start, end };
}

function postHealthUptimeRollup(body, { secret, raw } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret !== undefined) headers["x-health-checks-sync-token"] = secret;
  return req("/api/v1/internal/health-uptime-rollup-sync", {
    method: "POST",
    headers,
    body:
      raw !== undefined
        ? raw
        : JSON.stringify(body ?? { days: [], updated_at: 1 }),
  });
}

test("health-uptime-rollup-sync rejects a missing or wrong token (401)", async () => {
  const wrong = await postHealthUptimeRollup(
    { days: [dayBounds("2026-07-11", 1, 2)], updated_at: 1 },
    { secret: "wrong" },
  );
  expect(wrong.status).toBe(401);
  const missing = await postHealthUptimeRollup({
    days: [dayBounds("2026-07-11", 1, 2)],
    updated_at: 1,
  });
  expect(missing.status).toBe(401);
});

test("health-uptime-rollup-sync is disabled (503) when HEALTH_CHECKS_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/health-uptime-rollup-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-health-checks-sync-token": HEALTH_CHECKS_SYNC_SECRET,
      },
      body: JSON.stringify({
        days: [dayBounds("2026-07-11", 1, 2)],
        updated_at: 1,
      }),
    }),
    { HYPERDRIVE: { connectionString: "postgres://mock" } },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("health-uptime-rollup-sync returns 503 when the HYPERDRIVE binding is unavailable", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/health-uptime-rollup-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-health-checks-sync-token": HEALTH_CHECKS_SYNC_SECRET,
      },
      body: JSON.stringify({
        days: [dayBounds("2026-07-11", 1, 2)],
        updated_at: 1,
      }),
    }),
    { HEALTH_CHECKS_SYNC_SECRET },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("health-uptime-rollup-sync rejects malformed JSON (400)", async () => {
  const res = await postHealthUptimeRollup(null, {
    secret: HEALTH_CHECKS_SYNC_SECRET,
    raw: "{not json",
  });
  expect(res.status).toBe(400);
});

test("health-uptime-rollup-sync rejects a body missing days or updated_at (400)", async () => {
  const noDays = await postHealthUptimeRollup(
    { updated_at: 1 },
    { secret: HEALTH_CHECKS_SYNC_SECRET },
  );
  expect(noDays.status).toBe(400);
  const noUpdatedAt = await postHealthUptimeRollup(
    { days: [dayBounds("2026-07-11", 1, 2)] },
    { secret: HEALTH_CHECKS_SYNC_SECRET },
  );
  expect(noUpdatedAt.status).toBe(400);
});

test("health-uptime-rollup-sync rejects more than the day cap (413)", async () => {
  const many = Array.from({ length: 11 }, (_, i) =>
    dayBounds(`2026-07-${String(i + 1).padStart(2, "0")}`, i, i + 1),
  );
  const res = await postHealthUptimeRollup(
    { days: many, updated_at: 1 },
    { secret: HEALTH_CHECKS_SYNC_SECRET },
  );
  expect(res.status).toBe(413);
});

test("health-uptime-rollup-sync silently skips a malformed day entry, no error", async () => {
  const res = await postHealthUptimeRollup(
    { days: [{ date: "not-a-date", start: 1, end: 2 }], updated_at: 1 },
    { secret: HEALTH_CHECKS_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: true, days_rolled: [] });
});

test("health-uptime-rollup-sync rolls up each valid day via PERCENTILE_CONT", async () => {
  const res = await postHealthUptimeRollup(
    {
      days: [
        dayBounds("2026-07-11", 1780000000000, 1780086400000),
        dayBounds("2026-07-10", 1779913600000, 1780000000000),
      ],
      updated_at: 1780086400000,
    },
    { secret: HEALTH_CHECKS_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: true, days_rolled: ["2026-07-11", "2026-07-10"] });
  expect(queryText()).toMatch(/INSERT INTO surface_uptime_daily\b/);
  expect(queryText()).toMatch(/PERCENTILE_CONT\(0\.5\)/);
  expect(queryText()).toMatch(/ON CONFLICT \(surface_id, day\) DO UPDATE/);
});

test("health-uptime-rollup-sync maps a DB failure to a clean 502 instead of throwing", async () => {
  healthUptimeRollupSyncFailure.error = new Error("connection reset");
  const res = await postHealthUptimeRollup(
    { days: [dayBounds("2026-07-11", 1, 2)], updated_at: 1 },
    { secret: HEALTH_CHECKS_SYNC_SECRET },
  );
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("write failed");
});

test("GET /api/v1/subnets/:netuid/identity-history returns the change timeline", async () => {
  mockRows.current = [
    {
      id: "10",
      block_number: "100",
      observed_at: "1780000000000",
      subnet_name: "Miao Subnet",
      symbol: "MIAO",
      description: "old",
      github_repo: null,
      subnet_url: null,
      discord: null,
      logo_url: null,
      identity_hash: "abc123",
    },
  ];
  const res = await req(
    `/api/v1/subnets/${SUBNET_IDENTITY_NETUID}/identity-history`,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.entry_count).toBe(1);
  expect(body.entries[0].identity_hash).toBe("abc123");
  expect(body.entries[0].subnet_name).toBe("Miao Subnet");
});

test("GET /api/v1/subnets/:netuid/identity-history uses a cursor seek instead of OFFSET", async () => {
  mockRows.current = [];
  const cursor = encodeCursor([1780000000000, 10]);
  const res = await req(
    `/api/v1/subnets/${SUBNET_IDENTITY_NETUID}/identity-history?cursor=${cursor}`,
  );
  expect(res.status).toBe(200);
  expect(queryText()).toContain("AND (observed_at, id) <");
  expect(queryText()).not.toContain("OFFSET");
});

test("GET /api/v1/subnets/:netuid/identity-history?limit=1 emits a next_cursor when the page is full", async () => {
  mockRows.current = [
    {
      id: "10",
      observed_at: "1780000000000",
      identity_hash: "abc123",
    },
  ];
  const res = await req(
    `/api/v1/subnets/${SUBNET_IDENTITY_NETUID}/identity-history?limit=1`,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.next_cursor).not.toBeNull();
});

// #4832 Tier 2: the 12 chain-wide account_events analytics routes
// (mirroring src/chain-*.mjs's D1 loaders). These reuse the ALREADY-flipped
// METAGRAPH_ACCOUNT_EVENTS_SOURCE flag (no new table/secret), so entities.mjs
// -- err, analytics.mjs's -- own tryPostgresTier wiring is tested at the
// handler layer (tests/chain-*.test.mjs); these exercise the actual SQL/
// shaping in workers/data-api.mjs itself, including the cold-store guard
// branch each "network + subnet" route shares.

test("GET /api/v1/chain/weights: warm store runs both the network + subnet queries", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [{ weight_sets: 3, distinct_setters: 2, newest_observed: "1780000000000" }],
    [{ netuid: 1, weight_sets: 3, distinct_setters: 2 }],
  ];
  const res = await req("/api/v1/chain/weights?window=7d&limit=5");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(1);
});

test("GET /api/v1/chain/weights: cold store skips the subnet query", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [], // empty network row -- networkRows[0] ?? null falls back to null
  ];
  const res = await req("/api/v1/chain/weights");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(0);
});

test("GET /api/v1/chain/weights/setters: runs the leaderboard + totals queries", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [
      {
        hotkey: "5Pg",
        uid: null,
        weight_sets: 2,
        first_set: "1",
        last_set: "2",
      },
    ],
    [{ weight_sets: 2, distinct_setters: 1, newest_observed: "1780000000000" }],
  ];
  const res = await req("/api/v1/chain/weights/setters?window=30d");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.setter_count).toBe(1);
});

test("GET /api/v1/chain/weights/setters: an empty totals row falls back to null", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [],
    [],
  ];
  const res = await req("/api/v1/chain/weights/setters");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.setter_count).toBe(0);
});

test("GET /api/v1/chain/serving: warm store runs both queries", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [{ distinct_servers: 1, newest_observed: "1780000000000" }],
    [{ netuid: 1, announcements: 1, distinct_servers: 1 }],
  ];
  const res = await req("/api/v1/chain/serving");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(1);
});

test("GET /api/v1/chain/serving: cold store skips the subnet query", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [],
  ];
  const res = await req("/api/v1/chain/serving");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(0);
});

test("GET /api/v1/chain/prometheus: warm store runs both queries", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [{ distinct_exporters: 1, newest_observed: "1780000000000" }],
    [{ netuid: 1, announcements: 1, distinct_exporters: 1 }],
  ];
  const res = await req("/api/v1/chain/prometheus");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(1);
});

test("GET /api/v1/chain/prometheus: cold store skips the subnet query", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [],
  ];
  const res = await req("/api/v1/chain/prometheus");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(0);
});

test("GET /api/v1/chain/axon-removals: warm store runs both queries", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [{ distinct_removers: 1, newest_observed: "1780000000000" }],
    [{ netuid: 1, removals: 1, distinct_removers: 1 }],
  ];
  const res = await req("/api/v1/chain/axon-removals");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(1);
});

test("GET /api/v1/chain/axon-removals: cold store skips the subnet query", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [],
  ];
  const res = await req("/api/v1/chain/axon-removals");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(0);
});

test("GET /api/v1/chain/registrations: warm store runs both queries", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [{ distinct_registrants: 1, newest_observed: "1780000000000" }],
    [{ netuid: 1, registrations: 1, distinct_registrants: 1 }],
  ];
  const res = await req("/api/v1/chain/registrations");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(1);
});

test("GET /api/v1/chain/registrations: cold store skips the subnet query", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [],
  ];
  const res = await req("/api/v1/chain/registrations");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(0);
});

test("GET /api/v1/chain/deregistrations: warm store runs both queries", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [{ distinct_deregistered_hotkeys: 1, newest_observed: "1780000000000" }],
    [{ netuid: 1, deregistrations: 1, distinct_deregistered_hotkeys: 1 }],
  ];
  const res = await req("/api/v1/chain/deregistrations");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(1);
});

test("GET /api/v1/chain/deregistrations: cold store skips the subnet query", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [],
  ];
  const res = await req("/api/v1/chain/deregistrations");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(0);
});

test("GET /api/v1/chain/stake-moves: warm store runs both queries", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [{ distinct_movers: 1, newest_observed: "1780000000000" }],
    [{ netuid: 1, movements: 1, distinct_movers: 1 }],
  ];
  const res = await req("/api/v1/chain/stake-moves");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(1);
});

test("GET /api/v1/chain/stake-moves: cold store skips the subnet query", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [],
  ];
  const res = await req("/api/v1/chain/stake-moves");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(0);
});

test("GET /api/v1/chain/stake-transfers: warm store runs both queries", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [{ distinct_senders: 1, newest_observed: "1780000000000" }],
    [{ netuid: 1, transfers: 1, distinct_senders: 1 }],
  ];
  const res = await req("/api/v1/chain/stake-transfers");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(1);
});

test("GET /api/v1/chain/stake-transfers: cold store skips the subnet query", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [],
  ];
  const res = await req("/api/v1/chain/stake-transfers");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(0);
});

test("GET /api/v1/chain/stake-flow: a single GROUP BY netuid, event_kind query", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [
      {
        netuid: 1,
        event_kind: "StakeAdded",
        total_tao: 10,
        event_count: 2,
        last_observed: "1780000000000",
      },
      {
        netuid: 1,
        event_kind: "StakeRemoved",
        total_tao: 4,
        event_count: 1,
        last_observed: "1780000000000",
      },
    ],
  ];
  const res = await req("/api/v1/chain/stake-flow?window=30d&limit=10");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(1);
});

test("GET /api/v1/chain/alpha-volume: a single GROUP BY netuid, event_kind query", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [
      {
        netuid: 1,
        event_kind: "StakeAdded",
        alpha_volume: 10,
        tao_volume: 20,
        event_count: 2,
        last_observed: "1780000000000",
      },
      {
        netuid: 1,
        event_kind: "StakeRemoved",
        alpha_volume: 4,
        tao_volume: 8,
        event_count: 1,
        last_observed: "1780000000000",
      },
    ],
  ];
  const res = await req("/api/v1/chain/alpha-volume?limit=10");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window).toBe("24h");
  expect(body.subnet_count).toBe(1);
  expect(body.subnets[0].buy_volume_alpha).toBe(10);
  expect(body.subnets[0].sell_volume_alpha).toBe(4);
  expect(body.subnets[0].vol_mcap_ratio).toBeNull(); // no per-subnet market cap at network scope
  expect(queryText()).toContain("event_kind IN (");
});

test("GET /api/v1/chain/alpha-volume: cold store returns the zeroed leaderboard", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [],
  ];
  const res = await req("/api/v1/chain/alpha-volume");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.subnet_count).toBe(0);
  expect(body.subnets).toEqual([]);
  expect(body.volume_distribution).toBeNull();
});

test("GET /api/v1/chain/transfers: totals + distinct counts + senders + receivers", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    // `SET LOCAL statement_timeout` widening this route's own budget (the
    // dual COUNT(DISTINCT) statements below are the slowest queries in this
    // file against the real, high-volume 'Transfer' event_kind -- confirmed
    // live 2026-07-11) -- also consumes a queue slot.
    [],
    [
      {
        transfer_count: 3,
        total_volume_tao: 100,
        newest_observed: "1780000000000",
      },
    ],
    [{ unique_senders: 2 }],
    [{ unique_receivers: 2 }],
    [{ address: "5Sender", volume_tao: 80, transfer_count: 2 }],
    [{ address: "5Receiver", volume_tao: 60, transfer_count: 1 }],
  ];
  const res = await req("/api/v1/chain/transfers?window=7d&limit=5");
  expect(res.status).toBe(200);
  expect(sqlBeginOptions).toContain(
    "isolation level repeatable read read only",
  );
  const body = await res.json();
  expect(body.total_volume_tao).toBe(100);
  expect(body.unique_senders).toBe(2);
  expect(body.unique_receivers).toBe(2);
  expect(body.top_senders[0].address).toBe("5Sender");
});

test("GET /api/v1/chain/transfers caps direct Data API limits at 100", async () => {
  mockQueue.current = [
    [],
    [],
    [{ transfer_count: 0, total_volume_tao: 0, newest_observed: null }],
    [{ unique_senders: 0 }],
    [{ unique_receivers: 0 }],
    [],
    [],
  ];
  const res = await req("/api/v1/chain/transfers?limit=1000000000");
  expect(res.status).toBe(200);
  expect(
    sqlCalls
      .filter((call) => /LIMIT \?$/.test(call.text.trim()))
      .map((call) => call.values.at(-1)),
  ).toEqual([100, 100]);
});

test("GET /api/v1/chain/transfers: a cold store's empty totals row falls back to null", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [], // `SET LOCAL statement_timeout`
    [],
    [],
    [],
    [],
    [],
  ];
  const res = await req("/api/v1/chain/transfers");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.total_volume_tao).toBe(0);
});

test("GET /api/v1/chain/transfer-pairs: default (volume) sort", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [
      {
        transfer_count: 3,
        total_volume_tao: 100,
        unique_pairs: 1,
        top_pair_volume_tao: 80,
        newest_observed: "1780000000000",
      },
    ],
    // `orderBy` is itself built via a bare `sql\`...\`` fragment (not
    // awaited on its own) before being interpolated into the pairRows
    // query below -- the mock's sql() shifts a queue slot per call
    // regardless, so this dummy slot stands in for that construction.
    [],
    [
      {
        from_address: "5Sa",
        to_address: "5Rx",
        volume_tao: 80,
        transfer_count: 2,
        last_block: "100",
        last_observed_at: "1780000000000",
      },
    ],
  ];
  const res = await req("/api/v1/chain/transfer-pairs?window=7d&limit=5");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.sort).toBe("volume");
  expect(body.pairs[0].from).toBe("5Sa");
  expect(queryText()).toContain("volume_tao DESC, transfer_count DESC");
});

test("GET /api/v1/chain/transfer-pairs caps direct Data API limits at 100", async () => {
  mockQueue.current = [
    [],
    [
      {
        transfer_count: 0,
        total_volume_tao: 0,
        unique_pairs: 0,
        top_pair_volume_tao: 0,
        newest_observed: null,
      },
    ],
    [],
    [],
  ];
  const res = await req("/api/v1/chain/transfer-pairs?limit=1000000000");
  expect(res.status).toBe(200);
  const leaderboard = sqlCalls.find((call) =>
    /GROUP BY hotkey, "coldkey" ORDER BY/.test(call.text),
  );
  expect(leaderboard?.values.at(-1)).toBe(100);
});

test("GET /api/v1/chain/transfer-pairs?sort=count uses the count ordering", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [
      {
        transfer_count: 3,
        total_volume_tao: 100,
        unique_pairs: 1,
        top_pair_volume_tao: 80,
        newest_observed: "1780000000000",
      },
    ],
    [], // the `orderBy` fragment construction -- see the comment above
    [],
  ];
  const res = await req("/api/v1/chain/transfer-pairs?sort=count");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.sort).toBe("count");
  expect(queryText()).toContain("transfer_count DESC, volume_tao DESC");
});

test("GET /api/v1/chain/transfer-pairs: an empty totals row falls back to null", async () => {
  mockQueue.current = [
    [], // consumed by the session-scoped `SET statement_timeout` call
    [], // empty totals row -- totalsRows[0] ?? null falls back to null
    [], // the `orderBy` fragment construction
    [],
  ];
  const res = await req("/api/v1/chain/transfer-pairs");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.total_volume_tao).toBe(0);
});

// #4832 gap-closure: chain-wide identity-change feed, mirroring
// src/chain-identity-history.mjs's loadChainIdentityHistory -- no netuid
// filter, single query, reusing METAGRAPH_SUBNET_IDENTITY_SOURCE (same
// table as the per-subnet identity-history route already tested above).
test("GET /api/v1/chain/identity-history returns the network-wide feed", async () => {
  mockRows.current = [
    {
      id: "10",
      netuid: 7,
      block_number: "100",
      observed_at: "1780000000000",
      subnet_name: "Alpha",
      symbol: "α",
      description: "old",
      github_repo: null,
      subnet_url: null,
      discord: null,
      logo_url: null,
      identity_hash: "abc",
    },
  ];
  const res = await req("/api/v1/chain/identity-history?limit=10");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.count).toBe(1);
  expect(body.changes[0].netuid).toBe(7);
});

test("GET /api/v1/chain/identity-history rejects oversized direct data-worker limits", async () => {
  const res = await req("/api/v1/chain/identity-history?limit=1000000000");
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      parameter: "limit",
      message: "limit must be an integer between 1 and 200.",
    },
  });
  expect(queryText()).not.toMatch(/FROM subnet_identity_history/);
});

test("GET /api/v1/chain/identity-history on a cold store returns a schema-stable empty feed", async () => {
  mockRows.current = [];
  const res = await req("/api/v1/chain/identity-history");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.count).toBe(0);
  expect(body.subnet_count).toBe(0);
  expect(body.changes).toEqual([]);
});

// #4832 gap-closure: extrinsics/blocks-derived cluster (handleChainActivity/
// Calls/Signers/Fees), the last D1-only routes among the "network-wide chain
// analytics" family. All 4 reuse METAGRAPH_EXTRINSICS_SOURCE (already
// "postgres" -- see wrangler.jsonc), the same flag Tier 1a's blocks/
// extrinsics routes already serve from. Live-verified via psql before
// writing this SQL (2026-07-11): the plain aggregates run well under 500ms
// at current volume (~1.2M extrinsics/7d), but COUNT(DISTINCT signer) and
// PERCENTILE_CONT median queries cost ~2.5-2.9s -- a thin margin under the
// 3s default -- so chain/activity and chain/fees widen their own budget via
// SET LOCAL, mirroring chain/transfers' fix (#4869).

test("GET /api/v1/chain/signers: default sort + no call_module filter", async () => {
  mockQueue.current = [
    [], // session-scoped SET statement_timeout
    [], // moduleClause construction (call_module absent -> sql``)
    [], // orderBy construction (sort=tx_count -> sql`tx_count`)
    [{ newest_observed: "1780000000000" }],
    [
      {
        signer: "5Signer",
        tx_count: 10,
        total_fee_tao: 1,
        total_tip_tao: 0.1,
        last_tx_block: 500,
      },
    ],
  ];
  const res = await req("/api/v1/chain/signers?window=7d");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.sort).toBe("tx_count");
  expect(body.signers[0].signer).toBe("5Signer");
});

test("GET /api/v1/chain/signers: sort=total_fee_tao + call_module scopes the query", async () => {
  mockQueue.current = [
    [],
    [], // moduleClause (call_module present -> real fragment)
    [], // orderBy (sort=total_fee_tao -> sql`total_fee_tao`)
    [{ newest_observed: "1780000000000" }],
    [
      {
        signer: "5Signer",
        tx_count: 5,
        total_fee_tao: 9,
        total_tip_tao: 0,
        last_tx_block: 400,
      },
    ],
  ];
  const res = await req(
    "/api/v1/chain/signers?window=7d&sort=total_fee_tao&call_module=SubtensorModule",
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.sort).toBe("total_fee_tao");
  expect(queryText()).toContain("call_module = ");
});

test("GET /api/v1/chain/calls: default group_by=module, no call_module", async () => {
  mockQueue.current = [
    [], // session SET
    [], // moduleClause (absent)
    [], // orderBy (module branch)
    [{ newest_observed: "1780000000000" }],
    [{ call_module: "SubtensorModule", count: 10 }],
    [{ total: 12 }],
  ];
  const res = await req("/api/v1/chain/calls?window=7d");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.group_by).toBe("module");
  expect(body.total_extrinsics).toBe(12);
  expect(body.calls[0].call_module).toBe("SubtensorModule");
});

test("GET /api/v1/chain/calls: group_by=module_function + call_module filter", async () => {
  mockQueue.current = [
    [],
    [], // moduleClause (present)
    [], // orderBy (module_function branch)
    [{ newest_observed: "1780000000000" }],
    [
      {
        call_module: "SubtensorModule",
        call_function: "set_weights",
        count: 4,
      },
    ],
    [{ total: 4 }],
  ];
  const res = await req(
    "/api/v1/chain/calls?window=7d&group_by=module_function&call_module=SubtensorModule",
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.group_by).toBe("module_function");
  expect(body.calls[0].call_function).toBe("set_weights");
});

test("GET /api/v1/chain/calls: an empty totals row falls back to 0", async () => {
  mockQueue.current = [
    [], // session SET
    [], // moduleClause (absent)
    [], // orderBy (module branch)
    [{ newest_observed: "1780000000000" }],
    [],
    [], // empty totalRows -- totalRows[0]?.total ?? 0 falls back to 0
  ];
  const res = await req("/api/v1/chain/calls?window=7d");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.total_extrinsics).toBe(0);
});

test("GET /api/v1/chain/activity: merges the extrinsics + blocks day series, defaulting a signer-less day to 0", async () => {
  mockQueue.current = [
    [], // session SET
    [], // SET LOCAL statement_timeout widen
    [
      { day: "2026-07-10", extrinsic_count: 10, successful_extrinsics: 9 },
      { day: "2026-07-09", extrinsic_count: 5, successful_extrinsics: 5 },
    ],
    // Only one of the two days appears here -- proves the
    // `signersByDay.get(r.day) ?? 0` fallback for the missing day.
    [{ day: "2026-07-10", unique_signers: 3 }],
    [{ day: "2026-07-10", block_count: 2, event_count: 8 }],
    [{ newest_observed: "1780000000000" }],
  ];
  const res = await req("/api/v1/chain/activity?window=7d");
  expect(res.status).toBe(200);
  const body = await res.json();
  const day10 = body.days.find((d) => d.day === "2026-07-10");
  const day09 = body.days.find((d) => d.day === "2026-07-09");
  expect(day10.unique_signers).toBe(3);
  expect(day09.unique_signers).toBe(0);
  expect(day10.block_count).toBe(2);
});

test("GET /api/v1/chain/fees: default window, no call_module", async () => {
  mockQueue.current = [
    [], // session SET
    [], // moduleClause (absent)
    [], // SET LOCAL statement_timeout widen
    [
      {
        day: "2026-07-10",
        extrinsic_count: 10,
        total_fee_tao: 1,
        total_tip_tao: 0.1,
      },
    ],
    [
      {
        signer: "5Payer",
        total_fee_tao: 1,
        total_tip_tao: 0.1,
        extrinsic_count: 10,
      },
    ],
    [{ day: "2026-07-10", median_fee_tao: 0.1, median_tip_tao: 0.01 }],
    [{ newest_observed: "1780000000000" }],
  ];
  const res = await req("/api/v1/chain/fees?window=7d");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.daily[0].median_fee_tao).toBe(0.1);
  expect(body.top_fee_payers[0].signer).toBe("5Payer");
});

test("GET /api/v1/chain/fees: call_module filter reuses the same moduleClause across all 3 queries", async () => {
  mockQueue.current = [
    [],
    [], // moduleClause (present)
    [],
    [
      {
        day: "2026-07-10",
        extrinsic_count: 4,
        total_fee_tao: 2,
        total_tip_tao: 0,
      },
    ],
    [
      {
        signer: "5Payer",
        total_fee_tao: 2,
        total_tip_tao: 0,
        extrinsic_count: 4,
      },
    ],
    [{ day: "2026-07-10", median_fee_tao: 0.5, median_tip_tao: 0 }],
    [{ newest_observed: "1780000000000" }],
  ];
  const res = await req(
    "/api/v1/chain/fees?window=7d&call_module=SubtensorModule",
  );
  expect(res.status).toBe(200);
  expect(queryText()).toContain("call_module = ");
});

// #4832 gap-closure: health-tracking read routes. All 5 read from
// surface_checks/surface_uptime_daily -- populated by the health-checks-sync
// / health-uptime-rollup-sync write routes -- and are gated behind the
// deliberately-unflipped METAGRAPH_HEALTH_SOURCE flag (see
// handleBulkHealthTrends' own header comment in
// workers/request-handlers/analytics.mjs), so these tests only prove the
// SQL/routing wiring, matching every other route's test style regardless.

test("GET /api/v1/health/trends: aggregates surface_uptime_daily into 7d/30d windows", async () => {
  // A date comfortably inside the real 7d window at whenever this test
  // actually runs -- a hardcoded date rots the moment real wall-clock time
  // carries it outside handleHealthTrends' own Date.now()-relative window
  // filter (confirmed live: this test started failing once "now" passed
  // 2026-07-17, 7 days after the previously-hardcoded 2026-07-10 fixture).
  const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  mockQueue.current = [
    [], // session-scoped SET statement_timeout
    [
      {
        netuid: 7,
        date: recentDate,
        total: 100,
        ok_count: 98,
        latency_samples: 96,
        avg_latency_ms: 120,
      },
    ],
    [{ newest_observed: "1780000000000" }],
  ];
  const res = await req("/api/v1/health/trends");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.windows["7d"].subnets[0].netuid).toBe(7);
});

test("GET /api/v1/health/trends on a cold store returns a schema-stable empty matrix", async () => {
  mockQueue.current = [[], [], []];
  const res = await req("/api/v1/health/trends");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.windows["7d"].subnet_count).toBe(0);
});

test("GET /api/v1/subnets/:netuid/health/trends: merges the 7d+30d PERCENTILE_CONT windows", async () => {
  mockQueue.current = [
    [],
    [
      {
        surface_id: "sn-7-api",
        total: 10,
        ok_count: 9,
        latency_samples: 9,
        avg_latency_ms: 100,
        p50: 90,
        p95: 150,
        p99: 180,
      },
    ],
    [
      {
        surface_id: "sn-7-api",
        total: 40,
        ok_count: 38,
        latency_samples: 38,
        avg_latency_ms: 105,
        p50: 92,
        p95: 155,
        p99: 190,
      },
    ],
    [{ newest_observed: "1780000000000" }],
  ];
  const res = await req("/api/v1/subnets/7/health/trends");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.netuid).toBe(7);
  expect(body.windows["7d"].surfaces[0].surface_id).toBe("sn-7-api");
  expect(body.windows["30d"].surfaces[0].samples).toBe(40);
});

test("GET /api/v1/subnets/:netuid/health/percentiles: p50/p95/p99 via PERCENTILE_CONT", async () => {
  mockQueue.current = [
    [],
    [
      {
        surface_id: "sn-7-api",
        latency_samples: 20,
        avg_latency_ms: 110,
        min_latency_ms: 40,
        max_latency_ms: 300,
        p50: 100,
        p95: 200,
        p99: 280,
      },
    ],
    [{ newest_observed: "1780000000000" }],
  ];
  const res = await req("/api/v1/subnets/7/health/percentiles?window=7d");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.surfaces[0].latency_ms.p99).toBe(280);
});

test("GET /api/v1/subnets/:netuid/health/percentiles on a cold store returns surfaces:[]", async () => {
  mockQueue.current = [[], [], []];
  const res = await req("/api/v1/subnets/7/health/percentiles");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.surfaces).toEqual([]);
});

test("GET /api/v1/subnets/:netuid/health/incidents: SLA rollup + gap-island incidents", async () => {
  mockQueue.current = [
    [],
    [
      {
        surface_id: "sn-7-api",
        surface_key: "stable-sn-7-api",
        total: 100,
        ok_count: 92,
      },
    ],
    [
      {
        surface_id: "sn-7-api",
        surface_key: "stable-sn-7-api",
        started_at: "1780000000000",
        ended_at: "1780000600000",
        failed_samples: 3,
      },
    ],
    [{ newest_observed: "1780000600000" }],
  ];
  const res = await req("/api/v1/subnets/7/health/incidents?window=7d");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.surfaces[0].incident_count).toBe(1);
  expect(body.surfaces[0].incidents[0].failed_samples).toBe(3);
});

test("GET /api/v1/subnets/:netuid/health/incidents on a cold store returns surfaces:[]", async () => {
  mockQueue.current = [[], [], [], []];
  const res = await req("/api/v1/subnets/7/health/incidents");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.surfaces).toEqual([]);
});

test("GET /api/v1/incidents: global gap-island ledger across every subnet", async () => {
  mockQueue.current = [
    [],
    [
      {
        netuid: 7,
        surface_id: "sn-7-api",
        surface_key: "sn-7-api",
        started_at: "1780000000000",
        ended_at: "1780000600000",
        failed_samples: 2,
      },
    ],
    [{ newest_observed: "1780000600000" }],
  ];
  const res = await req("/api/v1/incidents?window=7d");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.surfaces[0].netuid).toBe(7);
  expect(body.summary.incident_count).toBe(1);
});

test("GET /api/v1/incidents on a cold store returns a schema-stable empty ledger", async () => {
  mockQueue.current = [[], [], []];
  const res = await req("/api/v1/incidents");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.summary.incident_count).toBe(0);
  expect(body.surfaces).toEqual([]);
});

test("GET /api/v1/subnets/:netuid/uptime: aggregates surface_uptime_daily by day", async () => {
  mockQueue.current = [
    [], // session-scoped SET statement_timeout
    [], // havingClause construction (min_samples absent -> sql``)
    [
      {
        surface_id: "sn-7-api",
        surface_key: "sn-7-api",
        day: "2026-06-01",
        samples: 10,
        ok_count: 9,
        uptime_ratio: 0.9,
        latency_samples: 10,
        avg_latency_ms: 120,
        p50: 100,
        p95: 200,
        p99: 250,
        status: "degraded",
      },
    ],
    [{ newest_observed: "1780000600000" }],
  ];
  const res = await req("/api/v1/subnets/7/uptime?window=1y");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window).toBe("1y");
  expect(body.surfaces[0].surface_id).toBe("sn-7-api");
  expect(body.surfaces[0].days[0].uptime_ratio).toBe(0.9);
});

test("GET /api/v1/subnets/:netuid/uptime: min_samples adds a HAVING clause", async () => {
  mockQueue.current = [
    [],
    [], // havingClause construction (min_samples present -> real fragment)
    [],
    [{ newest_observed: null }],
  ];
  const res = await req("/api/v1/subnets/7/uptime?min_samples=5");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.surfaces).toEqual([]);
});

test("GET /api/v1/subnets/:netuid/uptime: malformed min_samples degrades to no filter instead of NaN", async () => {
  mockQueue.current = [
    [],
    [], // havingClause construction (min_samples unparseable -> sql``, same as absent)
    [],
    [{ newest_observed: null }],
  ];
  const res = await req("/api/v1/subnets/7/uptime?min_samples=abc");
  expect(res.status).toBe(200);
  const boundValues = sqlCalls.flatMap((call) => call.values);
  expect(
    boundValues.some((v) => typeof v === "number" && Number.isNaN(v)),
  ).toBe(false);
});

test("GET /api/v1/subnets/:netuid/uptime on a cold store returns surfaces:[]", async () => {
  mockQueue.current = [[], [], [], []];
  const res = await req("/api/v1/subnets/7/uptime");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.surfaces).toEqual([]);
});

test("GET /api/v1/subnets/:netuid/uptime: unrecognized window falls back to 90d", async () => {
  mockQueue.current = [[], [], [], []];
  const res = await req("/api/v1/subnets/7/uptime?window=bogus");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window).toBe("90d");
});

test("GET /api/v1/internal/compare-health: aggregates surface_status by netuid", async () => {
  mockRows.current = [
    { netuid: 7, surface_count: 3, ok_count: 2, avg_latency_ms: 120 },
  ];
  const res = await req("/api/v1/internal/compare-health?netuids=7,64");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.rows).toEqual(mockRows.current);
});

test("GET /api/v1/internal/compare-health: no netuids returns rows:[] without querying", async () => {
  const res = await req("/api/v1/internal/compare-health");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.rows).toEqual([]);
});

test("GET /api/v1/internal/subnet-identity-aliases: aggregates subnet_name by netuid", async () => {
  mockRows.current = [
    { netuid: 7, subnet_name: "Old Allways", observed_at: 2 },
  ];
  const res = await req(
    "/api/v1/internal/subnet-identity-aliases?netuids=7,64",
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.rows).toEqual(mockRows.current);
});

test("GET /api/v1/internal/subnet-identity-aliases: no netuids returns rows:[] without querying", async () => {
  const res = await req("/api/v1/internal/subnet-identity-aliases");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.rows).toEqual([]);
});

// D1 retirement (2026-07-16, item 5 of the D1->Postgres cleanup):
// src/health-serving.mjs's resolveLiveHealth KV-cold fallback.
test("GET /api/v1/internal/health-status-live: coerces BIGINT epoch-ms columns to numbers", async () => {
  // postgres.js returns BIGINT columns as strings (see numberOrNull's own
  // header comment) -- this route must coerce them before returning JSON, or
  // the consumer's Number.isFinite/isInteger checks (written for D1's native
  // numbers) would silently null them out.
  mockRows.current = [
    {
      surface_id: "7:subnet-api:x",
      surface_key: "srf-pglive0000000",
      netuid: 7,
      kind: "subnet-api",
      provider: "x",
      url: "https://x",
      status: "ok",
      classification: "up",
      latency_ms: "12",
      status_code: "200",
      last_checked: "1700000000000",
      last_ok: "1700000000000",
    },
  ];
  const res = await req(
    "/api/v1/internal/health-status-live?since=1699999999999",
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.rows).toEqual([
    {
      surface_id: "7:subnet-api:x",
      surface_key: "srf-pglive0000000",
      netuid: 7,
      kind: "subnet-api",
      provider: "x",
      url: "https://x",
      status: "ok",
      classification: "up",
      latency_ms: 12,
      status_code: 200,
      last_checked: 1700000000000,
      last_ok: 1700000000000,
    },
  ]);
});

test("GET /api/v1/internal/health-status-live: a missing/non-finite since returns rows:[] without querying", async () => {
  const res = await req("/api/v1/internal/health-status-live");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.rows).toEqual([]);
});

// D1 retirement (2026-07-16, item 10 of the D1->Postgres cleanup):
// src/subnet-identity-history.mjs's latestBlockNumber.
test("GET /api/v1/internal/latest-block-number: returns the coerced MAX(block_number)", async () => {
  mockRows.current = [{ block_number: "8404076" }];
  const res = await req("/api/v1/internal/latest-block-number");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ block_number: 8404076 });
});

test("GET /api/v1/internal/latest-block-number: returns block_number:null on an empty blocks table", async () => {
  mockRows.current = [{ block_number: null }];
  const res = await req("/api/v1/internal/latest-block-number");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ block_number: null });
});

test("GET /api/v1/subnets/:netuid/trajectory: formats daily snapshot rows", async () => {
  mockRows.current = [
    {
      snapshot_date: "2026-06-01",
      completeness_score: 90,
      surface_count: 5,
      endpoint_count: 5,
      validator_count: 8,
      miner_count: 60,
      total_stake_tao: 90,
      alpha_price_tao: 0.01,
      emission_share: 0.02,
      tao_in_pool_tao: 26707.57,
      alpha_in_pool: 2956464.98,
      alpha_out_pool: 2257199.02,
      subnet_volume_tao: 798027.45,
    },
  ];
  const res = await req("/api/v1/subnets/7/trajectory");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.netuid).toBe(7);
  expect(body.points[0].date).toBe("2026-06-01");
  expect(body.points[0].completeness_score).toBe(90);
  // #2552: pool liquidity + volume flow through the Postgres trajectory path.
  expect(body.points[0].tao_in_pool_tao).toBe(26707.57);
  expect(body.points[0].alpha_in_pool).toBe(2956464.98);
  expect(body.points[0].alpha_out_pool).toBe(2257199.02);
  expect(body.points[0].subnet_volume_tao).toBe(798027.45);
});

test("GET /api/v1/economics/trends: aggregates daily rows network-wide", async () => {
  mockRows.current = [
    {
      snapshot_date: "2026-06-01",
      total_stake_tao: 300,
      alpha_price_tao: 0.02,
      validator_count: 8,
      miner_count: 50,
      emission_share: 0.04,
    },
  ];
  const res = await req("/api/v1/economics/trends?window=30d");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window).toBe("30d");
  expect(body.day_count).toBe(1);
  expect(body.days[0].snapshot_date).toBe("2026-06-01");
});

test("GET /api/v1/economics/alpha-price-history: returns bulk daily prices (#7227)", async () => {
  mockRows.current = [
    { netuid: 1, snapshot_date: "2026-07-01", alpha_price_tao: "0.25" },
    { netuid: 1, snapshot_date: "2026-07-10", alpha_price_tao: null },
  ];
  const res = await req("/api/v1/economics/alpha-price-history?days=40");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.days).toBe(40);
  expect(body.cutoff).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(body.rows).toEqual([
    { netuid: 1, snapshot_date: "2026-07-01", alpha_price_tao: 0.25 },
    { netuid: 1, snapshot_date: "2026-07-10", alpha_price_tao: null },
  ]);
  expect(queryText()).toMatch(/FROM subnet_snapshots/);
});

test("GET /api/v1/economics/alpha-price-history: defaults days and clamps bogus values", async () => {
  mockRows.current = [];
  const def = await req("/api/v1/economics/alpha-price-history");
  expect((await def.json()).days).toBe(35);
  const clamped = await req("/api/v1/economics/alpha-price-history?days=999");
  expect((await clamped.json()).days).toBe(120);
  const bogus = await req("/api/v1/economics/alpha-price-history?days=-3");
  expect((await bogus.json()).days).toBe(35);
});

test("GET /api/v1/economics/trends: unrecognized window degrades to all", async () => {
  mockRows.current = [];
  const res = await req("/api/v1/economics/trends?window=bogus");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window).toBe("all");
});

function snapshotRow(overrides = {}) {
  return {
    netuid: 7,
    snapshot_date: "2026-06-01",
    completeness_score: 90,
    surface_count: 5,
    endpoint_count: 5,
    monitored_count: 5,
    candidate_count: 1,
    validator_count: 8,
    miner_count: 60,
    total_stake_tao: 90,
    alpha_price_tao: 0.01,
    emission_share: 0.02,
    tao_in_pool_tao: 26707.57,
    alpha_in_pool: 2956464.98,
    alpha_out_pool: 2257199.02,
    subnet_volume_tao: 798027.45,
    captured_at: 1780000000000,
    ...overrides,
  };
}

function postSubnetSnapshot(body, { secret, raw } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret !== undefined) headers["x-subnet-snapshot-sync-token"] = secret;
  return req("/api/v1/internal/subnet-snapshot-sync", {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body ?? []),
  });
}

test("subnet-snapshot-sync rejects a missing or wrong token (401)", async () => {
  const wrong = await postSubnetSnapshot([snapshotRow()], { secret: "wrong" });
  expect(wrong.status).toBe(401);
  const missing = await postSubnetSnapshot([snapshotRow()]);
  expect(missing.status).toBe(401);
});

test("subnet-snapshot-sync is disabled (503) when SUBNET_SNAPSHOT_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/subnet-snapshot-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-subnet-snapshot-sync-token": SUBNET_SNAPSHOT_SYNC_SECRET,
      },
      body: JSON.stringify([snapshotRow()]),
    }),
    { HYPERDRIVE: { connectionString: "postgres://mock" } },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("subnet-snapshot-sync returns 503 when the HYPERDRIVE binding is unavailable", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/subnet-snapshot-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-subnet-snapshot-sync-token": SUBNET_SNAPSHOT_SYNC_SECRET,
      },
      body: JSON.stringify([snapshotRow()]),
    }),
    { SUBNET_SNAPSHOT_SYNC_SECRET },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("subnet-snapshot-sync rejects a body over the byte cap (413)", async () => {
  const res = await postSubnetSnapshot(null, {
    secret: SUBNET_SNAPSHOT_SYNC_SECRET,
    raw: "[" + "1".repeat(2_000_000) + "]",
  });
  expect(res.status).toBe(413);
});

test("subnet-snapshot-sync rejects malformed JSON (400)", async () => {
  const res = await postSubnetSnapshot(null, {
    secret: SUBNET_SNAPSHOT_SYNC_SECRET,
    raw: "{not json",
  });
  expect(res.status).toBe(400);
});

test("subnet-snapshot-sync rejects a body that isn't an array (400)", async () => {
  const res = await postSubnetSnapshot(
    { not: "an array" },
    { secret: SUBNET_SNAPSHOT_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("subnet-snapshot-sync rejects more than the row cap (413)", async () => {
  const many = Array.from({ length: 2_001 }, (_, i) =>
    snapshotRow({ netuid: i }),
  );
  const res = await postSubnetSnapshot(many, {
    secret: SUBNET_SNAPSHOT_SYNC_SECRET,
  });
  expect(res.status).toBe(413);
});

test("subnet-snapshot-sync on an empty array is a clean no-op (200)", async () => {
  const res = await postSubnetSnapshot([], {
    secret: SUBNET_SNAPSHOT_SYNC_SECRET,
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: true, rows_written: 0 });
});

test("subnet-snapshot-sync silently skips a row missing a required field, no error", async () => {
  const res = await postSubnetSnapshot(
    [snapshotRow({ netuid: "not-a-number" })],
    {
      secret: SUBNET_SNAPSHOT_SYNC_SECRET,
    },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: true, rows_written: 0 });
});

test("subnet-snapshot-sync upserts subnet_snapshots with the COALESCE-on-economics-columns SET clause", async () => {
  const res = await postSubnetSnapshot(
    [snapshotRow(), snapshotRow({ netuid: 8, snapshot_date: "2026-06-02" })],
    { secret: SUBNET_SNAPSHOT_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: true, rows_written: 2 });
  expect(queryText()).toMatch(/INSERT INTO subnet_snapshots\b/);
  expect(queryText()).toMatch(
    /ON CONFLICT \(netuid, snapshot_date\) DO UPDATE SET/,
  );
  expect(queryText()).toMatch(
    /validator_count = COALESCE\(subnet_snapshots\.validator_count, excluded\.validator_count\)/,
  );
  // #2552: pool liquidity + volume columns follow the same COALESCE-on-conflict
  // semantics as the other economics columns (a later NULL never wipes an
  // earlier fire's good value).
  for (const column of [
    "tao_in_pool_tao",
    "alpha_in_pool",
    "alpha_out_pool",
    "subnet_volume_tao",
  ]) {
    expect(queryText()).toMatch(
      new RegExp(
        `${column} = COALESCE\\(subnet_snapshots\\.${column}, excluded\\.${column}\\)`,
      ),
    );
  }
});

test("subnet-snapshot-sync defaults every optional field to null when absent", async () => {
  const minimal = {
    netuid: 3,
    snapshot_date: "2026-06-01",
    captured_at: 1780000000000,
  };
  const res = await postSubnetSnapshot([minimal], {
    secret: SUBNET_SNAPSHOT_SYNC_SECRET,
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: true, rows_written: 1 });
});

test("subnet-snapshot-sync maps a DB failure to a clean 502 instead of throwing", async () => {
  subnetSnapshotSyncFailure.error = new Error("connection reset");
  const res = await postSubnetSnapshot([snapshotRow()], {
    secret: SUBNET_SNAPSHOT_SYNC_SECRET,
  });
  expect(res.status).toBe(502);
});

test("GET /api/v1/rpc/usage: formats the 6 parallel queries via formatRpcUsage", async () => {
  // Queue order MUST match the route's Promise.all array: totals, latency,
  // endpoints, networks, buckets, freshRows -- each is a separate top-level
  // sql`` call, constructed eagerly (before Promise.all resolves anything),
  // so mockQueue.current is consumed in that same left-to-right order. The
  // leading [] is the router's own `SET statement_timeout` query.
  mockQueue.current = [
    [], // SET statement_timeout
    [
      {
        total: 100,
        ok_count: 95,
        failover_count: 5,
        cache_hits: 20,
        avg_latency_ms: "150",
      },
    ],
    [{ p50: "120", p95: "400" }],
    [
      {
        endpoint_id: "fx",
        provider: "onfinality",
        requests: 100,
        ok_count: 95,
        avg_latency_ms: "140",
      },
    ],
    [{ network: "finney", requests: 100, ok_count: 95 }],
    [{ ts: 1_718_323_200_000, requests: 100, errors: 5, avg_latency_ms: 150 }],
    [{ newest_observed: 1_718_323_200_000 }],
  ];
  const res = await req("/api/v1/rpc/usage?window=30d");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window).toBe("30d");
  expect(body.source).toBe("rpc-proxy");
  expect(body.summary.total_requests).toBe(100);
  expect(body.summary.error_requests).toBe(5);
  expect(body.summary.latency_ms.p50).toBe(120);
  expect(body.endpoints[0].endpoint_id).toBe("fx");
  expect(body.networks[0].network).toBe("finney");
  expect(body.buckets[0].ts).toBe(1_718_323_200_000);
  expect(body.observed_at).toBe(new Date(1_718_323_200_000).toISOString());
});

test("GET /api/v1/rpc/usage: unrecognized window falls back to the 7d default", async () => {
  mockQueue.current = [[], [], [], [], [], [], []]; // SET + 6 route queries
  const res = await req("/api/v1/rpc/usage?window=bogus");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.window).toBe("7d");
  expect(body.summary.total_requests).toBe(0);
});

function rpcUsageEvent(overrides = {}) {
  return {
    observed_at: 1_718_323_200_000,
    network: "finney",
    endpoint_id: "fx",
    provider: "onfinality",
    ok: true,
    status: 200,
    attempts: 1,
    latency_ms: 140,
    cache: "miss",
    ...overrides,
  };
}

function postRpcUsageEvent(body, { secret, raw } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret !== undefined) headers["x-rpc-usage-sync-token"] = secret;
  return req("/api/v1/internal/rpc-usage-sync", {
    method: "POST",
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body ?? rpcUsageEvent()),
  });
}

test("rpc-usage-sync rejects a missing or wrong token (401)", async () => {
  const wrong = await postRpcUsageEvent(rpcUsageEvent(), { secret: "wrong" });
  expect(wrong.status).toBe(401);
  const missing = await postRpcUsageEvent(rpcUsageEvent());
  expect(missing.status).toBe(401);
});

test("rpc-usage-sync is disabled (503) when RPC_USAGE_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/rpc-usage-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rpc-usage-sync-token": RPC_USAGE_SYNC_SECRET,
      },
      body: JSON.stringify(rpcUsageEvent()),
    }),
    { HYPERDRIVE: { connectionString: "postgres://mock" } },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("rpc-usage-sync returns 503 when the HYPERDRIVE binding is unavailable", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/rpc-usage-sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rpc-usage-sync-token": RPC_USAGE_SYNC_SECRET,
      },
      body: JSON.stringify(rpcUsageEvent()),
    }),
    { RPC_USAGE_SYNC_SECRET },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("rpc-usage-sync rejects a body over the byte cap (413)", async () => {
  const res = await postRpcUsageEvent(null, {
    secret: RPC_USAGE_SYNC_SECRET,
    raw: `{"network":"${"a".repeat(4_000)}"}`,
  });
  expect(res.status).toBe(413);
});

test("rpc-usage-sync rejects malformed JSON (400)", async () => {
  const res = await postRpcUsageEvent(null, {
    secret: RPC_USAGE_SYNC_SECRET,
    raw: "{not json",
  });
  expect(res.status).toBe(400);
});

test("rpc-usage-sync rejects an event missing required fields (400)", async () => {
  const res = await postRpcUsageEvent(
    { observed_at: 1_718_323_200_000 },
    { secret: RPC_USAGE_SYNC_SECRET },
  );
  expect(res.status).toBe(400);
});

test("rpc-usage-sync rejects a JSON array body (400)", async () => {
  const res = await postRpcUsageEvent([rpcUsageEvent()], {
    secret: RPC_USAGE_SYNC_SECRET,
  });
  expect(res.status).toBe(400);
});

test("rpc-usage-sync inserts a single row and defaults optional fields to null", async () => {
  const res = await postRpcUsageEvent(
    { observed_at: 1_718_323_200_000, network: "finney", ok: false },
    { secret: RPC_USAGE_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: true });
  expect(queryText()).toMatch(/INSERT INTO rpc_proxy_events\b/);
  const call = sqlCalls.at(-1);
  expect(call.values).toEqual([
    1_718_323_200_000,
    "finney",
    null,
    null,
    false,
    null,
    null,
    null,
    null,
  ]);
});

test("rpc-usage-sync inserts a fully-populated row", async () => {
  const res = await postRpcUsageEvent(rpcUsageEvent(), {
    secret: RPC_USAGE_SYNC_SECRET,
  });
  expect(res.status).toBe(200);
  const call = sqlCalls.at(-1);
  expect(call.values).toEqual([
    1_718_323_200_000,
    "finney",
    "fx",
    "onfinality",
    true,
    200,
    1,
    140,
    "miss",
  ]);
});

test("rpc-usage-sync maps a DB failure to a clean 502 instead of throwing", async () => {
  rpcUsageSyncFailure.error = new Error("connection reset");
  const res = await postRpcUsageEvent(rpcUsageEvent(), {
    secret: RPC_USAGE_SYNC_SECRET,
  });
  expect(res.status).toBe(502);
});

function postRpcUsagePrune(body, { secret, raw } = {}) {
  const headers = { "content-type": "application/json" };
  if (secret !== undefined) headers["x-rpc-usage-sync-token"] = secret;
  return req("/api/v1/internal/rpc-usage-prune", {
    method: "POST",
    headers,
    body:
      raw !== undefined
        ? raw
        : JSON.stringify(body ?? { cutoff: 1_718_000_000_000 }),
  });
}

test("rpc-usage-prune rejects a missing or wrong token (401)", async () => {
  const wrong = await postRpcUsagePrune(undefined, { secret: "wrong" });
  expect(wrong.status).toBe(401);
  const missing = await postRpcUsagePrune();
  expect(missing.status).toBe(401);
});

test("rpc-usage-prune is disabled (503) when RPC_USAGE_SYNC_SECRET is not configured", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/rpc-usage-prune", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rpc-usage-sync-token": RPC_USAGE_SYNC_SECRET,
      },
      body: JSON.stringify({ cutoff: 1_718_000_000_000 }),
    }),
    { HYPERDRIVE: { connectionString: "postgres://mock" } },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("rpc-usage-prune returns 503 when the HYPERDRIVE binding is unavailable", async () => {
  const res = await worker.fetch(
    new Request("https://d/api/v1/internal/rpc-usage-prune", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rpc-usage-sync-token": RPC_USAGE_SYNC_SECRET,
      },
      body: JSON.stringify({ cutoff: 1_718_000_000_000 }),
    }),
    { RPC_USAGE_SYNC_SECRET },
    ctx,
  );
  expect(res.status).toBe(503);
});

test("rpc-usage-prune rejects malformed JSON (400)", async () => {
  const res = await postRpcUsagePrune(null, {
    secret: RPC_USAGE_SYNC_SECRET,
    raw: "{not json",
  });
  expect(res.status).toBe(400);
});

test("rpc-usage-prune rejects a body missing a finite cutoff (400)", async () => {
  const missing = await postRpcUsagePrune(
    {},
    { secret: RPC_USAGE_SYNC_SECRET },
  );
  expect(missing.status).toBe(400);
  const nonNumeric = await postRpcUsagePrune(
    { cutoff: "not-a-number" },
    { secret: RPC_USAGE_SYNC_SECRET },
  );
  expect(nonNumeric.status).toBe(400);
  const array = await postRpcUsagePrune([1_718_000_000_000], {
    secret: RPC_USAGE_SYNC_SECRET,
  });
  expect(array.status).toBe(400);
});

test("rpc-usage-prune deletes rows older than cutoff and reports rows_deleted", async () => {
  rpcUsagePruneCount.current = 5;
  const res = await postRpcUsagePrune(
    { cutoff: 1_718_000_000_000 },
    { secret: RPC_USAGE_SYNC_SECRET },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ok: true, rows_deleted: 5 });
  expect(queryText()).toMatch(
    /DELETE FROM rpc_proxy_events WHERE observed_at < /,
  );
  const call = sqlCalls.at(-1);
  expect(call.values).toEqual([1_718_000_000_000]);
});

test("rpc-usage-prune maps a DB failure to a clean 502 instead of throwing", async () => {
  rpcUsagePruneFailure.error = new Error("connection reset");
  const res = await postRpcUsagePrune(
    { cutoff: 1_718_000_000_000 },
    { secret: RPC_USAGE_SYNC_SECRET },
  );
  expect(res.status).toBe(502);
});
