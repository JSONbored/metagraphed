import {
  failureReplayFailure,
  withFailureReplayReason,
  withFailureReplayReasonAsync,
} from "./failure-replay-diagnostics.ts";
// Host-side oracles. Success here is supplemental only: source/build custody,
// functional queue outcomes, database rows and controller identity are separate.
import assert from "node:assert/strict";
import type {
  FailureLifecycleSnapshot,
  PgObservation,
  ReaderObservation,
} from "./failure-lifecycle-observer.ts";
const MAX_DECODED = 79_393_024;
function base(value: FailureLifecycleSnapshot, scenario: string) {
  try {
    try {
      assert.equal(value.kind, "supplemental-source-bound-lifecycle-v1");
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-001");
    }
    try {
      assert.equal(value.scenario, scenario);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-002");
    }
    try {
      assert.deepEqual(value.violations, []);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-003");
    }
    try {
      assert.ok(value.dispatches.length >= 1 && value.dispatches.length <= 4);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-004");
    }
    for (const [index, dispatch] of value.dispatches.entries()) {
      try {
        assert.equal(dispatch.ordinal, index + 1);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-005");
      }
      try {
        assert.equal(
          dispatch.finished,
          true,
          "Real owner handler remains unsettled",
        );
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-006");
      }
      try {
        assert.ok(dispatch.messages.length <= 10);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-007");
      }
      try {
        assert.equal(
          new Set(dispatch.messages.map((row) => row.id)).size,
          dispatch.messages.length,
        );
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-008");
      }
    }
    try {
      assert.ok(value.clients.length <= 128 && value.readers.length <= 40);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-009");
    }
    try {
      assert.ok(Number.isSafeInteger(value.sequence) && value.sequence >= 0);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-010");
    }
    const sequence = new Set<number>();
    for (const [index, client] of value.clients.entries()) {
      try {
        assert.equal(client.id, index + 1);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-011");
      }
      try {
        assert.equal(
          client.messageId,
          null,
          "Unproven asynchronous message attribution",
        );
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-012");
      }
      try {
        assert.equal(
          client.dispatch,
          null,
          "Unproven asynchronous dispatch attribution",
        );
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-013");
      }
      try {
        assert.ok(
          ["createPgSql", "pgReadStore", "pgLaneHealthDb"].includes(
            client.helper,
          ),
        );
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-014");
      }
      try {
        assert.ok(
          client.operations.length > 0 && client.operations.length <= 32,
        );
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-015");
      }
      for (const op of client.operations) {
        try {
          assert.ok(["connect", "query", "end"].includes(op.method));
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fla-check-016");
        }
        try {
          assert.ok(
            ["fulfilled", "rejected"].includes(op.status),
            "Missing real Promise settlement",
          );
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fla-check-017");
        }
        for (const at of [op.call, op.settlement]) {
          try {
            assert.ok(
              Number.isSafeInteger(at) && at! > 0 && at! <= value.sequence,
            );
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fla-check-018");
          }
          try {
            assert.ok(!sequence.has(at!));
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fla-check-019");
          }
          sequence.add(at!);
        }
        try {
          assert.ok(op.settlement! > op.call);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fla-check-020");
        }
        try {
          assert.ok(op.sqlstate === null || /^[0-9A-Z]{5}$/.test(op.sqlstate));
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fla-check-021");
        }
        try {
          assert.ok(
            op.cancellationCause === null ||
              ["user-request", "statement-timeout", "other"].includes(
                op.cancellationCause,
              ),
          );
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fla-check-022");
        }
        try {
          assert.ok(
            op.querySha256 === null || /^[a-f0-9]{64}$/.test(op.querySha256),
          );
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fla-check-023");
        }
      }
    }
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fla-stage-001");
  }
}
function teardown(client: PgObservation) {
  try {
    const ends = client.operations.filter((op) => op.method === "end");
    try {
      assert.equal(
        ends.length,
        1,
        "Each actual constructed client must receive exactly one end call",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-024");
    }
    try {
      assert.equal(
        ends[0]!.status,
        "fulfilled",
        "Hidden end rejection cannot qualify teardown",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-025");
    }
    try {
      assert.equal(ends[0]!.sqlstate, null);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-026");
    }
    try {
      assert.equal(
        client.clientEnded,
        true,
        "Actual pg connection end has not settled",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-027");
    }
    // pg-cloudflare end() closes its native Socket without setting destroyed.
    // Require its real close event; destroyed alone is neither necessary nor enough.
    try {
      assert.equal(
        client.streamCloseEvents,
        1,
        "Actual native transport close missing or duplicated",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-028");
    }
    try {
      assert.equal(
        client.endEvents,
        1,
        "Actual pg end event missing or duplicated",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-029");
    }
    return ends[0]!;
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fla-stage-002");
  }
}
export function assertFailureAuthLifecycle(
  snapshot: FailureLifecycleSnapshot,
  requiredHelpers: readonly string[] = ["createPgSql"],
) {
  try {
    base(snapshot, "auth-rejection");
    try {
      assert.equal(
        snapshot.dispatches.length,
        1,
        "Bad authentication is immutable per isolate",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-030");
    }
    try {
      assert.ok(
        snapshot.clients.length > 0,
        "Missing real authentication witness",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-031");
    }
    for (const helper of requiredHelpers)
      try {
        assert.ok(snapshot.clients.some((client) => client.helper === helper));
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-032");
      }
    for (const client of snapshot.clients) {
      const connects = client.operations.filter(
        (op) => op.method === "connect",
      );
      try {
        assert.equal(connects.length, 1);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-033");
      }
      try {
        assert.equal(connects[0]!.status, "rejected");
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-034");
      }
      try {
        assert.equal(
          connects[0]!.sqlstate,
          "28P01",
          "Wrong or absent real driver authentication SQLSTATE",
        );
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-035");
      }
      try {
        assert.equal(
          client.operations.filter((op) => op.method === "query").length,
          0,
          "Query after failed connect",
        );
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-036");
      }
      try {
        assert.ok(teardown(client).call > connects[0]!.settlement!);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-037");
      }
    }
    return {
      clients: snapshot.clients.length,
      rejectedConnects: snapshot.clients.length,
      settledEnds: snapshot.clients.length,
    };
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fla-stage-003");
  }
}
// Only for the independently pinned pre-fix source root. The native case must
// bind those original/derived bytes separately; caller-supplied snapshots alone
// can never establish that source identity.
export function assertFailureUnfixedAuthControl(
  snapshot: FailureLifecycleSnapshot,
) {
  try {
    base(snapshot, "auth-rejection");
    try {
      assert.equal(snapshot.dispatches.length, 1);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-038");
    }
    try {
      assert.ok(snapshot.clients.length > 0);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-039");
    }
    try {
      assert.ok(
        snapshot.clients.some((client) => client.helper === "createPgSql"),
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-040");
    }
    for (const client of snapshot.clients) {
      try {
        assert.equal(
          client.operations.length,
          1,
          "Unfixed control requires zero query and zero end calls",
        );
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-041");
      }
      const connect = client.operations[0]!;
      try {
        assert.equal(connect.method, "connect");
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-042");
      }
      try {
        assert.equal(connect.status, "rejected");
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-043");
      }
      try {
        assert.equal(connect.sqlstate, "28P01");
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-044");
      }
      try {
        assert.equal(client.clientEnded, true);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-045");
      }
      try {
        assert.equal(client.endEvents, 1);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-046");
      }
      try {
        assert.equal(client.streamCloseEvents, 1);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-047");
      }
    }
    try {
      assert.throws(
        () => assertFailureAuthLifecycle(snapshot),
        /Each actual constructed client must receive exactly one end call/,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-048");
    }
    return {
      clients: snapshot.clients.length,
      rejectedConnects: snapshot.clients.length,
      observedEndCalls: 0,
      fixedLifecycleOracle: "rejected-missing-end" as const,
    };
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fla-stage-004");
  }
}
export function assertFailureQueryLifecycle(
  snapshot: FailureLifecycleSnapshot,
  target: { querySha256: string; backendPid: number },
) {
  try {
    base(snapshot, "query-cancellation");
    try {
      assert.match(target.querySha256, /^[a-f0-9]{64}$/);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-049");
    }
    try {
      assert.ok(
        Number.isSafeInteger(target.backendPid) && target.backendPid > 0,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-050");
    }
    try {
      assert.ok(snapshot.clients.length > 0);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-051");
    }
    const rejected = snapshot.clients.flatMap((client) =>
      client.operations
        .filter((op) => op.method === "query" && op.status === "rejected")
        .map((operation) => ({ client, operation })),
    );
    try {
      assert.equal(
        rejected.length,
        1,
        "Exactly one actual query rejection is required",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-052");
    }
    const { client: targetClient, operation } = rejected[0]!;
    try {
      assert.equal(
        operation.sqlstate,
        "57014",
        "Signal delivery alone is insufficient",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-053");
    }
    try {
      assert.equal(
        operation.cancellationCause,
        "user-request",
        "A natural timeout cannot qualify requested cancellation",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-054");
    }
    try {
      assert.equal(operation.querySha256, target.querySha256);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-055");
    }
    try {
      assert.equal(
        operation.backendPid,
        target.backendPid,
        "Actual pg client PID must match controller witness",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-056");
    }
    for (const client of snapshot.clients) {
      const connects = client.operations.filter(
        (op) => op.method === "connect",
      );
      try {
        assert.equal(connects.length, 1);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-057");
      }
      try {
        assert.equal(connects[0]!.status, "fulfilled");
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-058");
      }
      const end = teardown(client);
      for (const query of client.operations.filter(
        (op) => op.method === "query",
      )) {
        try {
          assert.ok(query.call > connects[0]!.settlement!);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fla-check-059");
        }
        try {
          assert.ok(end.call > query.settlement!);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fla-check-060");
        }
        if (query !== operation)
          try {
            assert.equal(query.status, "fulfilled");
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fla-check-061");
          }
      }
    }
    try {
      assert.ok(teardown(targetClient).call > operation.settlement!);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-062");
    }
    return {
      clients: snapshot.clients.length,
      targetedQueryRejections: 1,
      settledEnds: snapshot.clients.length,
    };
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fla-stage-005");
  }
}
export function assertFailureSuccessfulLifecycle(
  snapshot: FailureLifecycleSnapshot,
  scenario = "auth-rejection",
) {
  try {
    base(snapshot, scenario);
    try {
      assert.ok(
        snapshot.clients.length > 0,
        "Missing actual successful-client control",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-063");
    }
    try {
      assert.ok(
        snapshot.dispatches.some((dispatch) =>
          dispatch.messages.some((message) => message.writerCalls === 1),
        ),
        "Missing actual successful writer boundary",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-064");
    }
    let queryCount = 0;
    for (const client of snapshot.clients) {
      const connects = client.operations.filter(
        (op) => op.method === "connect",
      );
      try {
        assert.equal(connects.length, 1);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-065");
      }
      try {
        assert.equal(connects[0]!.status, "fulfilled");
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-066");
      }
      const queries = client.operations.filter((op) => op.method === "query");
      try {
        assert.ok(queries.length > 0);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-check-067");
      }
      queryCount += queries.length;
      const end = teardown(client);
      for (const operation of client.operations) {
        try {
          assert.equal(operation.status, "fulfilled");
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fla-check-068");
        }
        try {
          assert.equal(operation.sqlstate, null);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fla-check-069");
        }
        try {
          assert.equal(operation.cancellationCause, null);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fla-check-070");
        }
      }
      for (const query of queries) {
        try {
          assert.ok(query.call > connects[0]!.settlement!);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fla-check-071");
        }
        try {
          assert.ok(end.call > query.settlement!);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fla-check-072");
        }
      }
    }
    return {
      clients: snapshot.clients.length,
      successfulQueries: queryCount,
      settledEnds: snapshot.clients.length,
    };
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fla-stage-006");
  }
}
function stopped(reader: ReaderObservation) {
  try {
    try {
      assert.ok(reader.cancel, "Missing actual reader cancellation call");
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-073");
    }
    try {
      assert.ok(reader.cancel.after, "Cancellation never returned");
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-074");
    }
    try {
      assert.equal(
        reader.cancel.before.destroyed,
        false,
        "An already destroyed inflater cannot qualify refusal cancellation",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-075");
    }
    try {
      assert.equal(
        reader.cancel.after.destroyed,
        true,
        "Cancellation did not synchronously destroy the actual inflater",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-076");
    }
    try {
      assert.ok(reader.cancel.after.destroys > reader.cancel.before.destroys);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-077");
    }
    try {
      assert.equal(reader.current.destroyed, true);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-078");
    }
    try {
      assert.equal(
        reader.closes,
        1,
        "Actual inflater close missing or duplicated",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-079");
    }
    try {
      assert.equal(
        reader.pendingNext,
        0,
        "A real next Promise remains pending",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-080");
    }
    try {
      assert.equal(reader.nextSettled, reader.nextCalls);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-081");
    }
    try {
      assert.equal(reader.nextRejected, 0);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-082");
    }
    try {
      assert.equal(reader.advancementsAfterCancel, 0);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-083");
    }
    for (const later of [reader.cancel.after, reader.current])
      for (const key of [
        "submitted",
        "consumed",
        "produced",
        "drained",
        "writes",
        "reads",
        "ends",
      ] as const)
        try {
          assert.equal(
            later[key],
            reader.cancel.before[key],
            `Inflater ${key} advanced after cancellation`,
          );
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fla-check-084");
        }
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fla-stage-007");
  }
}
export function assertFailureDecoderLifecycle(
  snapshot: FailureLifecycleSnapshot,
) {
  try {
    base(snapshot, "decoder-refusal");
    try {
      assertFailureSuccessfulLifecycle(snapshot, "decoder-refusal");
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-085");
    }
    const candidates = snapshot.readers.filter((reader) => {
      try {
        const dispatch = snapshot.dispatches[reader.dispatch - 1];
        const message = dispatch?.messages.find(
          (row) => row.id === reader.messageId,
        );
        return message?.writerCalls === 0;
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fla-stage-009");
      }
    });
    try {
      assert.equal(
        candidates.length,
        1,
        "One explicit message-scoped refused reader is required",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-086");
    }
    const refused = candidates[0]!;
    const dispatch = snapshot.dispatches[refused.dispatch - 1]!;
    const message = dispatch.messages.find(
      (row) => row.id === refused.messageId,
    )!;
    try {
      assert.ok(refused.messageId && message.wireSha256 === refused.wireSha256);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-087");
    }
    try {
      assert.equal(
        message.writerCalls,
        0,
        "Refused message crossed the real writer boundary",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-088");
    }
    try {
      assert.ok(refused.cancelCalls > 0);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-089");
    }
    stopped(refused);
    try {
      assert.ok(refused.cancel!.before.drained > MAX_DECODED);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-090");
    }
    try {
      assert.ok(refused.cancel!.before.drained <= MAX_DECODED + 8192);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-091");
    }
    try {
      assert.equal(
        refused.nativeEnds,
        0,
        "Refusal must precede native completion and bad-trailer validation",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-092");
    }
    try {
      assert.ok(
        refused.current.consumed + refused.headerBytes < refused.wireBytes - 8,
        "No unread compressed tail witness",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-093");
    }
    try {
      assert.ok(
        dispatch.messages.filter((row) => row.writerCalls === 1).length >= 2,
        "Missing real good-neighbor writer calls",
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fla-check-094");
    }
    return {
      readers: snapshot.readers.length,
      refusedReaders: 1,
      refusedWriterCalls: 0,
      settledPendingReads: refused.nextSettled,
    };
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fla-stage-008");
  }
}
