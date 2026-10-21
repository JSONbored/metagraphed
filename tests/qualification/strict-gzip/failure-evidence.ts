import {
  failureReplayFailure,
  withFailureReplayReason,
  withFailureReplayReasonAsync,
} from "./failure-replay-diagnostics.ts";
// Private proof replay for additional phases. Every published field is rebuilt
// from bounded fixed-schema evidence; original baseline validators are unchanged.
import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { boundedFile } from "./receipt-files.ts";
import {
  RAW_LIMITS,
  processChildGuardEvidence,
  threadLifecycleEvidence,
  nativeUnobservedExitCount,
} from "./receipt-policy.ts";
import {
  OWNER_BUILD_LIMITS,
  boundedBuildFile,
  runnerRuntimeIdentity,
  validateOwnerBuild,
} from "./owner-build-evidence.ts";
import { readOwnerNativeEvidence } from "./owner-native-evidence.ts";
import { validateServiceReceipt } from "./owner-service.ts";
import { assertFailureReceipt } from "./failure-postgres-policy.ts";
import {
  FAILURE_PRIVATE_MAX_BYTES,
  validateFailurePrivateEvidence,
  assertFailureSupplementalSourceMaps,
} from "./failure-postgres-private.ts";
import { validateFailureTestEvidence } from "./failure-test-evidence.ts";
import { type FailurePhase } from "./failure-variants.ts";
const extraFiles = {
  "owner-service.json": 65536,
  "owner-queue-failure.json": 65536,
  "owner-queue-failure-private.json": FAILURE_PRIVATE_MAX_BYTES,
} as const;
export function validateFailureReceiptDirectory(run: string) {
  try {
    const stat = withFailureReplayReason("fev-io-001", () => lstatSync(run));
    try {
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-001");
    }
    const canonical = withFailureReplayReason("fev-io-002", () =>
      realpathSync(run),
    );
    const entries = withFailureReplayReason("fev-io-003", () =>
      readdirSync(run, { withFileTypes: true }),
    );
    try {
      assert.ok(entries.length <= Object.keys(RAW_LIMITS).length + 4);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-002");
    }
    for (const entry of entries) {
      const full = path.join(run, entry.name);
      try {
        assert.ok(!entry.isSymbolicLink());
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-003");
      }
      try {
        assert.ok(
          withFailureReplayReason("fev-io-004", () =>
            realpathSync(full),
          ).startsWith(canonical + path.sep),
        );
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-004");
      }
      if (entry.name === "owner-builds") {
        try {
          assert.ok(entry.isDirectory());
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fev-check-005");
        }
        const owners = withFailureReplayReason("fev-io-005", () =>
          readdirSync(full, { withFileTypes: true }),
        );
        try {
          assert.equal(owners.length, 1);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fev-check-006");
        }
        try {
          assert.equal(owners[0]!.name, "queue");
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fev-check-007");
        }
        try {
          assert.ok(owners[0]!.isDirectory() && !owners[0]!.isSymbolicLink());
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fev-check-008");
        }
        const build = path.join(full, "queue"),
          files = withFailureReplayReason("fev-io-006", () =>
            readdirSync(build, { withFileTypes: true }),
          );
        try {
          assert.ok(
            files.length >= 2 && files.length <= OWNER_BUILD_LIMITS.files,
          );
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fev-check-009");
        }
        let total = 0;
        for (const file of files) {
          try {
            assert.ok(file.isFile() && !file.isSymbolicLink());
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fev-check-010");
          }
          try {
            assert.ok(
              file.name === "manifest.json" ||
                file.name === "association.bin" ||
                /^module-\d{3}\.bin$/.test(file.name),
            );
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fev-check-011");
          }
          const limit =
            file.name === "manifest.json"
              ? OWNER_BUILD_LIMITS.manifestBytes
              : file.name === "association.bin"
                ? OWNER_BUILD_LIMITS.associationBytes
                : OWNER_BUILD_LIMITS.moduleBytes;
          const bytes = withFailureReplayReason("fev-io-007", () =>
            boundedBuildFile(path.join(build, file.name), limit),
          );
          total += bytes.length;
          try {
            assert.ok(
              total <=
                OWNER_BUILD_LIMITS.totalBytes +
                  OWNER_BUILD_LIMITS.manifestBytes,
            );
          } catch (failureReplayError) {
            throw failureReplayFailure(failureReplayError, "fev-check-012");
          }
        }
      } else {
        try {
          assert.ok(entry.isFile());
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fev-check-013");
        }
        const limit = Object.hasOwn(extraFiles, entry.name)
          ? extraFiles[entry.name as keyof typeof extraFiles]
          : RAW_LIMITS[entry.name as keyof typeof RAW_LIMITS];
        try {
          assert.ok(Number.isSafeInteger(limit));
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fev-check-014");
        }
        try {
          assert.ok(!entry.name.includes("/"));
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fev-check-015");
        }
        withFailureReplayReason("fev-io-008", () => boundedFile(full, limit));
      }
    }
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fev-stage-001");
  }
}
export interface FailureGuardContext {
  vitest: string;
  worker: string;
  wranglerBin: string;
  wranglerCli: string;
}
export function validateFailureGuardEvidence(
  events: any[],
  context: FailureGuardContext,
) {
  try {
    try {
      assert.ok(
        Array.isArray(events) && events.length > 0 && events.length <= 100000,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-016");
    }
    try {
      assert.equal(events.filter((event) => event.kind === "denied").length, 0);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-017");
    }
    try {
      assert.equal(
        withFailureReplayReason("fev-io-009", () =>
          processChildGuardEvidence(events),
        ),
        true,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-018");
    }
    const starts = events.filter((event) => event.kind === "guard-start");
    try {
      assert.equal(starts.length, 4);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-019");
    }
    try {
      assert.ok(starts.every((event) => event.threadId === 0));
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-020");
    }
    // The unchanged preload installs its generic exit listener in every isolate.
    // Only main-thread records prove process exit; optional Worker records are
    // correlated separately after the mandatory actual Worker lifecycle replay.
    const guardExits = events.filter((event) => event.kind === "guard-exit");
    try {
      assert.ok(
        guardExits.every(
          (event) =>
            Number.isSafeInteger(event.threadId) &&
            event.threadId >= 0 &&
            event.threadId <= 2_147_483_647,
        ),
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-021");
    }
    try {
      assert.equal(
        guardExits.filter((event) => event.threadId === 0).length,
        4,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-022");
    }
    try {
      assert.equal(
        events.filter((event) => event.kind === "node-child-exit").length,
        3,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-023");
    }

    const children = events.filter((event) => event.kind === "node-child");
    try {
      assert.equal(children.length, 3);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-024");
    }
    try {
      assert.equal(new Set(children.map((event) => event.launchId)).size, 3);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-025");
    }
    try {
      assert.equal(new Set(children.map((event) => event.childPid)).size, 3);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-026");
    }
    const roles = [
      [context.vitest, "coordinator"],
      [context.worker, "test-worker"],
      [context.wranglerBin, "wrangler-bin"],
      [context.wranglerCli, "wrangler-cli"],
    ] as const;
    try {
      assert.equal(new Set(roles.map(([entry]) => entry)).size, 4);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-027");
    }
    for (const [entry, role] of roles) {
      try {
        assert.ok(path.isAbsolute(entry));
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-028");
      }
      const starts = events.filter(
        (event) =>
          event.kind === "guard-start" &&
          event.threadId === 0 &&
          event.realEntry === entry,
      );
      try {
        assert.equal(starts.length, 1);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-029");
      }
      const start = starts[0];
      try {
        assert.equal(start.role, role);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-030");
      }
      try {
        assert.ok(Number.isSafeInteger(start.pid) && start.pid > 0);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-031");
      }
      const exits = events.filter(
        (event) =>
          event.kind === "guard-exit" &&
          event.threadId === 0 &&
          event.pid === start.pid &&
          event.realEntry === entry,
      );
      try {
        assert.equal(exits.length, 1);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-032");
      }
      try {
        assert.ok(events.indexOf(start) < events.indexOf(exits[0]));
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-033");
      }
      try {
        assert.equal(exits[0].denied, 0);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-034");
      }
      try {
        assert.equal(exits[0].threadFailed, false);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-035");
      }
    }

    const startFor = (entry: string) =>
      events.find(
        (event) =>
          event.kind === "guard-start" &&
          event.threadId === 0 &&
          event.realEntry === entry,
      );
    for (const [parentEntry, childEntry, role] of [
      [context.vitest, context.worker, "test-worker"],
      [context.worker, context.wranglerBin, "wrangler-bin"],
      [context.wranglerBin, context.wranglerCli, "wrangler-cli"],
    ]) {
      const parent = startFor(parentEntry!),
        child = startFor(childEntry!);
      const launches = children.filter((event) => event.childPid === child.pid);
      try {
        assert.equal(launches.length, 1);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-036");
      }
      const launch = launches[0];
      try {
        assert.equal(launch.pid, parent.pid);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-037");
      }
      try {
        assert.equal(launch.threadId, 0);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-038");
      }
      try {
        assert.equal(launch.role, role);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-039");
      }
      try {
        assert.equal(launch.synchronous, false);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-040");
      }
      try {
        assert.match(launch.launchId, new RegExp(`^${parent.pid}:\\d+$`));
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-041");
      }
      try {
        assert.ok(events.indexOf(parent) < events.indexOf(launch));
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-042");
      }
      const exits = events.filter(
        (event) =>
          event.kind === "node-child-exit" &&
          event.launchId === launch.launchId,
      );
      try {
        assert.equal(exits.length, 1);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-043");
      }
      const exit = exits[0];
      for (const key of ["pid", "threadId", "role", "childPid", "synchronous"])
        try {
          assert.equal(exit[key], launch[key]);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fev-check-044");
        }
      try {
        assert.equal(exit.observation, "exit-event");
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-045");
      }
      try {
        assert.ok(events.indexOf(launch) < events.indexOf(exit));
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-046");
      }
      try {
        assert.ok(events.indexOf(child) < events.indexOf(exit));
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-047");
      }
      try {
        assert.equal(exit.signal, null);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-048");
      }
      if (role === "test-worker" && exit.code === 143) {
        const signals = events.filter(
          (event) =>
            event.kind === "guard-signal" &&
            event.pid === child.pid &&
            event.threadId === 0 &&
            event.realEntry === childEntry,
        );
        try {
          assert.equal(signals.length, 1);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fev-check-049");
        }
        try {
          assert.equal(signals[0].signal, "SIGTERM");
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fev-check-050");
        }
        try {
          assert.equal(signals[0].exitCode, 143);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fev-check-051");
        }
        try {
          assert.ok(
            events.indexOf(child) < events.indexOf(signals[0]) &&
              events.indexOf(signals[0]) < events.indexOf(exit),
          );
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fev-check-052");
        }
      } else
        try {
          assert.equal(exit.code, 0);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fev-check-053");
        }
    }

    const workerExit = events.find(
      (event) =>
        event.kind === "node-child-exit" && event.role === "test-worker",
    );
    try {
      assert.equal(
        events.filter((event) => event.kind === "guard-signal").length,
        workerExit.code === 143 ? 1 : 0,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-054");
    }
    const threads = withFailureReplayReason("fev-io-010", () =>
      threadLifecycleEvidence(events),
    );
    try {
      assert.equal(threads.everyThreadGuarded, true);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-055");
    }
    // Subprocesses remain forbidden inside Workers. A zero exit counter must not
    // hide even a fully paired native launch/exit written from a thread.
    for (const kind of [
      "native-child",
      "native-child-exit",
      "native-child-close",
    ])
      try {
        assert.ok(
          events
            .filter((event) => event.kind === kind)
            .every((event) => event.threadId === 0),
        );
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-056");
      }
    const seenThreadExits = new Set<string>();
    for (const exit of guardExits.filter((event) => event.threadId > 0)) {
      const matchingStarts = events.filter(
        (event) =>
          event.kind === "thread-guard-start" &&
          event.pid === exit.pid &&
          event.threadId === exit.threadId,
      );
      try {
        assert.equal(matchingStarts.length, 1);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-057");
      }
      const start = matchingStarts[0];
      const identity = `${exit.pid}:${exit.threadId}`;
      try {
        assert.equal(seenThreadExits.has(identity), false);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-058");
      }
      seenThreadExits.add(identity);
      try {
        assert.ok(Number.isSafeInteger(start.ppid) && start.ppid > 0);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-059");
      }
      try {
        assert.equal(typeof start.entry, "string");
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-060");
      }
      try {
        assert.equal(start.realEntry, "");
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-061");
      }
      try {
        assert.equal(exit.ppid, start.ppid);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-062");
      }
      try {
        assert.equal(exit.entry, start.entry);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-063");
      }
      try {
        assert.equal(exit.realEntry, "");
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-064");
      }
      try {
        assert.equal(exit.denied, 0);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-065");
      }
      try {
        assert.equal(exit.threadFailed, false);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-066");
      }
      try {
        assert.equal(exit.unobservedNativeExits, 0);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-067");
      }
      const ready = events.find(
        (event) =>
          event.kind === "thread-ready" &&
          event.threadLaunchId === start.threadLaunchId,
      );
      const actualExit = events.find(
        (event) =>
          event.kind === "thread-exit" &&
          event.threadLaunchId === start.threadLaunchId,
      );
      // These identities and uniqueness already passed threadLifecycleEvidence.
      // The generic isolate receipt cannot replace the parent's actual exit.
      try {
        assert.equal(actualExit.pid, exit.pid);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-068");
      }
      try {
        assert.equal(actualExit.ownerPid, exit.pid);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-069");
      }
      try {
        assert.equal(actualExit.targetThreadId, exit.threadId);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-070");
      }
      try {
        assert.equal(actualExit.threadId, 0);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-071");
      }
      try {
        assert.ok(events.indexOf(start) < events.indexOf(exit));
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-072");
      }
      try {
        assert.ok(events.indexOf(ready) < events.indexOf(exit));
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-073");
      }
      try {
        assert.ok(events.indexOf(exit) < events.indexOf(actualExit));
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-074");
      }
      // Do not order this against the parent's handshake: natural completion can
      // race that write after thread-ready; the actual exit must still follow it.
    }
    try {
      assert.equal(
        events.filter(
          (event) =>
            event.kind === "wrangler-child-preload" && event.threadId === 0,
        ).length,
        1,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-075");
    }
    return {
      ...threads,
      unobservedNativeExits: withFailureReplayReason("fev-io-011", () =>
        nativeUnobservedExitCount(events),
      ),
    };
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fev-stage-002");
  }
}
async function supplementalMaps(run: string, root: string) {
  try {
    const directory = path.join(run, "owner-builds/queue");
    const upload = withFailureReplayReason("fev-io-012", () =>
      boundedBuildFile(
        path.join(directory, "association.bin"),
        OWNER_BUILD_LIMITS.associationBytes,
      ),
    );
    const boundaryEnd = upload.indexOf("\r\n");
    try {
      assert.ok(boundaryEnd > 2 && boundaryEnd < 200);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-076");
    }
    const first = upload.subarray(0, boundaryEnd).toString();
    try {
      assert.match(first, /^--[-A-Za-z0-9]+$/);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-077");
    }
    const form = await new Response(new Uint8Array(upload).buffer, {
      headers: {
        "Content-Type": `multipart/form-data; boundary=${first.slice(2)}`,
      },
    }).formData();
    const maps: unknown[] = [];
    for (const [, value] of form)
      if (typeof value !== "string" && value.type === "application/source-map")
        maps.push(JSON.parse(await value.text()));
    const sources: Record<string, string> = {};
    for (const logical of [
      "workers/data-api.ts",
      "src/pg-sql.ts",
      "src/lane-health-store.ts",
      "src/read-store.ts",
      "src/strict-gzip-reader.ts",
      "tests/qualification/strict-gzip/failure-lifecycle-observer.ts",
    ]) {
      const file = path.join(root, logical);
      try {
        assert.equal(
          withFailureReplayReason("fev-io-013", () => realpathSync(file)),
          file,
        );
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-078");
      }
      sources[logical] = withFailureReplayReason("fev-io-014", () =>
        boundedFile(file, 1024 * 1024),
      ).toString();
    }
    try {
      assertFailureSupplementalSourceMaps(maps, sources);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-079");
    }
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fev-stage-003");
  }
}
export async function validateFailurePhaseEvidence(
  run: string,
  root: string,
  phase: FailurePhase,
) {
  try {
    validateFailureReceiptDirectory(run);
    withFailureReplayReason("fev-io-015", () =>
      validateServiceReceipt(
        withFailureReplayReason("fev-io-016", () =>
          JSON.parse(
            withFailureReplayReason("fev-io-017", () =>
              boundedFile(path.join(run, "owner-service.json"), 65536),
            ).toString(),
          ),
        ),
      ),
    );
    const tests = validateFailureTestEvidence(
      withFailureReplayReason("fev-io-018", () =>
        JSON.parse(
          withFailureReplayReason("fev-io-019", () =>
            boundedFile(
              path.join(run, "vitest-results.json"),
              RAW_LIMITS["vitest-results.json"],
            ),
          ).toString(),
        ),
      ),
      root,
      phase,
    );
    const events = withFailureReplayReason("fev-io-020", () =>
      boundedFile(
        path.join(run, "network-events.ndjson"),
        RAW_LIMITS["network-events.ndjson"],
      ),
    )
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((line) =>
        withFailureReplayReason("fev-io-021", () => JSON.parse(line)),
      );
    try {
      assert.equal(
        withFailureReplayReason("fev-io-022", () =>
          existsSync(path.join(run, "network-events.ndjson.failed")),
        ),
        false,
      );
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-080");
    }
    const guards = validateFailureGuardEvidence(events, {
      vitest: withFailureReplayReason("fev-io-023", () =>
        realpathSync(path.join(root, "node_modules/vitest/vitest.mjs")),
      ),
      worker: withFailureReplayReason("fev-io-024", () =>
        realpathSync(
          path.join(root, "node_modules/vitest/dist/workers/forks.js"),
        ),
      ),
      wranglerBin: withFailureReplayReason("fev-io-025", () =>
        realpathSync(path.join(root, "node_modules/wrangler/bin/wrangler.js")),
      ),
      wranglerCli: withFailureReplayReason("fev-io-026", () =>
        realpathSync(
          path.join(root, "node_modules/wrangler/wrangler-dist/cli.js"),
        ),
      ),
    });
    const runtime = withFailureReplayReason("fev-io-027", () =>
      runnerRuntimeIdentity(run, root),
    );
    const build = await withFailureReplayReasonAsync("fev-io-028", () =>
      validateOwnerBuild(
        path.join(run, "owner-builds/queue"),
        "queue",
        root,
        runtime,
      ),
    );
    if (phase !== "uninstrumented") await supplementalMaps(run, root);
    const receipt: unknown = withFailureReplayReason("fev-io-029", () =>
      JSON.parse(
        withFailureReplayReason("fev-io-030", () =>
          boundedFile(path.join(run, "owner-queue-failure.json"), 65536),
        ).toString(),
      ),
    );
    try {
      assertFailureReceipt(receipt);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-081");
    }
    try {
      assert.equal(receipt.phase, phase);
    } catch (failureReplayError) {
      throw failureReplayFailure(failureReplayError, "fev-check-082");
    }
    const privateReceipt = withFailureReplayReason("fev-io-031", () =>
      JSON.parse(
        withFailureReplayReason("fev-io-032", () =>
          boundedFile(
            path.join(run, "owner-queue-failure-private.json"),
            FAILURE_PRIVATE_MAX_BYTES,
          ),
        ).toString(),
      ),
    );
    const observations = validateFailurePrivateEvidence(
      privateReceipt,
      receipt,
    );
    for (const item of observations) {
      try {
        assert.equal(item.runtimeSha256, runtime);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-083");
      }
      withFailureReplayReason("fev-io-033", () =>
        readOwnerNativeEvidence(run, item),
      );
    }
    for (const item of receipt.cases) {
      try {
        assert.deepEqual(item.modules, build.modules);
      } catch (failureReplayError) {
        throw failureReplayFailure(failureReplayError, "fev-check-084");
      }
      for (const owner of item.runtimes)
        try {
          assert.equal(owner.runtimeSha256, runtime);
        } catch (failureReplayError) {
          throw failureReplayFailure(failureReplayError, "fev-check-085");
        }
    }
    return {
      phase,
      tests,
      guards,
      cases: receipt.cases,
      sourceAndBundleValidated: true,
      privateLifecycleRevalidated: true,
      observedOwnerExits: observations.length,
      productionMemory: "inconclusive",
      productionCpu: "inconclusive",
    };
  } catch (failureReplayError) {
    throw failureReplayFailure(failureReplayError, "fev-stage-004");
  }
}
