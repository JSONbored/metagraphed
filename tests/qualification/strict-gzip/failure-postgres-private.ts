import {
  failureReplayFailure,
  withFailureReplayReason,
  withFailureReplayReasonAsync,
} from "./failure-replay-diagnostics.ts";
// Private native proof replay. Never publish this input or return raw lifecycle/SQL.
import assert from "node:assert/strict";
import path from "node:path";
import { sha256 } from "./postgres-owner-fixture.ts";
import {
  OWNER_SCENARIOS,
  type OwnerObservations,
} from "./owner-resource-policy.ts";
import {
  assertFailureReceipt,
  validateFailureWaiter,
  assertSameFailureWaiter,
  assertCancellationResult,
  type FailureCaseReceipt,
} from "./failure-postgres-policy.ts";
import type { FailureCancellationEvidence } from "./failure-postgres-fixture.ts";
import type { FailureLifecycleSnapshot } from "./failure-lifecycle-observer.ts";
import {
  assertFailureAuthLifecycle,
  assertFailureUnfixedAuthControl,
  assertFailureQueryLifecycle,
  assertFailureDecoderLifecycle,
  assertFailureSuccessfulLifecycle,
} from "./failure-lifecycle-assertions.ts";
export const FAILURE_PRIVATE_MAX_BYTES = 2 * 1024 * 1024;
export interface FailurePrivateRuntime {
  observation: OwnerObservations | null;
  postExitDrain?: {
    boundary: "after-observed-native-exit";
    remainingWriterSessions: 0;
    stableZeroSamples: 2;
  };
  lifecycleSnapshots: {
    checkpoint: string;
    snapshot: FailureLifecycleSnapshot;
  }[];
}
export interface FailurePrivateCase {
  scenario: FailureCaseReceipt["scenario"];
  runtimes: FailurePrivateRuntime[];
  cancellation: FailureCancellationEvidence | null;
}
export interface FailurePrivateReceipt {
  version: 1;
  phase: FailureCaseReceipt["phase"];
  cases: FailurePrivateCase[];
}
function keys(value: any, expected: readonly string[]) {
  try {
    try {
      assert.ok(value && typeof value === "object" && !Array.isArray(value));
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-001");
    }
    try {
      assert.equal(Object.getPrototypeOf(value), Object.prototype);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-002");
    }
    try {
      assert.deepEqual(Reflect.ownKeys(value).sort(), [...expected].sort());
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-003");
    }
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      try {
        assert.ok(descriptor && "value" in descriptor && descriptor.enumerable);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fpr-check-004");
      }
    }
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fpr-stage-001");
  }
}
function finite(value: unknown) {
  try {
    try {
      assert.ok(
        typeof value === "number" && Number.isFinite(value) && value >= 0,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-005");
    }
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fpr-stage-002");
  }
}
function observation(
  value: OwnerObservations,
  expected: FailureCaseReceipt["runtimes"][number],
  scenario: string,
) {
  try {
    keys(value, [
      "hostPid",
      "runtimePid",
      "runtimeStartTicks",
      "runtimeExecutablePath",
      "runtimeVersion",
      "runtimeSha256",
      "owner",
      "isolateId",
      "runtimeRestarts",
      "samples",
      "sampleErrors",
      "missedSamples",
      "maximumGapMs",
      "sampling",
      "postgresMemory",
    ]);
    for (const pid of [value.hostPid, value.runtimePid])
      try {
        assert.ok(Number.isSafeInteger(pid) && pid > 0);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fpr-check-006");
      }
    try {
      assert.notEqual(value.hostPid, value.runtimePid);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-007");
    }
    try {
      assert.match(value.runtimeStartTicks, /^\d{1,30}$/);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-008");
    }
    try {
      assert.ok(
        typeof value.runtimeExecutablePath === "string" &&
          value.runtimeExecutablePath.length <= 4096 &&
          path.isAbsolute(value.runtimeExecutablePath),
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-009");
    }
    try {
      assert.equal(value.runtimeVersion, "1.20260730.1");
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-010");
    }
    try {
      assert.equal(value.runtimeSha256, expected.runtimeSha256);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-011");
    }
    try {
      assert.equal(value.owner, OWNER_SCENARIOS.queue.worker);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-012");
    }
    try {
      assert.match(value.isolateId, /^[a-f0-9]{1,64}$/i);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-013");
    }
    try {
      assert.equal(sha256(value.isolateId), expected.isolateSha256);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-014");
    }
    for (const number of [
      value.runtimeRestarts,
      value.sampleErrors,
      value.missedSamples,
    ])
      try {
        assert.equal(number, 0);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fpr-check-015");
      }
    finite(value.maximumGapMs);
    try {
      assert.equal(value.sampling, "explicit-phase-checkpoints");
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-016");
    }
    try {
      assert.equal(value.postgresMemory, "not-observed");
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-017");
    }
    try {
      assert.ok(Array.isArray(value.samples));
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-018");
    }
    try {
      assert.deepEqual(
        value.samples.map((row) => row.phase),
        scenario === "query-cancellation"
          ? ["baseline", "overlap", "drained"]
          : ["baseline", "drained"],
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-019");
    }
    let previous = -1,
      maxGap = 0;
    for (const sample of value.samples) {
      keys(sample, [
        "atMs",
        "phase",
        "isolateId",
        "heapUsed",
        "heapTotal",
        "backingStorage",
        "embedderHeap",
        "nativeExternal",
        "workerdRss",
        "workerdHwm",
        "hostRss",
        "hostHwm",
        "postgresRss",
      ]);
      try {
        assert.equal(sample.isolateId, value.isolateId);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fpr-check-020");
      }
      finite(sample.atMs);
      try {
        assert.ok(sample.atMs > previous);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fpr-check-021");
      }
      if (previous >= 0) maxGap = Math.max(maxGap, sample.atMs - previous);
      previous = sample.atMs;
      for (const field of [
        "heapUsed",
        "heapTotal",
        "workerdRss",
        "workerdHwm",
        "hostRss",
        "hostHwm",
      ] as const)
        try {
          assert.ok(Number.isSafeInteger(sample[field]) && sample[field] >= 0);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpr-check-022");
        }
      for (const field of ["backingStorage", "embedderHeap"] as const)
        try {
          assert.ok(
            sample[field] === null ||
              (Number.isSafeInteger(sample[field]) && sample[field]! >= 0),
          );
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpr-check-023");
        }
      try {
        assert.equal(sample.nativeExternal, null);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fpr-check-024");
      }
      try {
        assert.equal(sample.postgresRss, null);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fpr-check-025");
      }
    }
    try {
      assert.equal(value.maximumGapMs, maxGap);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-026");
    }
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fpr-stage-003");
  }
}
function closedLifecycle(snapshot: FailureLifecycleSnapshot) {
  try {
    keys(snapshot, [
      "kind",
      "scenario",
      "dispatches",
      "clients",
      "readers",
      "violations",
      "sequence",
    ]);
    try {
      assert.ok(
        Array.isArray(snapshot.dispatches) && snapshot.dispatches.length <= 4,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-027");
    }
    try {
      assert.ok(
        Array.isArray(snapshot.clients) && snapshot.clients.length <= 128,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-028");
    }
    try {
      assert.ok(
        Array.isArray(snapshot.readers) && snapshot.readers.length <= 40,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-029");
    }
    try {
      assert.deepEqual(snapshot.violations, []);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-030");
    }
    for (const dispatch of snapshot.dispatches) {
      keys(dispatch, ["ordinal", "finished", "messages"]);
      try {
        assert.ok(
          Array.isArray(dispatch.messages) && dispatch.messages.length <= 10,
        );
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fpr-check-031");
      }
      for (const message of dispatch.messages)
        keys(message, ["id", "wireSha256", "writerCalls"]);
    }
    for (const client of snapshot.clients) {
      keys(client, [
        "id",
        "helper",
        "messageId",
        "dispatch",
        "operations",
        "endEvents",
        "streamCloseEvents",
        "clientEnded",
        "streamDestroyed",
      ]);
      try {
        assert.ok(
          Array.isArray(client.operations) && client.operations.length <= 32,
        );
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fpr-check-032");
      }
      for (const operation of client.operations)
        keys(operation, [
          "method",
          "call",
          "settlement",
          "status",
          "sqlstate",
          "cancellationCause",
          "querySha256",
          "backendPid",
        ]);
    }
    const inflaterKeys = [
      "submitted",
      "consumed",
      "produced",
      "drained",
      "writes",
      "reads",
      "ends",
      "destroys",
      "queued",
      "destroyed",
    ];
    for (const reader of snapshot.readers) {
      keys(reader, [
        "id",
        "dispatch",
        "messageId",
        "wireSha256",
        "wireBytes",
        "headerBytes",
        "nextCalls",
        "pendingNext",
        "nextSettled",
        "nextDone",
        "nextRejected",
        "closes",
        "nativeEnds",
        "cancelCalls",
        "returnCalls",
        "cancel",
        "current",
        "advancementsAfterCancel",
      ]);
      keys(reader.current, inflaterKeys);
      if (reader.cancel) {
        keys(reader.cancel, [
          "sequence",
          "kind",
          "pendingNext",
          "before",
          "after",
        ]);
        keys(reader.cancel.before, inflaterKeys);
        if (reader.cancel.after) keys(reader.cancel.after, inflaterKeys);
      }
    }
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fpr-stage-004");
  }
}
const waiterKeys = [
  "pid",
  "database",
  "username",
  "query",
  "backend_start",
  "query_start",
  "query_age_ms",
  "state",
  "wait_event_type",
  "wait_event",
  "blockers",
  "transaction_id",
  "blocker_pid",
  "blocker_backend_start",
  "blocker_database",
  "blocker_username",
  "blocker_state",
];
/** Returns only verified native observations; parent independently matches guard events/bundle. */
export function validateFailurePrivateEvidence(
  input: unknown,
  publicInput: unknown,
): OwnerObservations[] {
  try {
    try {
      assertFailureReceipt(publicInput);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-033");
    }
    const receipt = input as FailurePrivateReceipt;
    keys(receipt, ["version", "phase", "cases"]);
    try {
      assert.equal(receipt.version, 1);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-034");
    }
    try {
      assert.equal(receipt.phase, publicInput.phase);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-035");
    }
    try {
      assert.ok(Array.isArray(receipt.cases));
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-036");
    }
    try {
      assert.equal(receipt.cases.length, publicInput.cases.length);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-037");
    }
    const observations: OwnerObservations[] = [];
    for (const [index, item] of receipt.cases.entries()) {
      const safe: FailureCaseReceipt = publicInput.cases[index]!;
      keys(item, ["scenario", "runtimes", "cancellation"]);
      try {
        assert.equal(item.scenario, safe.scenario);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fpr-check-038");
      }
      try {
        assert.ok(Array.isArray(item.runtimes));
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fpr-check-039");
      }
      try {
        assert.equal(item.runtimes.length, safe.runtimes.length);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fpr-check-040");
      }
      let target: { querySha256: string; backendPid: number } | undefined;
      if (item.scenario === "query-cancellation") {
        try {
          assert.ok(item.cancellation);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpr-check-041");
        }
        const cancellation = item.cancellation;
        keys(cancellation, [
          "holder",
          "initial",
          "revalidated",
          "signalResult",
        ]);
        keys(cancellation.holder, [
          "block",
          "pid",
          "backendStart",
          "transactionId",
        ]);
        for (const rows of [cancellation.initial, cancellation.revalidated]) {
          try {
            assert.ok(Array.isArray(rows));
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpr-check-042");
          }
          try {
            assert.equal(rows.length, 1);
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpr-check-043");
          }
          keys(rows[0], waiterKeys);
        }
        const first = validateFailureWaiter(
            cancellation.initial,
            cancellation.holder,
          ),
          current = validateFailureWaiter(
            cancellation.revalidated,
            cancellation.holder,
          );
        try {
          assertSameFailureWaiter(current, first);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpr-check-044");
        }
        try {
          assertCancellationResult(cancellation.signalResult, first);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpr-check-045");
        }
        try {
          assert.equal(
            cancellation.holder.block,
            receipt.phase === "uninstrumented" ? 9_300_011 : 9_400_011,
          );
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpr-check-046");
        }
        try {
          assert.ok(
            cancellation.revalidated[0]!.query_age_ms >=
              cancellation.initial[0]!.query_age_ms,
          );
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpr-check-047");
        }
        target = { querySha256: first.querySha256, backendPid: first.pid };
      } else
        try {
          assert.equal(item.cancellation, null);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpr-check-048");
        }
      for (const [runtimeIndex, runtime] of item.runtimes.entries()) {
        try {
          assert.equal(
            Object.hasOwn(runtime, "postExitDrain"),
            receipt.phase === "unfixed-instrumented",
          );
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpr-check-071");
        }
        keys(runtime, [
          "observation",
          "lifecycleSnapshots",
          ...(receipt.phase === "unfixed-instrumented"
            ? ["postExitDrain"]
            : []),
        ]);
        if (receipt.phase === "unfixed-instrumented") {
          const drain = runtime.postExitDrain!;
          keys(drain, [
            "boundary",
            "remainingWriterSessions",
            "stableZeroSamples",
          ]);
          // This schema is not proof of exit or ordering. The pinned live test
          // records it after observed exit; the caller revalidates native events.
          try {
            assert.equal(drain.boundary, "after-observed-native-exit");
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpr-check-072");
          }
          try {
            assert.equal(drain.remainingWriterSessions, 0);
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpr-check-073");
          }
          try {
            assert.equal(drain.stableZeroSamples, 2);
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpr-check-074");
          }
        }
        try {
          assert.ok(runtime.observation);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpr-check-049");
        }
        observation(
          runtime.observation,
          safe.runtimes[runtimeIndex]!,
          item.scenario,
        );
        observations.push(runtime.observation);
        try {
          assert.ok(Array.isArray(runtime.lifecycleSnapshots));
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpr-check-050");
        }
        const checkpoints =
          receipt.phase === "uninstrumented"
            ? []
            : item.scenario === "auth-rejection"
              ? [runtimeIndex === 0 ? "auth-rejection" : "auth-valid-control"]
              : item.scenario === "query-cancellation"
                ? ["query-failure", "query-replay"]
                : item.scenario === "decoder-refusal"
                  ? ["decoder-refusal", "decoder-subsequent"]
                  : ["auth-unfixed-control"];
        try {
          assert.deepEqual(
            runtime.lifecycleSnapshots.map((row) => row.checkpoint),
            checkpoints,
          );
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpr-check-051");
        }
        for (const [
          snapshotIndex,
          entry,
        ] of runtime.lifecycleSnapshots.entries()) {
          keys(entry, ["checkpoint", "snapshot"]);
          const snapshot = entry.snapshot;
          closedLifecycle(snapshot);
          const ids =
            item.scenario === "auth-rejection"
              ? [[runtimeIndex === 0 ? "failure-auth" : "control-auth"]]
              : item.scenario === "query-cancellation"
                ? [
                    ["failure-query", "neighbor-query"],
                    ["failure-query"],
                  ].slice(0, snapshotIndex + 1)
                : item.scenario === "decoder-refusal"
                  ? [
                      ["neighbor-before", "failure-decoder", "neighbor-after"],
                      ["neighbor-later"],
                    ].slice(0, snapshotIndex + 1)
                  : [["failure-auth-unfixed"]];
          try {
            assert.deepEqual(
              snapshot.dispatches.map((dispatch) =>
                dispatch.messages.map((message) => message.id),
              ),
              ids,
            );
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpr-check-052");
          }
          const names =
            item.scenario === "auth-rejection"
              ? ["failure-auth", "control-auth"]
              : item.scenario === "query-cancellation"
                ? ["failure-query", "neighbor-query"]
                : item.scenario === "decoder-refusal"
                  ? [
                      "neighbor-before",
                      "failure-decoder",
                      "neighbor-after",
                      "neighbor-later",
                    ]
                  : ["failure-auth-unfixed"];
          for (const dispatch of snapshot.dispatches)
            for (const message of dispatch.messages) {
              try {
                assert.equal(
                  message.wireSha256,
                  safe.bodySha256[names.indexOf(message.id)],
                );
              } catch (failureReplayError) {
                throw failureReplayFailure(failureReplayError, "fpr-check-053");
              }
              try {
                assert.equal(
                  message.writerCalls,
                  message.id === "failure-decoder" ? 0 : 1,
                );
              } catch (failureReplayError) {
                throw failureReplayFailure(failureReplayError, "fpr-check-054");
              }
            }
          if (entry.checkpoint === "auth-rejection")
            try {
              assertFailureAuthLifecycle(snapshot);
            } catch (failureReplayError) {
              throw failureReplayFailure(failureReplayError, "fpr-check-055");
            }
          else if (entry.checkpoint === "auth-valid-control")
            try {
              assertFailureSuccessfulLifecycle(snapshot, "auth-rejection");
            } catch (failureReplayError) {
              throw failureReplayFailure(failureReplayError, "fpr-check-056");
            }
          else if (entry.checkpoint === "auth-unfixed-control")
            try {
              assert.deepEqual(
                assertFailureUnfixedAuthControl(snapshot),
                safe.negativeControl,
              );
            } catch (failureReplayError) {
              throw failureReplayFailure(failureReplayError, "fpr-check-057");
            }
          else if (item.scenario === "query-cancellation") {
            try {
              assert.ok(target);
            } catch (failureReplayError) {
              throw failureReplayFailure(failureReplayError, "fpr-check-058");
            }
            try {
              assertFailureQueryLifecycle(snapshot, target);
            } catch (failureReplayError) {
              throw failureReplayFailure(failureReplayError, "fpr-check-059");
            }
          } else {
            try {
              assertFailureDecoderLifecycle(snapshot);
            } catch (failureReplayError) {
              throw failureReplayFailure(failureReplayError, "fpr-check-060");
            }
            try {
              assertFailureSuccessfulLifecycle(snapshot, "decoder-refusal");
            } catch (failureReplayError) {
              throw failureReplayFailure(failureReplayError, "fpr-check-061");
            }
          }
        }
      }
    }
    try {
      assert.equal(
        new Set(
          observations.map(
            (row) =>
              `${row.hostPid}:${row.runtimePid}:${row.runtimeStartTicks}`,
          ),
        ).size,
        observations.length,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-062");
    }
    return observations;
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fpr-stage-005");
  }
}
/** Byte-exact source-map association, including optional transformed helpers if retained. */
export function assertFailureSupplementalSourceMaps(
  maps: unknown[],
  sources: Record<string, string>,
) {
  try {
    const required = [
      "workers/data-api.ts",
      "src/pg-sql.ts",
      "src/strict-gzip-reader.ts",
      "tests/qualification/strict-gzip/failure-lifecycle-observer.ts",
      "src/lane-health-store.ts",
    ];
    const optional = ["src/read-store.ts"];
    keys(sources, [...required, ...optional]);
    try {
      assert.ok(Array.isArray(maps) && maps.length >= 1 && maps.length <= 256);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fpr-check-063");
    }
    const counts = new Map(
      [...required, ...optional].map((source) => [source, 0]),
    );
    for (const raw of maps) {
      const map = raw as any;
      try {
        assert.ok(
          map &&
            Array.isArray(map.sources) &&
            Array.isArray(map.sourcesContent),
        );
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fpr-check-064");
      }
      try {
        assert.equal(map.sources.length, map.sourcesContent.length);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fpr-check-065");
      }
      try {
        assert.ok(map.sources.length <= 8192);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fpr-check-066");
      }
      const seen = new Set<string>();
      map.sources.forEach((source: unknown, index: number) => {
        try {
          try {
            assert.equal(typeof source, "string");
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpr-check-067");
          }
          const name = (source as string).replaceAll("\\", "/");
          try {
            assert.ok(!seen.has(name));
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fpr-check-068");
          }
          seen.add(name);
          for (const logical of counts.keys())
            if (name === logical || name.endsWith("/" + logical)) {
              try {
                assert.equal(map.sourcesContent[index], sources[logical]);
              } catch (failureReplayError) {
                throw failureReplayFailure(failureReplayError, "fpr-check-069");
              }
              counts.set(logical, counts.get(logical)! + 1);
            }
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fpr-stage-007");
        }
      });
    }
    for (const logical of required)
      try {
        assert.ok(
          counts.get(logical)! >= 1,
          "Required supplemental source association missing",
        );
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fpr-check-070");
      }
    return [...counts].map(([source, associations]) => ({
      source,
      associations,
    }));
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fpr-stage-006");
  }
}
