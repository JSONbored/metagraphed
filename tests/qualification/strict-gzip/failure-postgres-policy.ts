import {
  failureReplayFailure,
  withFailureReplayReason,
  withFailureReplayReasonAsync,
} from "./failure-replay-diagnostics.ts";
// Pure policy for the additional synthetic failure fixture. No connection or service.
import assert from "node:assert/strict";
import {
  POSTGRES_OWNER,
  QUEUE_EXTERNAL_SERVICE,
  QUEUE_HYPERDRIVES,
  QUEUE_HYPERDRIVE_URL,
  sha256,
} from "./postgres-owner-fixture.ts";

export const FAILURE_WRONG_PASSWORD =
  "synthetic-deliberately-wrong-writer-only";
export const FAILURE_HYPERDRIVE_URL =
  "postgresql://qualification_writer:synthetic-deliberately-wrong-writer-only@127.0.0.1:55432/whole_owner_fixture?sslmode=disable";
export const FAILURE_HYPERDRIVES = Object.freeze({
  HYPERDRIVE: FAILURE_HYPERDRIVE_URL,
});
export type FailureAuth = "valid" | "wrong-password";
export function assertFailureHyperdriveMap(
  value: unknown,
  auth: FailureAuth,
): void {
  try {
    try {
      assert.ok(auth === "valid" || auth === "wrong-password");
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-001");
    }
    try {
      assert.ok(value && typeof value === "object");
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-002");
    }
    try {
      assert.equal(Object.getPrototypeOf(value), Object.prototype);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-003");
    }
    try {
      assert.deepEqual(Reflect.ownKeys(value), ["HYPERDRIVE"]);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-004");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, "HYPERDRIVE");
    try {
      assert.ok(descriptor && "value" in descriptor && descriptor.enumerable);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-005");
    }
    const wanted = auth === "valid" ? QUEUE_HYPERDRIVES : FAILURE_HYPERDRIVES;
    try {
      assert.deepEqual(value, wanted);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-006");
    }
    const url = new URL(descriptor.value);
    try {
      assert.equal(url.href, wanted.HYPERDRIVE);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-007");
    }
    try {
      assert.equal(url.hostname, POSTGRES_OWNER.host);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-008");
    }
    try {
      assert.equal(url.port, String(POSTGRES_OWNER.port));
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-009");
    }
    try {
      assert.equal(url.username, POSTGRES_OWNER.writer);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-010");
    }
    try {
      assert.equal(url.pathname, `/${POSTGRES_OWNER.database}`);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-011");
    }
    try {
      assert.equal(url.search, "?sslmode=disable");
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-012");
    }
    try {
      assert.equal(url.hash, "");
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-013");
    }
    try {
      assert.notEqual(FAILURE_WRONG_PASSWORD, POSTGRES_OWNER.writerPassword);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-014");
    }
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fpp-stage-001");
  }
}
export function failureBinding(auth: FailureAuth) {
  try {
    try {
      assertFailureHyperdriveMap(
        auth === "valid" ? QUEUE_HYPERDRIVES : FAILURE_HYPERDRIVES,
        auth,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-015");
    }
    return [
      {
        name: "HYPERDRIVE",
        hyperdrive: {
          designator: { name: "hyperdrive:HYPERDRIVE" },
          database: POSTGRES_OWNER.database,
          user: POSTGRES_OWNER.writer,
          password:
            auth === "valid"
              ? POSTGRES_OWNER.writerPassword
              : FAILURE_WRONG_PASSWORD,
          scheme: "postgresql",
        },
      },
    ];
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fpp-stage-002");
  }
}
function assertParsed(options: any, auth: FailureAuth) {
  try {
    try {
      assert.ok(options && options.hyperdrives);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-016");
    }
    try {
      assert.deepEqual(Reflect.ownKeys(options.hyperdrives), ["HYPERDRIVE"]);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-017");
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      options.hyperdrives,
      "HYPERDRIVE",
    );
    try {
      assert.ok(
        descriptor && "value" in descriptor && descriptor.value instanceof URL,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-018");
    }
    try {
      assertFailureHyperdriveMap({ HYPERDRIVE: descriptor.value.href }, auth);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-019");
    }
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fpp-stage-003");
  }
}
export async function inspectFailureTransport(plugin: any, auth: FailureAuth) {
  try {
    const mapping = auth === "valid" ? QUEUE_HYPERDRIVES : FAILURE_HYPERDRIVES;
    try {
      assertFailureHyperdriveMap(mapping, auth);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-020");
    }
    const options = plugin.options.parse({ hyperdrives: { ...mapping } });
    try {
      assertParsed(options, auth);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-021");
    }
    try {
      assert.deepEqual(plugin.getBindings(options), failureBinding(auth));
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-022");
    }
    const services = await plugin.getServices({
      options,
      hyperdriveProxyController: {
        createProxyServer() {
          try {
            throw new Error("Failure fixture forbids Hyperdrive proxy/TLS");
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpp-stage-005");
          }
        },
      },
    });
    try {
      assert.deepEqual(services, [QUEUE_EXTERNAL_SERVICE]);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-023");
    }
    return {
      mappingSha256: sha256(JSON.stringify(mapping)),
      serviceSha256: sha256(JSON.stringify(services)),
    };
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fpp-stage-004");
  }
}
/** Observe actual native config generation, including password binding and TCP service.
 * Originals, receivers, arguments, and exact returned objects remain intact. */
export function observeFailureTransport(plugin: any, auth: FailureAuth) {
  try {
    const originalBindings = plugin.getBindings,
      originalServices = plugin.getServices;
    let bindingCalls = 0,
      serviceCalls = 0,
      serviceSettled = false,
      failed = false,
      restored = false;
    const bindings = function (this: unknown, ...args: any[]) {
      try {
        try {
          try {
            assert.equal(restored, false);
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpp-check-024");
          }
          try {
            assert.equal(bindingCalls++, 0);
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpp-check-025");
          }
          try {
            assertParsed(args[0], auth);
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpp-check-026");
          }
          const result = Reflect.apply(originalBindings, this, args);
          try {
            assert.deepEqual(result, failureBinding(auth));
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpp-check-027");
          }
          return result;
        } catch (error) {
          failed = true;
          throw error;
        }
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fpp-stage-007");
      }
    };
    const services = function (this: unknown, ...args: any[]) {
      try {
        try {
          try {
            assert.equal(restored, false);
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpp-check-028");
          }
          try {
            assert.equal(serviceCalls++, 0);
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpp-check-029");
          }
          try {
            assertParsed(args[0]?.options, auth);
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpp-check-030");
          }
          const result: any = Reflect.apply(originalServices, this, args);
          // Observe without replacing the original return Promise/object.
          if (result && typeof result.then === "function") {
            result.then(
              (value: unknown) => {
                try {
                  try {
                    try {
                      assert.deepEqual(value, [QUEUE_EXTERNAL_SERVICE]);
                    } catch (failureReplayError) {
                      throw failureReplayFailure(
                        failureReplayError,
                        "fpp-check-031",
                      );
                    }
                    serviceSettled = true;
                  } catch {
                    failed = true;
                  }
                } catch (failureReplayError) {
                  throw failureReplayFailure(
                    failureReplayError,
                    "fpp-stage-009",
                  );
                }
              },
              () => {
                try {
                  failed = true;
                } catch (failureReplayError) {
                  throw failureReplayFailure(
                    failureReplayError,
                    "fpp-stage-010",
                  );
                }
              },
            );
          } else {
            try {
              assert.deepEqual(result, [QUEUE_EXTERNAL_SERVICE]);
            } catch (failureReplayError) {
              throw failureReplayFailure(failureReplayError, "fpp-check-032");
            }
            serviceSettled = true;
          }
          return result;
        } catch (error) {
          failed = true;
          throw error;
        }
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fpp-stage-008");
      }
    };
    plugin.getBindings = bindings;
    plugin.getServices = services;
    return {
      assertObserved() {
        try {
          try {
            assert.equal(failed, false);
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpp-check-033");
          }
          try {
            assert.equal(serviceSettled, true);
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpp-check-034");
          }
          try {
            assert.equal(bindingCalls, 1);
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpp-check-035");
          }
          try {
            assert.equal(serviceCalls, 1);
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpp-check-036");
          }
          return {
            bindingCalls: 1,
            serviceCalls: 1,
            serviceSha256: sha256(JSON.stringify([QUEUE_EXTERNAL_SERVICE])),
          };
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpp-stage-011");
        }
      },
      restore() {
        try {
          try {
            assert.equal(plugin.getBindings, bindings);
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpp-check-037");
          }
          try {
            assert.equal(plugin.getServices, services);
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpp-check-038");
          }
          plugin.getBindings = originalBindings;
          plugin.getServices = originalServices;
          restored = true;
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpp-stage-012");
        }
      },
    };
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fpp-stage-006");
  }
}
export const FAILURE_CHAIN_QUERY =
  "INSERT INTO chain_detail_chain_events (block_number, event_index, pallet, method, args, phase, extrinsic_index, observed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (block_number, event_index) DO UPDATE SET pallet = EXCLUDED.pallet, method = EXCLUDED.method, args = EXCLUDED.args, phase = EXCLUDED.phase, extrinsic_index = EXCLUDED.extrinsic_index, observed_at = EXCLUDED.observed_at";
export interface FailureHolder {
  block: number;
  pid: number;
  backendStart: string;
  transactionId: string;
}
export interface FailureWaiter {
  pid: number;
  backendStart: string;
  queryStart: string;
  querySha256: string;
  holder: FailureHolder;
}
// Exact authenticated identity plus owned transaction lock, not pid alone.
export const FAILURE_CANCEL_MAX_QUERY_AGE_MS = 10_000;
export const FAILURE_WAIT_SQL = `
SELECT a.pid, a.datname AS database, a.usename AS username, a.query,
 a.backend_start::text AS backend_start, a.query_start::text AS query_start,
 (EXTRACT(EPOCH FROM (clock_timestamp() - a.query_start)) * 1000)::double precision AS query_age_ms,
 a.state, a.wait_event_type, a.wait_event, pg_blocking_pids(a.pid) AS blockers,
 w.transactionid::text AS transaction_id, h.pid AS blocker_pid,
 c.backend_start::text AS blocker_backend_start, c.datname AS blocker_database,
 c.usename AS blocker_username, c.state AS blocker_state
FROM pg_stat_activity a
JOIN pg_locks w ON w.pid = a.pid AND w.locktype = 'transactionid' AND w.mode = 'ShareLock' AND NOT w.granted
JOIN pg_locks h ON h.transactionid = w.transactionid AND h.locktype = 'transactionid' AND h.mode = 'ExclusiveLock' AND h.granted
JOIN pg_stat_activity c ON c.pid = h.pid
WHERE a.datname = $1 AND a.usename = $2 AND h.pid = $3
ORDER BY a.pid`;
function validIdentityText(value: unknown): asserts value is string {
  try {
    try {
      assert.equal(typeof value, "string");
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-039");
    }
    try {
      assert.ok(
        (value as string).length >= 20 && (value as string).length <= 64,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-040");
    }
    try {
      assert.ok(Number.isFinite(Date.parse(value as string)));
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-041");
    }
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fpp-stage-013");
  }
}
export function validateFailureWaiter(
  rows: Record<string, any>[],
  holder: FailureHolder,
): FailureWaiter {
  try {
    try {
      assert.ok(
        Number.isSafeInteger(holder.block) &&
          holder.block > 0 &&
          holder.block <= 2_147_483_647,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-042");
    }
    try {
      assert.ok(Number.isSafeInteger(holder.pid) && holder.pid > 0);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-043");
    }
    try {
      assert.match(holder.transactionId, /^[1-9][0-9]{0,19}$/);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-044");
    }
    validIdentityText(holder.backendStart);
    try {
      assert.equal(rows.length, 1);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-045");
    }
    const row = rows[0]!;
    try {
      assert.ok(
        Number.isSafeInteger(row.pid) && row.pid > 0 && row.pid !== holder.pid,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-046");
    }
    try {
      assert.equal(row.database, POSTGRES_OWNER.database);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-047");
    }
    try {
      assert.equal(row.username, POSTGRES_OWNER.writer);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-048");
    }
    try {
      assert.equal(row.query, FAILURE_CHAIN_QUERY);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-049");
    }
    validIdentityText(row.backend_start);
    validIdentityText(row.query_start);
    try {
      assert.ok(
        typeof row.query_age_ms === "number" &&
          Number.isFinite(row.query_age_ms) &&
          row.query_age_ms >= 0 &&
          row.query_age_ms < FAILURE_CANCEL_MAX_QUERY_AGE_MS,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-050");
    }
    try {
      assert.equal(row.state, "active");
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-051");
    }
    try {
      assert.equal(row.wait_event_type, "Lock");
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-052");
    }
    try {
      assert.equal(row.wait_event, "transactionid");
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-053");
    }
    try {
      assert.equal(row.transaction_id, holder.transactionId);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-054");
    }
    try {
      assert.equal(row.blocker_pid, holder.pid);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-055");
    }
    try {
      assert.equal(row.blocker_backend_start, holder.backendStart);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-056");
    }
    try {
      assert.equal(row.blocker_database, POSTGRES_OWNER.database);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-057");
    }
    try {
      assert.equal(row.blocker_username, POSTGRES_OWNER.admin);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-058");
    }
    try {
      assert.equal(row.blocker_state, "idle in transaction");
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-059");
    }
    try {
      assert.deepEqual(row.blockers, [holder.pid]);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-060");
    }
    return {
      pid: row.pid,
      backendStart: row.backend_start,
      queryStart: row.query_start,
      querySha256: sha256(row.query),
      holder: { ...holder },
    };
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fpp-stage-014");
  }
}
export function assertSameFailureWaiter(
  current: FailureWaiter,
  witnessed: FailureWaiter,
): void {
  try {
    try {
      assert.deepEqual(current, witnessed);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-061");
    }
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fpp-stage-015");
  }
}
// Repeat every identity/lock predicate in the signal-bearing statement. A re-used
// PID, advanced query, released controller, unrelated lock or no-op returns no row.
export const FAILURE_CANCEL_SQL = `
SELECT a.pid, a.backend_start::text AS backend_start, a.query_start::text AS query_start,
 pg_cancel_backend(a.pid) AS cancelled
FROM pg_stat_activity a
JOIN pg_locks w ON w.pid = a.pid AND w.locktype = 'transactionid' AND w.mode = 'ShareLock' AND NOT w.granted
JOIN pg_locks h ON h.transactionid = w.transactionid AND h.locktype = 'transactionid' AND h.mode = 'ExclusiveLock' AND h.granted
JOIN pg_stat_activity c ON c.pid = h.pid
WHERE a.datname = $1 AND a.usename = $2 AND a.pid = $3
 AND a.backend_start::text = $4 AND a.query_start::text = $5 AND a.query = $6
 AND a.state = 'active' AND a.wait_event_type = 'Lock' AND a.wait_event = 'transactionid'
 AND a.query_start > clock_timestamp() - interval '10 seconds' AND a.query_start <= clock_timestamp()
 AND w.transactionid::text = $7 AND h.pid = $8 AND c.backend_start::text = $9
 AND c.datname = $1 AND c.usename = $10 AND c.state = 'idle in transaction'
 AND pg_blocking_pids(a.pid) = ARRAY[$8::integer]`;
export function cancelParameters(witness: FailureWaiter): unknown[] {
  try {
    return [
      POSTGRES_OWNER.database,
      POSTGRES_OWNER.writer,
      witness.pid,
      witness.backendStart,
      witness.queryStart,
      FAILURE_CHAIN_QUERY,
      witness.holder.transactionId,
      witness.holder.pid,
      witness.holder.backendStart,
      POSTGRES_OWNER.admin,
    ];
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fpp-stage-016");
  }
}
export function assertCancellationResult(
  rows: Record<string, any>[],
  witness: FailureWaiter,
): void {
  try {
    try {
      assert.deepEqual(rows, [
        {
          pid: witness.pid,
          backend_start: witness.backendStart,
          query_start: witness.queryStart,
          cancelled: true,
        },
      ]);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-062");
    }
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fpp-stage-017");
  }
}
export function assertFailureDisposition(
  outcome: unknown,
  ackIds: string[],
  retryIds: string[],
) {
  try {
    try {
      assert.equal(
        new Set([...ackIds, ...retryIds]).size,
        ackIds.length + retryIds.length,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-063");
    }
    try {
      assert.deepEqual(outcome, {
        outcome: "ok",
        ackAll: false,
        retryBatch: { retry: false },
        explicitAcks: ackIds,
        retryMessages: retryIds.map((msgId) => ({ msgId })),
      });
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-064");
    }
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fpp-stage-018");
  }
}
export { QUEUE_HYPERDRIVE_URL };

export interface FailureCaseReceipt {
  scenario:
    | "auth-rejection"
    | "query-cancellation"
    | "decoder-refusal"
    | "auth-unfixed-control";
  phase: "uninstrumented" | "instrumented" | "unfixed-instrumented";
  modules: { sha256: string; bytes: number }[];
  lifecycle:
    "supplemental-passed" | "not-instrumented" | "negative-control-passed";
  negativeControl?: {
    clients: number;
    rejectedConnects: number;
    observedEndCalls: number;
    fixedLifecycleOracle: "rejected-missing-end";
  };
  productionMemory: "inconclusive";
  productionCpu: "inconclusive";
  bodySha256: string[];
  dispositions: { ack: string[]; retry: string[] }[];
  partialCounts: number[];
  partialSha256: string;
  finalCounts: number[];
  finalSha256: string;
  runtimes: {
    mappingSha256: string;
    serviceSha256: string;
    isolateSha256: string;
    runtimeSha256: string;
    guardedNativeLaunches: number;
    observedNativeExits: number;
    restarts: 0;
    blockedOutbound: 0;
    pending: 0;
    remainingWriterSessions: 0;
    stableZeroSamples: 2;
  }[];
  replay:
    | "separate-valid-runtime"
    | "byte-identical-same-isolate"
    | "same-isolate-subsequent-success"
    | "no-replay";
}
const FAILURE_CASE_ORDER = [
  "auth-rejection",
  "query-cancellation",
  "decoder-refusal",
] as const;
function exactKeys(value: any, keys: string[]) {
  try {
    try {
      assert.ok(value && typeof value === "object" && !Array.isArray(value));
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-065");
    }
    try {
      assert.equal(Object.getPrototypeOf(value), Object.prototype);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-066");
    }
    try {
      assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort());
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-067");
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      try {
        assert.ok(descriptor && "value" in descriptor && descriptor.enumerable);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fpp-check-068");
      }
    }
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fpp-stage-019");
  }
}
function hash(value: unknown) {
  try {
    try {
      assert.equal(typeof value, "string");
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-069");
    }
    try {
      assert.match(value as string, /^[a-f0-9]{64}$/);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-070");
    }
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fpp-stage-020");
  }
}
/** Closed receipt schema: local raw SQL, errors, rows and backend identities cannot pass. */
export function assertFailureReceipt(input: unknown): asserts input is {
  version: 1;
  phase: "uninstrumented" | "instrumented" | "unfixed-instrumented";
  cases: FailureCaseReceipt[];
} {
  try {
    const receipt = input as any;
    exactKeys(receipt, ["version", "phase", "cases"]);
    try {
      assert.equal(receipt.version, 1);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-071");
    }
    try {
      assert.ok(
        receipt.phase === "uninstrumented" ||
          receipt.phase === "instrumented" ||
          receipt.phase === "unfixed-instrumented",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-072");
    }
    const negative = receipt.phase === "unfixed-instrumented";
    try {
      assert.ok(Array.isArray(receipt.cases));
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-073");
    }
    try {
      assert.equal(receipt.cases.length, negative ? 1 : 3);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-074");
    }
    const plans = [
      {
        bodies: 2,
        partial: [0, 0, 0, 0],
        final: [1, 1, 1, 1],
        runtimes: 2,
        replay: "separate-valid-runtime",
        dispositions: [
          { ack: [], retry: ["failure-auth"] },
          { ack: ["control-auth"], retry: [] },
        ],
      },
      {
        bodies: 2,
        partial: [1, 2, 1, 2],
        final: [2, 2, 2, 2],
        runtimes: 1,
        replay: "byte-identical-same-isolate",
        dispositions: [
          { ack: ["neighbor-query"], retry: ["failure-query"] },
          { ack: ["failure-query"], retry: [] },
        ],
      },
      {
        bodies: 4,
        partial: [2, 2, 2, 2],
        final: [3, 3, 3, 3],
        runtimes: 1,
        replay: "same-isolate-subsequent-success",
        dispositions: [
          {
            ack: ["neighbor-before", "neighbor-after"],
            retry: ["failure-decoder"],
          },
          { ack: ["neighbor-later"], retry: [] },
        ],
      },
    ];
    if (negative)
      plans.splice(0, plans.length, {
        bodies: 1,
        partial: [0, 0, 0, 0],
        final: [0, 0, 0, 0],
        runtimes: 1,
        replay: "no-replay",
        dispositions: [{ ack: [], retry: ["failure-auth-unfixed"] }],
      });
    const allIsolates: string[] = [];
    receipt.cases.forEach((row: any, index: number) => {
      try {
        exactKeys(row, [
          "scenario",
          "phase",
          "modules",
          "lifecycle",
          "productionMemory",
          "productionCpu",
          "bodySha256",
          "dispositions",
          "partialCounts",
          "partialSha256",
          "finalCounts",
          "finalSha256",
          "runtimes",
          "replay",
          ...(negative ? ["negativeControl"] : []),
        ]);
        if (negative) {
          exactKeys(row.negativeControl, [
            "clients",
            "rejectedConnects",
            "observedEndCalls",
            "fixedLifecycleOracle",
          ]);
          try {
            assert.ok(
              Number.isSafeInteger(row.negativeControl.clients) &&
                row.negativeControl.clients >= 1 &&
                row.negativeControl.clients <= 128,
            );
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpp-check-075");
          }
          try {
            assert.equal(
              row.negativeControl.rejectedConnects,
              row.negativeControl.clients,
            );
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpp-check-076");
          }
          try {
            assert.equal(row.negativeControl.observedEndCalls, 0);
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpp-check-077");
          }
          try {
            assert.equal(
              row.negativeControl.fixedLifecycleOracle,
              "rejected-missing-end",
            );
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpp-check-078");
          }
        }
        const plan = plans[index]!;
        try {
          assert.equal(
            row.scenario,
            negative ? "auth-unfixed-control" : FAILURE_CASE_ORDER[index],
          );
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpp-check-079");
        }
        try {
          assert.equal(row.phase, receipt.phase);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpp-check-080");
        }
        try {
          assert.equal(
            row.lifecycle,
            negative
              ? "negative-control-passed"
              : receipt.phase === "instrumented"
                ? "supplemental-passed"
                : "not-instrumented",
          );
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpp-check-081");
        }
        try {
          assert.equal(row.productionMemory, "inconclusive");
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpp-check-082");
        }
        try {
          assert.equal(row.productionCpu, "inconclusive");
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpp-check-083");
        }
        try {
          assert.ok(
            Array.isArray(row.modules) &&
              row.modules.length >= 1 &&
              row.modules.length <= 32,
          );
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpp-check-084");
        }
        for (const module of row.modules) {
          exactKeys(module, ["sha256", "bytes"]);
          hash(module.sha256);
          try {
            assert.ok(
              Number.isSafeInteger(module.bytes) &&
                module.bytes > 0 &&
                module.bytes <= 64 * 1024 * 1024,
            );
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpp-check-085");
          }
        }
        try {
          assert.ok(Array.isArray(row.bodySha256));
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpp-check-086");
        }
        try {
          assert.equal(row.bodySha256.length, plan.bodies);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpp-check-087");
        }
        row.bodySha256.forEach(hash);
        try {
          assert.deepEqual(row.dispositions, plan.dispositions);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpp-check-088");
        }
        try {
          assert.deepEqual(row.partialCounts, plan.partial);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpp-check-089");
        }
        try {
          assert.deepEqual(row.finalCounts, plan.final);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpp-check-090");
        }
        hash(row.partialSha256);
        hash(row.finalSha256);
        try {
          assert.equal(row.replay, plan.replay);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpp-check-091");
        }
        try {
          assert.ok(Array.isArray(row.runtimes));
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpp-check-092");
        }
        try {
          assert.equal(row.runtimes.length, plan.runtimes);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpp-check-093");
        }
        row.runtimes.forEach((runtime: any, runtimeIndex: number) => {
          try {
            exactKeys(runtime, [
              "mappingSha256",
              "serviceSha256",
              "isolateSha256",
              "runtimeSha256",
              "guardedNativeLaunches",
              "observedNativeExits",
              "restarts",
              "blockedOutbound",
              "pending",
              "remainingWriterSessions",
              "stableZeroSamples",
            ]);
            for (const key of [
              "mappingSha256",
              "serviceSha256",
              "isolateSha256",
              "runtimeSha256",
            ])
              hash(runtime[key]);
            const map =
              index === 0 && runtimeIndex === 0
                ? FAILURE_HYPERDRIVES
                : QUEUE_HYPERDRIVES;
            try {
              assert.equal(runtime.mappingSha256, sha256(JSON.stringify(map)));
            } catch (failureReplayError) {
              throw failureReplayFailure(failureReplayError, "fpp-check-094");
            }
            try {
              assert.equal(
                runtime.serviceSha256,
                sha256(JSON.stringify([QUEUE_EXTERNAL_SERVICE])),
              );
            } catch (failureReplayError) {
              throw failureReplayFailure(failureReplayError, "fpp-check-095");
            }
            try {
              assert.equal(runtime.guardedNativeLaunches, 1);
            } catch (failureReplayError) {
              throw failureReplayFailure(failureReplayError, "fpp-check-096");
            }
            try {
              assert.equal(runtime.observedNativeExits, 1);
            } catch (failureReplayError) {
              throw failureReplayFailure(failureReplayError, "fpp-check-097");
            }
            for (const key of [
              "restarts",
              "blockedOutbound",
              "pending",
              "remainingWriterSessions",
            ])
              try {
                assert.equal(runtime[key], 0);
              } catch (failureReplayError) {
                throw failureReplayFailure(failureReplayError, "fpp-check-098");
              }
            try {
              assert.equal(runtime.stableZeroSamples, 2);
            } catch (failureReplayError) {
              throw failureReplayFailure(failureReplayError, "fpp-check-099");
            }
            allIsolates.push(runtime.isolateSha256);
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpp-stage-023");
          }
        });
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fpp-stage-022");
      }
    });
    try {
      assert.equal(
        new Set(allIsolates).size,
        negative ? 1 : 4,
        "Require distinct owned runtimes; replay stays within the selected runtime",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpp-check-100");
    }
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fpp-stage-021");
  }
}
