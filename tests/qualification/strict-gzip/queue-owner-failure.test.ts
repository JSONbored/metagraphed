import {
  failureNativeFailure,
  withFailureNativeReason,
  withFailureNativeReasonAsync,
  inheritFailureNativeFailures,
  failureNativeBoundaryError,
  withFailureNativeBoundary,
} from "./failure-native-diagnostics.ts";
// Three fixed-source native assertions, or one unfixed auth negative control. Run only after the unchanged 490+2 phase.
// Each phase uses a separate root/guard context. No broker delivery claims.
import assert from "node:assert/strict";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { beforeAll, afterAll, test } from "vitest";
import {
  Miniflare,
  NoOpLog,
  Response as MiniflareResponse,
  HYPERDRIVE_PLUGIN,
} from "miniflare";
import { buildPgUpsert } from "../../../src/neon-write.ts";
import {
  CHAIN_DETAIL_CHAIN_EVENT_COLUMNS,
  CHAIN_DETAIL_CONFLICT_KEYS,
} from "../../../src/chain-detail-neon-write.ts";
import {
  validSyncBatchMessage,
  SYNC_BATCH_MAX_BYTES,
} from "../../../src/sync-batch-queue.ts";
import { SYNC_BATCH_MAX_DECODED_BYTES } from "../../../src/sync-batch-limits.ts";
import { resourceFirstVariants } from "../../helpers/sync-resource-first-fixtures.ts";
import { buildQueueOwner } from "./queue-owner-bundle.ts";
import { preserveOwnerBuild } from "./owner-build-evidence.ts";
import { boundedFile } from "./receipt-files.ts";
import { withinOwnerDeadline } from "./owner-deadline.ts";
import { observeOwner } from "./owner-resource-fixture.ts";
import { readOwnerNativeEvidence } from "./owner-native-evidence.ts";
import { OWNER_SCENARIOS } from "./owner-resource-policy.ts";
import {
  POSTGRES_OWNER,
  QUEUE_HYPERDRIVES,
  sha256,
  type QueueExpectedFamilies,
} from "./postgres-owner-fixture.ts";
import {
  FAILURE_HYPERDRIVES,
  FAILURE_CHAIN_QUERY,
  inspectFailureTransport,
  observeFailureTransport,
  assertFailureDisposition,
  assertFailureReceipt,
  type FailureAuth,
  type FailureCaseReceipt,
} from "./failure-postgres-policy.ts";
import {
  FAILURE_TIME,
  failureFamilies,
  partialFailureFamilies,
  combineFailureFamilies,
  emptyFailureFamilies,
  openFailurePostgresFixture,
  type FailurePostgresFixture,
} from "./failure-postgres-fixture.ts";
import {
  FAILURE_PRIVATE_MAX_BYTES,
  validateFailurePrivateEvidence,
  assertFailureSupplementalSourceMaps,
  type FailurePrivateCase,
  type FailurePrivateRuntime,
} from "./failure-postgres-private.ts";
import {
  assertFailureAuthLifecycle,
  assertFailureQueryLifecycle,
  assertFailureDecoderLifecycle,
  assertFailureUnfixedAuthControl,
  assertFailureSuccessfulLifecycle,
} from "./failure-lifecycle-assertions.ts";

type Scenario = "auth-rejection" | "query-cancellation" | "decoder-refusal";
const root = withFailureNativeBoundary(
  "module",
  () => process.env.DECODER_QUALIFICATION_ROOT,
);
try {
  try {
    assert.ok(root && path.isAbsolute(root));
  } catch (nativeFailureError) {
    throw failureNativeFailure(nativeFailureError, "qnf-check-001");
  }
} catch (nativeBoundaryError) {
  throw failureNativeBoundaryError(nativeBoundaryError, "module");
}
try {
  try {
    assert.ok(
      (globalThis as unknown as Record<symbol, unknown>)[
        Symbol.for("decoder-qualification.host-guard")
      ],
    );
  } catch (nativeFailureError) {
    throw failureNativeFailure(nativeFailureError, "qnf-check-002");
  }
} catch (nativeBoundaryError) {
  throw failureNativeBoundaryError(nativeBoundaryError, "module");
}
try {
  try {
    assert.equal(process.version, "v22.23.2");
  } catch (nativeFailureError) {
    throw failureNativeFailure(nativeFailureError, "qnf-check-003");
  }
} catch (nativeBoundaryError) {
  throw failureNativeBoundaryError(nativeBoundaryError, "module");
}
const phasePath = withFailureNativeBoundary("module", () =>
  path.join(root, "tests/qualification/strict-gzip/failure-phase.json"),
);
try {
  try {
    assert.ok(
      withFailureNativeReason("qnf-operation-001", () =>
        lstatSync(phasePath),
      ).isFile() &&
        !withFailureNativeReason("qnf-operation-002", () =>
          lstatSync(phasePath),
        ).isSymbolicLink(),
    );
  } catch (nativeFailureError) {
    throw failureNativeFailure(nativeFailureError, "qnf-check-004");
  }
} catch (nativeBoundaryError) {
  throw failureNativeBoundaryError(nativeBoundaryError, "module");
}
try {
  try {
    assert.ok(
      withFailureNativeReason("qnf-operation-003", () =>
        realpathSync(phasePath),
      ).startsWith(
        withFailureNativeReason("qnf-operation-004", () => realpathSync(root)) +
          path.sep,
      ),
    );
  } catch (nativeFailureError) {
    throw failureNativeFailure(nativeFailureError, "qnf-check-005");
  }
} catch (nativeBoundaryError) {
  throw failureNativeBoundaryError(nativeBoundaryError, "module");
}
const phaseConfig = withFailureNativeBoundary("module", () =>
  withFailureNativeReason("qnf-operation-005", () =>
    JSON.parse(
      new TextDecoder().decode(
        withFailureNativeReason("qnf-operation-006", () =>
          boundedFile(phasePath, 64),
        ),
      ),
    ),
  ),
);
try {
  try {
    assert.ok(
      phaseConfig.phase === "uninstrumented" ||
        phaseConfig.phase === "instrumented" ||
        phaseConfig.phase === "unfixed-instrumented",
    );
  } catch (nativeFailureError) {
    throw failureNativeFailure(nativeFailureError, "qnf-check-006");
  }
} catch (nativeBoundaryError) {
  throw failureNativeBoundaryError(nativeBoundaryError, "module");
}
try {
  try {
    assert.deepEqual(Object.keys(phaseConfig), ["phase"]);
  } catch (nativeFailureError) {
    throw failureNativeFailure(nativeFailureError, "qnf-check-007");
  }
} catch (nativeBoundaryError) {
  throw failureNativeBoundaryError(nativeBoundaryError, "module");
}
const phase: "uninstrumented" | "instrumented" | "unfixed-instrumented" =
  withFailureNativeBoundary("module", () => phaseConfig.phase);
const base = withFailureNativeBoundary("module", () =>
  phase === "uninstrumented"
    ? 9_300_000
    : phase === "instrumented"
      ? 9_400_000
      : 9_450_000,
);
const receipts: FailureCaseReceipt[] = withFailureNativeBoundary(
  "module",
  () => [],
);
const privateCases: FailurePrivateCase[] = withFailureNativeBoundary(
  "module",
  () => [],
);
const runtimePrivate = withFailureNativeBoundary(
  "module",
  () => new WeakMap<Miniflare, FailurePrivateRuntime>(),
);
let activePrivate: FailurePrivateCase | undefined;
let phaseBuilt: Awaited<ReturnType<typeof buildQueueOwner>> | undefined;
let phaseModules: ReturnType<typeof preserveOwnerBuild> | undefined;
beforeAll(async () => {
  try {
    try {
      phaseBuilt = await withFailureNativeReasonAsync("qnf-operation-007", () =>
        buildQueueOwner(),
      );
      const supplemental =
        phase === "uninstrumented"
          ? []
          : [
              "workers/data-api.ts",
              "src/pg-sql.ts",
              "src/strict-gzip-reader.ts",
              "tests/qualification/strict-gzip/failure-lifecycle-observer.ts",
              "src/read-store.ts",
              "src/lane-health-store.ts",
            ];
      phaseModules = withFailureNativeReason("qnf-operation-008", () =>
        preserveOwnerBuild(
          "queue",
          "data-api.js",
          phaseBuilt /* native-diagnostic-narrow */!.modules
            .map((module) => ({
              name: path.relative(phaseBuilt!.modulesRoot, module.path),
              type: module.type,
              bytes: withFailureNativeReason("qnf-operation-009", () =>
                readFileSync(module.path),
              ),
            })),
          supplemental,
          {
            kind: "wrangler-upload",
            bytes: /* native-diagnostic-narrow */ phaseBuilt!.upload,
          },
        ),
      );
      if (supplemental.length) {
        const upload = phaseBuilt.upload,
          boundaryEnd = upload.findIndex(
            (byte, index) => byte === 13 && upload[index + 1] === 10,
          );
        try {
          assert.ok(boundaryEnd > 2 && boundaryEnd < 200);
        } catch (nativeFailureError) {
          throw failureNativeFailure(nativeFailureError, "qnf-check-008");
        }
        const first = upload.subarray(0, boundaryEnd).toString();
        try {
          assert.match(first, /^--[-A-Za-z0-9]+$/);
        } catch (nativeFailureError) {
          throw failureNativeFailure(nativeFailureError, "qnf-check-009");
        }
        const form = await new Response(new Uint8Array(upload).buffer, {
          headers: {
            "Content-Type": `multipart/form-data; boundary=${first.slice(2)}`,
          },
        }).formData();
        const maps: unknown[] = [];
        for (const [, value] of form)
          if (
            typeof value !== "string" &&
            value.type === "application/source-map"
          ) {
            maps.push(JSON.parse(await value.text()));
          }
        try {
          assertFailureSupplementalSourceMaps(
            maps,
            Object.fromEntries(
              supplemental.map((relative) => [
                relative,
                withFailureNativeReason("qnf-operation-010", () =>
                  readFileSync(path.join(root!, relative), "utf8"),
                ),
              ]),
            ),
          );
        } catch (nativeFailureError) {
          throw failureNativeFailure(nativeFailureError, "qnf-check-010");
        }
      }
    } catch (nativeFailureError) {
      throw failureNativeFailure(nativeFailureError, "qnf-stage-001");
    }
  } catch (nativeBoundaryError) {
    throw failureNativeBoundaryError(nativeBoundaryError, "before-all");
  }
}, 90_000);
try {
  try {
    assert.equal(
      sha256(
        withFailureNativeReason("qnf-operation-011", () =>
          readFileSync(
            path.join(root, "node_modules/miniflare/dist/src/index.js"),
          ),
        ),
      ),
      POSTGRES_OWNER.miniflareSha256,
    );
  } catch (nativeFailureError) {
    throw failureNativeFailure(nativeFailureError, "qnf-check-011");
  }
} catch (nativeBoundaryError) {
  throw failureNativeBoundaryError(nativeBoundaryError, "module");
}
try {
  try {
    assert.equal(
      buildPgUpsert(
        "chain_detail_chain_events",
        CHAIN_DETAIL_CHAIN_EVENT_COLUMNS,
        CHAIN_DETAIL_CONFLICT_KEYS.chain_detail_chain_events,
        1,
      ),
      FAILURE_CHAIN_QUERY,
    );
  } catch (nativeFailureError) {
    throw failureNativeFailure(nativeFailureError, "qnf-check-012");
  }
} catch (nativeBoundaryError) {
  throw failureNativeBoundaryError(nativeBoundaryError, "module");
}
function message(id: string, block: number) {
  try {
    const body = {
      lane: "chain-detail",
      captured_at: FAILURE_TIME,
      families: failureFamilies(block),
    };
    try {
      assert.equal(validSyncBatchMessage(body), true);
    } catch (nativeFailureError) {
      throw failureNativeFailure(nativeFailureError, "qnf-check-013");
    }
    const bytes = Uint8Array.from(gzipSync(JSON.stringify(body)));
    try {
      assert.ok(bytes.byteLength <= SYNC_BATCH_MAX_BYTES);
    } catch (nativeFailureError) {
      throw failureNativeFailure(nativeFailureError, "qnf-check-014");
    }
    return {
      id,
      body: bytes.buffer,
      timestamp: new Date(FAILURE_TIME),
      attempts: 1,
    };
  } catch (nativeFailureError) {
    throw failureNativeFailure(nativeFailureError, "qnf-stage-002");
  }
}
function bodyHash(value: { body: ArrayBuffer }) {
  try {
    return sha256(new Uint8Array(value.body));
  } catch (nativeFailureError) {
    throw failureNativeFailure(nativeFailureError, "qnf-stage-003");
  }
}
async function lifecycle(runtime: Miniflare, checkpoint: string) {
  try {
    try {
      assert.ok(phase === "instrumented" || phase === "unfixed-instrumented");
    } catch (nativeFailureError) {
      throw failureNativeFailure(nativeFailureError, "qnf-check-015");
    }
    const response = await withFailureNativeReasonAsync(
      "qnf-operation-012",
      () =>
        withinOwnerDeadline(
          runtime.dispatchFetch(
            "https://qualification.invalid/__qualification/failure-lifecycle",
          ),
          5000,
        ),
    );
    try {
      assert.equal(response.status, 200);
    } catch (nativeFailureError) {
      throw failureNativeFailure(nativeFailureError, "qnf-check-016");
    }
    try {
      assert.ok(response.body);
    } catch (nativeFailureError) {
      throw failureNativeFailure(nativeFailureError, "qnf-check-017");
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await withFailureNativeReasonAsync(
          "qnf-operation-013",
          () => reader.read(),
        );
        if (next.done) break;
        bytes += next.value.length;
        try {
          assert.ok(bytes <= 1_048_576);
        } catch (nativeFailureError) {
          throw failureNativeFailure(nativeFailureError, "qnf-check-018");
        }
        chunks.push(next.value);
      }
    } finally {
      await withFailureNativeReasonAsync("qnf-operation-014", () =>
        reader.cancel(),
      ).catch(() => {
        try {
        } catch (nativeFailureError) {
          throw failureNativeFailure(nativeFailureError, "qnf-stage-005");
        }
      });
      withFailureNativeReason("qnf-operation-015", () => reader.releaseLock());
    }
    const snapshot = withFailureNativeReason("qnf-operation-016", () =>
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    const record = runtimePrivate.get(runtime);
    try {
      assert.ok(record);
    } catch (nativeFailureError) {
      throw failureNativeFailure(nativeFailureError, "qnf-check-019");
    }
    record.lifecycleSnapshots.push({ checkpoint, snapshot });
    return snapshot;
  } catch (nativeFailureError) {
    throw failureNativeFailure(nativeFailureError, "qnf-stage-004");
  }
}
async function usingRuntime(
  built: Awaited<ReturnType<typeof buildQueueOwner>>,
  auth: FailureAuth,
  scenario: Scenario,
  fixture: FailurePostgresFixture,
  operation: (
    runtime: Miniflare,
    target: Awaited<ReturnType<Miniflare["getWorker"]>>,
    checkpoint: () => Promise<void>,
  ) => Promise<void>,
) {
  try {
    try {
      assert.ok(activePrivate);
    } catch (nativeFailureError) {
      throw failureNativeFailure(nativeFailureError, "qnf-check-020");
    }
    const privateRuntime: FailurePrivateRuntime = {
      observation: null,
      lifecycleSnapshots: [],
    };
    activePrivate.runtimes.push(privateRuntime);
    const mapping = auth === "valid" ? QUEUE_HYPERDRIVES : FAILURE_HYPERDRIVES;
    const transport = await withFailureNativeReasonAsync(
      "qnf-operation-017",
      () => inspectFailureTransport(HYPERDRIVE_PLUGIN, auth),
    );
    let native: Miniflare | undefined,
      observation: Awaited<ReturnType<typeof observeOwner>> | undefined;
    let actual: ReturnType<typeof observeFailureTransport> | undefined;
    let disposed = false,
      finished = false,
      restarts = 0,
      blockedOutbound = 0;
    let primary: unknown,
      result: FailureCaseReceipt["runtimes"][number] | undefined;
    try {
      actual = withFailureNativeReason("qnf-operation-018", () =>
        observeFailureTransport(HYPERDRIVE_PLUGIN, auth),
      );
      native = withFailureNativeReason(
        "qnf-operation-019",
        () =>
          new Miniflare({
            name: OWNER_SCENARIOS.queue.worker,
            modules: built.modules,
            modulesRoot: built.modulesRoot,
            compatibilityDate: built.compatibilityDate,
            compatibilityFlags: built.compatibilityFlags,
            host: "127.0.0.1",
            port: 0,
            inspectorPort: 0,
            cf: false,
            log: new NoOpLog(),
            handleStructuredLogs: () => {
              try {
              } catch (nativeFailureError) {
                throw failureNativeFailure(nativeFailureError, "qnf-stage-007");
              }
            },
            unsafeHandleRuntimeRestart() {
              try {
                restarts++;
              } catch (nativeFailureError) {
                throw failureNativeFailure(nativeFailureError, "qnf-stage-008");
              }
            },
            hyperdrives: { ...mapping },
            kvNamespaces: ["METAGRAPH_CONTROL"],
            bindings:
              phase !== "uninstrumented"
                ? { FAILURE_LIFECYCLE_SCENARIO: scenario }
                : {},
            outboundService() {
              try {
                blockedOutbound++;
                return new MiniflareResponse(null, { status: 502 });
              } catch (nativeFailureError) {
                throw failureNativeFailure(nativeFailureError, "qnf-stage-009");
              }
            },
          }),
      );
      runtimePrivate.set(native, privateRuntime);
      await withFailureNativeReasonAsync("qnf-operation-020", () =>
        withinOwnerDeadline(
          /* native-diagnostic-narrow */ native!.ready,
          20_000,
        ),
      );
      withFailureNativeReason("qnf-operation-021", () =>
        actual /* native-diagnostic-narrow */!
          .assertObserved(),
      );
      withFailureNativeReason("qnf-operation-022", () =>
        actual /* native-diagnostic-narrow */!
          .restore(),
      );
      actual = undefined;
      const target = await withFailureNativeReasonAsync(
        "qnf-operation-023",
        () =>
          withinOwnerDeadline(
            withFailureNativeReasonAsync("qnf-operation-024", () =>
              native /* native-diagnostic-narrow */!
                .getWorker(),
            ),
            10_000,
          ),
      );
      observation = await withFailureNativeReasonAsync(
        "qnf-operation-025",
        () =>
          observeOwner(
            /* native-diagnostic-narrow */ native!,
            OWNER_SCENARIOS.queue.worker,
            () => restarts,
          ),
      );
      await withFailureNativeReasonAsync("qnf-operation-026", () =>
        observation /* native-diagnostic-narrow */!
          .sample("baseline"),
      );
      await operation(native, target, () =>
        withFailureNativeReasonAsync("qnf-operation-027", () =>
          observation!.sample("overlap"),
        ),
      );
      const drain = await withFailureNativeReasonAsync(
        "qnf-operation-028",
        () => fixture.drain(),
      );
      await withFailureNativeReasonAsync("qnf-operation-029", () =>
        fixture.healthy(),
      );
      await withFailureNativeReasonAsync("qnf-operation-030", () =>
        observation /* native-diagnostic-narrow */!
          .sample("drained"),
      );
      await withFailureNativeReasonAsync("qnf-operation-031", () =>
        withinOwnerDeadline(
          withFailureNativeReasonAsync("qnf-operation-032", () =>
            observation /* native-diagnostic-narrow */!
              .finish(),
          ),
          10_000,
        ),
      );
      finished = true;
      try {
        assert.equal(restarts, 0);
      } catch (nativeFailureError) {
        throw failureNativeFailure(nativeFailureError, "qnf-check-021");
      }
      try {
        assert.equal(blockedOutbound, 0);
      } catch (nativeFailureError) {
        throw failureNativeFailure(nativeFailureError, "qnf-check-022");
      }
      await withFailureNativeReasonAsync("qnf-operation-033", () =>
        withinOwnerDeadline(
          withFailureNativeReasonAsync("qnf-operation-034", () =>
            native /* native-diagnostic-narrow */!
              .dispose(),
          ),
          10_000,
        ),
      );
      disposed = true;
      const observed = withFailureNativeReason("qnf-operation-035", () =>
        observation /* native-diagnostic-narrow */!
          .receipt(),
      );
      privateRuntime.observation = observed;
      try {
        assert.equal(observed.sampleErrors, 0);
      } catch (nativeFailureError) {
        throw failureNativeFailure(nativeFailureError, "qnf-check-023");
      }
      try {
        assert.equal(observed.missedSamples, 0);
      } catch (nativeFailureError) {
        throw failureNativeFailure(nativeFailureError, "qnf-check-024");
      }
      try {
        assert.ok(observed.samples.length >= 2 && observed.samples.length <= 3);
      } catch (nativeFailureError) {
        throw failureNativeFailure(nativeFailureError, "qnf-check-025");
      }
      const resultFile = process.env.DECODER_QUALIFICATION_RESULT;
      try {
        assert.ok(resultFile && path.isAbsolute(resultFile));
      } catch (nativeFailureError) {
        throw failureNativeFailure(nativeFailureError, "qnf-check-026");
      }
      const custody = withFailureNativeReason("qnf-operation-036", () =>
        readOwnerNativeEvidence(path.dirname(resultFile), observed),
      );
      // The negative example owns no client.end(). Prove final owner cleanup
      // separately, only after the actual native exit has been correlated.
      if (phase === "unfixed-instrumented") {
        const postExitDrain = await withFailureNativeReasonAsync(
          "qnf-operation-085",
          () =>
            withinOwnerDeadline(
              (async () => {
                const drained = await withFailureNativeReasonAsync(
                  "qnf-operation-086",
                  () => fixture.drain(),
                );
                await withFailureNativeReasonAsync("qnf-operation-087", () =>
                  fixture.healthy(),
                );
                return drained;
              })(),
              10_000,
            ),
        );
        // Keep this assignment outside the raced promise: a late settlement
        // after deadline failure must never create successful evidence.
        privateRuntime.postExitDrain = {
          boundary: "after-observed-native-exit",
          remainingWriterSessions: postExitDrain.remainingWriterSessions,
          stableZeroSamples: postExitDrain.stableZeroSamples,
        };
      }
      result = {
        mappingSha256: transport.mappingSha256,
        serviceSha256: transport.serviceSha256,
        isolateSha256: sha256(observed.isolateId),
        runtimeSha256: observed.runtimeSha256,
        guardedNativeLaunches: custody.guardedNativeLaunches,
        observedNativeExits: custody.observedNativeExits,
        restarts: 0,
        blockedOutbound: 0,
        pending: 0,
        remainingWriterSessions: drain.remainingWriterSessions,
        stableZeroSamples: drain.stableZeroSamples,
      };
    } catch (error) {
      primary = error;
    }
    const cleanup: unknown[] = [];
    const attempt = async (f: () => Promise<unknown>) => {
      try {
        try {
          await f();
        } catch (error) {
          cleanup.push(error);
        }
      } catch (nativeFailureError) {
        throw failureNativeFailure(nativeFailureError, "qnf-stage-010");
      }
    };
    if (actual) {
      try {
        withFailureNativeReason("qnf-operation-037", () => actual.restore());
      } catch (error) {
        cleanup.push(error);
      }
    }
    await attempt(() =>
      withFailureNativeReasonAsync("qnf-operation-038", () =>
        withinOwnerDeadline(
          withFailureNativeReasonAsync("qnf-operation-039", () =>
            fixture.rollback(),
          ),
          10_000,
        ),
      ),
    );
    if (observation && !finished)
      await attempt(() =>
        withFailureNativeReasonAsync("qnf-operation-040", () =>
          withinOwnerDeadline(
            withFailureNativeReasonAsync("qnf-operation-041", () =>
              observation!.finish(),
            ),
            10_000,
          ),
        ),
      );
    if (native && !disposed)
      await attempt(() =>
        withFailureNativeReasonAsync("qnf-operation-042", () =>
          withinOwnerDeadline(
            withFailureNativeReasonAsync("qnf-operation-043", () =>
              native!.dispose(),
            ),
            10_000,
          ),
        ),
      );
    if (primary || cleanup.length)
      throw inheritFailureNativeFailures(
        new AggregateError(
          [...(primary ? [primary] : []), ...cleanup],
          "Native failure scenario or cleanup failed",
        ),
        [
          ...(primary
            ? [
                {
                  error: primary,
                  role: "primary" as const,
                  location: "qnf-runtime-primary" as const,
                },
              ]
            : []),
          ...cleanup.map((error) => ({
            error,
            role: "cleanup" as const,
            location: "qnf-runtime-cleanup" as const,
          })),
        ],
      );
    try {
      assert.ok(result);
    } catch (nativeFailureError) {
      throw failureNativeFailure(nativeFailureError, "qnf-check-027");
    }
    return result;
  } catch (nativeFailureError) {
    throw failureNativeFailure(nativeFailureError, "qnf-stage-006");
  }
}
async function withFixture(
  blocks: number[],
  scenario: FailureCaseReceipt["scenario"],
  task: (
    fixture: FailurePostgresFixture,
    built: Awaited<ReturnType<typeof buildQueueOwner>>,
  ) => Promise<FailureCaseReceipt>,
) {
  try {
    let fixture: FailurePostgresFixture | undefined;
    let primary: unknown, receipt: FailureCaseReceipt | undefined;
    try {
      assert.equal(activePrivate, undefined);
    } catch (nativeFailureError) {
      throw failureNativeFailure(nativeFailureError, "qnf-check-028");
    }
    const privateCase: FailurePrivateCase = {
      scenario,
      runtimes: [],
      cancellation: null,
    };
    activePrivate = privateCase;
    try {
      try {
        assert.ok(phaseBuilt);
      } catch (nativeFailureError) {
        throw failureNativeFailure(nativeFailureError, "qnf-check-029");
      }
      fixture = await withFailureNativeReasonAsync("qnf-operation-044", () =>
        openFailurePostgresFixture(blocks, root!),
      );
      receipt = await task(fixture, phaseBuilt);
      privateCase.cancellation = withFailureNativeReason(
        "qnf-operation-045",
        () =>
          fixture /* native-diagnostic-narrow */!
            .cancellationEvidence(),
      );
    } catch (error) {
      primary = error;
    }
    const failures: unknown[] = [];
    if (fixture)
      try {
        await withFailureNativeReasonAsync("qnf-operation-046", () =>
          withinOwnerDeadline(
            withFailureNativeReasonAsync("qnf-operation-047", () =>
              fixture.close(),
            ),
            10_000,
          ),
        );
      } catch (error) {
        failures.push(error);
      }
    activePrivate = undefined;
    if (primary || failures.length)
      throw inheritFailureNativeFailures(
        new AggregateError(
          [...(primary ? [primary] : []), ...failures],
          "Failure owner assertion or cleanup failed",
        ),
        [
          ...(primary
            ? [
                {
                  error: primary,
                  role: "primary" as const,
                  location: "qnf-fixture-primary" as const,
                },
              ]
            : []),
          ...failures.map((error) => ({
            error,
            role: "cleanup" as const,
            location: "qnf-fixture-cleanup" as const,
          })),
        ],
      );
    try {
      assert.ok(receipt);
    } catch (nativeFailureError) {
      throw failureNativeFailure(nativeFailureError, "qnf-check-030");
    }
    try {
      assert.equal(receipt.scenario, scenario);
    } catch (nativeFailureError) {
      throw failureNativeFailure(nativeFailureError, "qnf-check-031");
    }
    receipts.push(receipt);
    privateCases.push(privateCase);
  } catch (nativeFailureError) {
    throw failureNativeFailure(nativeFailureError, "qnf-stage-011");
  }
}
function common(
  scenario: FailureCaseReceipt["scenario"],
  _built: Awaited<ReturnType<typeof buildQueueOwner>>,
) {
  try {
    try {
      assert.ok(phaseModules);
    } catch (nativeFailureError) {
      throw failureNativeFailure(nativeFailureError, "qnf-check-032");
    }
    return {
      scenario,
      phase,
      modules: phaseModules,
      lifecycle:
        phase === "unfixed-instrumented"
          ? ("negative-control-passed" as const)
          : phase === "instrumented"
            ? ("supplemental-passed" as const)
            : ("not-instrumented" as const),
      productionMemory: "inconclusive" as const,
      productionCpu: "inconclusive" as const,
    };
  } catch (nativeFailureError) {
    throw failureNativeFailure(nativeFailureError, "qnf-stage-012");
  }
}

if (phase !== "unfixed-instrumented") {
  test("the real queue rejects immutable wrong-password auth and independently ACKs the unchanged-valid control", async () => {
    try {
      try {
        await withFixture(
          [base + 1, base + 2],
          "auth-rejection",
          async (fixture, built) => {
            try {
              const failed = message("failure-auth", base + 1),
                control = message("control-auth", base + 2);
              const hashes = [bodyHash(failed), bodyHash(control)];
              const runtimes: FailureCaseReceipt["runtimes"] = [];
              runtimes.push(
                await usingRuntime(
                  built,
                  "wrong-password",
                  "auth-rejection",
                  fixture,
                  async (native, target) => {
                    try {
                      const outcome = await withFailureNativeReasonAsync(
                        "qnf-operation-048",
                        () =>
                          withinOwnerDeadline(
                            withFailureNativeReasonAsync(
                              "qnf-operation-049",
                              () => target.queue("sync-batches", [failed]),
                            ),
                            30_000,
                          ),
                      );
                      try {
                        assertFailureDisposition(outcome, [], [failed.id]);
                      } catch (nativeFailureError) {
                        throw failureNativeFailure(
                          nativeFailureError,
                          "qnf-check-033",
                        );
                      }
                      await withFailureNativeReasonAsync(
                        "qnf-operation-050",
                        () => fixture.verifyRows(emptyFailureFamilies()),
                      );
                      await withFailureNativeReasonAsync(
                        "qnf-operation-051",
                        () => fixture.drain(),
                      );
                      if (phase === "instrumented")
                        try {
                          assertFailureAuthLifecycle(
                            await lifecycle(native, "auth-rejection"),
                          );
                        } catch (nativeFailureError) {
                          throw failureNativeFailure(
                            nativeFailureError,
                            "qnf-check-034",
                          );
                        }
                    } catch (nativeFailureError) {
                      throw failureNativeFailure(
                        nativeFailureError,
                        "qnf-stage-015",
                      );
                    }
                  },
                ),
              );
              try {
                assert.equal(bodyHash(failed), hashes[0]);
              } catch (nativeFailureError) {
                throw failureNativeFailure(nativeFailureError, "qnf-check-035");
              }
              let durable:
                | Awaited<ReturnType<FailurePostgresFixture["verifyRows"]>>
                | undefined;
              runtimes.push(
                await usingRuntime(
                  built,
                  "valid",
                  "auth-rejection",
                  fixture,
                  async (native, target) => {
                    try {
                      try {
                        assertFailureDisposition(
                          await withFailureNativeReasonAsync(
                            "qnf-operation-052",
                            () =>
                              withinOwnerDeadline(
                                withFailureNativeReasonAsync(
                                  "qnf-operation-053",
                                  () => target.queue("sync-batches", [control]),
                                ),
                                30_000,
                              ),
                          ),
                          [control.id],
                          [],
                        );
                      } catch (nativeFailureError) {
                        throw failureNativeFailure(
                          nativeFailureError,
                          "qnf-check-036",
                        );
                      }
                      durable = await withFailureNativeReasonAsync(
                        "qnf-operation-054",
                        () => fixture.verifyRows(failureFamilies(base + 2)),
                      );
                      await withFailureNativeReasonAsync(
                        "qnf-operation-055",
                        () => fixture.drain(),
                      );
                      if (phase === "instrumented")
                        try {
                          assertFailureSuccessfulLifecycle(
                            await lifecycle(native, "auth-valid-control"),
                            "auth-rejection",
                          );
                        } catch (nativeFailureError) {
                          throw failureNativeFailure(
                            nativeFailureError,
                            "qnf-check-037",
                          );
                        }
                    } catch (nativeFailureError) {
                      throw failureNativeFailure(
                        nativeFailureError,
                        "qnf-stage-016",
                      );
                    }
                  },
                ),
              );
              try {
                assert.equal(bodyHash(control), hashes[1]);
              } catch (nativeFailureError) {
                throw failureNativeFailure(nativeFailureError, "qnf-check-038");
              }
              try {
                assert.ok(durable);
              } catch (nativeFailureError) {
                throw failureNativeFailure(nativeFailureError, "qnf-check-039");
              }
              try {
                assert.notEqual(
                  runtimes[0]!.isolateSha256,
                  runtimes[1]!.isolateSha256,
                );
              } catch (nativeFailureError) {
                throw failureNativeFailure(nativeFailureError, "qnf-check-040");
              }
              return {
                ...common("auth-rejection", built),
                bodySha256: hashes,
                dispositions: [
                  { ack: [], retry: [failed.id] },
                  { ack: [control.id], retry: [] },
                ],
                partialCounts: [0, 0, 0, 0],
                partialSha256: sha256(JSON.stringify(emptyFailureFamilies())),
                finalCounts: durable.rowCounts,
                finalSha256: durable.contentSha256,
                runtimes,
                replay: "separate-valid-runtime",
              };
            } catch (nativeFailureError) {
              throw failureNativeFailure(nativeFailureError, "qnf-stage-014");
            }
          },
        );
      } catch (nativeFailureError) {
        throw failureNativeFailure(nativeFailureError, "qnf-stage-013");
      }
    } catch (nativeBoundaryError) {
      throw failureNativeBoundaryError(nativeBoundaryError, "auth-rejection");
    }
  }, 120_000);

  test("the real queue exposes cancelled second-family partial durability and byte-identical same-isolate manual recovery", async () => {
    try {
      try {
        await withFixture(
          [base + 11, base + 12],
          "query-cancellation",
          async (fixture, built) => {
            try {
              const selected = message("failure-query", base + 11),
                neighbor = message("neighbor-query", base + 12);
              const hashes = [bodyHash(selected), bodyHash(neighbor)];
              let partial:
                  | Awaited<ReturnType<FailurePostgresFixture["verifyRows"]>>
                  | undefined,
                complete: typeof partial;
              const runtime = await usingRuntime(
                built,
                "valid",
                "query-cancellation",
                fixture,
                async (native, target, checkpoint) => {
                  try {
                    await withFailureNativeReasonAsync(
                      "qnf-operation-056",
                      () => fixture.arm(base + 11),
                    );
                    let settled = false,
                      completionError: unknown;
                    const completion = target
                      .queue("sync-batches", [selected, neighbor])
                      .then(
                        (value) => {
                          try {
                            settled = true;
                            return value;
                          } catch (nativeFailureError) {
                            throw failureNativeFailure(
                              nativeFailureError,
                              "qnf-stage-020",
                            );
                          }
                        },
                        (error) => {
                          try {
                            settled = true;
                            completionError = error;
                            return undefined;
                          } catch (nativeFailureError) {
                            throw failureNativeFailure(
                              nativeFailureError,
                              "qnf-stage-021",
                            );
                          }
                        },
                      );
                    try {
                      const witness = await withFailureNativeReasonAsync(
                        "qnf-operation-057",
                        () => fixture.waitForSelected(() => !settled),
                      );
                      await checkpoint();
                      await withFailureNativeReasonAsync(
                        "qnf-operation-058",
                        () => fixture.cancelSelected(witness, () => !settled),
                      );
                      const outcome = await withFailureNativeReasonAsync(
                        "qnf-operation-059",
                        () => withinOwnerDeadline(completion, 30_000),
                      );
                      try {
                        assert.equal(completionError, undefined);
                      } catch (nativeFailureError) {
                        throw failureNativeFailure(
                          nativeFailureError,
                          "qnf-check-041",
                        );
                      }
                      try {
                        assertFailureDisposition(
                          outcome,
                          [neighbor.id],
                          [selected.id],
                        );
                      } catch (nativeFailureError) {
                        throw failureNativeFailure(
                          nativeFailureError,
                          "qnf-check-042",
                        );
                      }
                      await withFailureNativeReasonAsync(
                        "qnf-operation-060",
                        () => fixture.drain(),
                      );
                      if (phase === "instrumented")
                        try {
                          assertFailureQueryLifecycle(
                            await lifecycle(native, "query-failure"),
                            {
                              querySha256: witness.querySha256,
                              backendPid: witness.pid,
                            },
                          );
                        } catch (nativeFailureError) {
                          throw failureNativeFailure(
                            nativeFailureError,
                            "qnf-check-043",
                          );
                        }
                      await withFailureNativeReasonAsync(
                        "qnf-operation-061",
                        () => fixture.rollback(),
                      );
                      partial = await withFailureNativeReasonAsync(
                        "qnf-operation-062",
                        () =>
                          fixture.verifyRows(
                            combineFailureFamilies(
                              partialFailureFamilies(base + 11),
                              failureFamilies(base + 12),
                            ),
                          ),
                      );
                      try {
                        assert.deepEqual(partial.rowCounts, [1, 2, 1, 2]);
                      } catch (nativeFailureError) {
                        throw failureNativeFailure(
                          nativeFailureError,
                          "qnf-check-044",
                        );
                      }
                      await withFailureNativeReasonAsync(
                        "qnf-operation-063",
                        () => fixture.drain(),
                      );
                      try {
                        assert.equal(bodyHash(selected), hashes[0]);
                      } catch (nativeFailureError) {
                        throw failureNativeFailure(
                          nativeFailureError,
                          "qnf-check-045",
                        );
                      }
                      try {
                        assert.equal(bodyHash(neighbor), hashes[1]);
                      } catch (nativeFailureError) {
                        throw failureNativeFailure(
                          nativeFailureError,
                          "qnf-check-046",
                        );
                      }
                      const replay = { ...selected, attempts: 2 };
                      try {
                        assert.equal(bodyHash(replay), hashes[0]);
                      } catch (nativeFailureError) {
                        throw failureNativeFailure(
                          nativeFailureError,
                          "qnf-check-047",
                        );
                      }
                      try {
                        assert.equal(replay.body, selected.body);
                      } catch (nativeFailureError) {
                        throw failureNativeFailure(
                          nativeFailureError,
                          "qnf-check-048",
                        );
                      }
                      try {
                        assertFailureDisposition(
                          await withFailureNativeReasonAsync(
                            "qnf-operation-064",
                            () =>
                              withinOwnerDeadline(
                                withFailureNativeReasonAsync(
                                  "qnf-operation-065",
                                  () => target.queue("sync-batches", [replay]),
                                ),
                                30_000,
                              ),
                          ),
                          [selected.id],
                          [],
                        );
                      } catch (nativeFailureError) {
                        throw failureNativeFailure(
                          nativeFailureError,
                          "qnf-check-049",
                        );
                      }
                      complete = await withFailureNativeReasonAsync(
                        "qnf-operation-066",
                        () =>
                          fixture.verifyRows(
                            combineFailureFamilies(
                              failureFamilies(base + 11),
                              failureFamilies(base + 12),
                            ),
                          ),
                      );
                      try {
                        assert.deepEqual(complete.rowCounts, [2, 2, 2, 2]);
                      } catch (nativeFailureError) {
                        throw failureNativeFailure(
                          nativeFailureError,
                          "qnf-check-050",
                        );
                      }
                      await withFailureNativeReasonAsync(
                        "qnf-operation-067",
                        () => fixture.drain(),
                      );
                      if (phase === "instrumented")
                        try {
                          assertFailureQueryLifecycle(
                            await lifecycle(native, "query-replay"),
                            {
                              querySha256: witness.querySha256,
                              backendPid: witness.pid,
                            },
                          );
                        } catch (nativeFailureError) {
                          throw failureNativeFailure(
                            nativeFailureError,
                            "qnf-check-051",
                          );
                        }
                    } finally {
                      await withFailureNativeReasonAsync(
                        "qnf-operation-068",
                        () => fixture.rollback(),
                      );
                      // A deadline remains a failure. Lock release/disposal never relabels it cancellation.
                      await withFailureNativeReasonAsync(
                        "qnf-operation-069",
                        () => withinOwnerDeadline(completion, 10_000),
                      );
                    }
                  } catch (nativeFailureError) {
                    throw failureNativeFailure(
                      nativeFailureError,
                      "qnf-stage-019",
                    );
                  }
                },
              );
              try {
                assert.ok(partial && complete);
              } catch (nativeFailureError) {
                throw failureNativeFailure(nativeFailureError, "qnf-check-052");
              }
              try {
                assert.equal(bodyHash(selected), hashes[0]);
              } catch (nativeFailureError) {
                throw failureNativeFailure(nativeFailureError, "qnf-check-053");
              }
              return {
                ...common("query-cancellation", built),
                bodySha256: hashes,
                dispositions: [
                  { ack: [neighbor.id], retry: [selected.id] },
                  { ack: [selected.id], retry: [] },
                ],
                partialCounts: partial.rowCounts,
                partialSha256: partial.contentSha256,
                finalCounts: complete.rowCounts,
                finalSha256: complete.contentSha256,
                runtimes: [runtime],
                replay: "byte-identical-same-isolate",
              };
            } catch (nativeFailureError) {
              throw failureNativeFailure(nativeFailureError, "qnf-stage-018");
            }
          },
        );
      } catch (nativeFailureError) {
        throw failureNativeFailure(nativeFailureError, "qnf-stage-017");
      }
    } catch (nativeBoundaryError) {
      throw failureNativeBoundaryError(
        nativeBoundaryError,
        "query-cancellation",
      );
    }
  }, 120_000);

  test("the real queue refuses the over-budget bad-tail input while good neighbors and same-isolate later work commit", async () => {
    try {
      try {
        await withFixture(
          [base + 21, base + 22, base + 23, base + 24],
          "decoder-refusal",
          async (fixture, built) => {
            try {
              const first = message("neighbor-before", base + 21),
                last = message("neighbor-after", base + 23),
                later = message("neighbor-later", base + 24);
              const refusedJson = JSON.stringify({
                lane: "chain-detail",
                captured_at: FAILURE_TIME,
                families: failureFamilies(base + 22),
              });
              const bytes = resourceFirstVariants(
                refusedJson,
                SYNC_BATCH_MAX_DECODED_BYTES,
              ).get("bad-crc")!;
              try {
                assert.ok(bytes.byteLength <= SYNC_BATCH_MAX_BYTES);
              } catch (nativeFailureError) {
                throw failureNativeFailure(nativeFailureError, "qnf-check-054");
              }
              const refused = {
                id: "failure-decoder",
                body: Uint8Array.from(bytes).buffer,
                timestamp: new Date(FAILURE_TIME),
                attempts: 1,
              };
              const originals = [first, refused, last, later],
                hashes = originals.map(bodyHash);
              let partial:
                  | Awaited<ReturnType<FailurePostgresFixture["verifyRows"]>>
                  | undefined,
                complete: typeof partial;
              const runtime = await usingRuntime(
                built,
                "valid",
                "decoder-refusal",
                fixture,
                async (native, target) => {
                  try {
                    try {
                      assertFailureDisposition(
                        await withFailureNativeReasonAsync(
                          "qnf-operation-070",
                          () =>
                            withinOwnerDeadline(
                              withFailureNativeReasonAsync(
                                "qnf-operation-071",
                                () =>
                                  target.queue("sync-batches", [
                                    first,
                                    refused,
                                    last,
                                  ]),
                              ),
                              60_000,
                            ),
                        ),
                        [first.id, last.id],
                        [refused.id],
                      );
                    } catch (nativeFailureError) {
                      throw failureNativeFailure(
                        nativeFailureError,
                        "qnf-check-055",
                      );
                    }
                    partial = await withFailureNativeReasonAsync(
                      "qnf-operation-072",
                      () =>
                        fixture.verifyRows(
                          combineFailureFamilies(
                            failureFamilies(base + 21),
                            failureFamilies(base + 23),
                          ),
                        ),
                    );
                    try {
                      assert.deepEqual(partial.rowCounts, [2, 2, 2, 2]);
                    } catch (nativeFailureError) {
                      throw failureNativeFailure(
                        nativeFailureError,
                        "qnf-check-056",
                      );
                    }
                    await withFailureNativeReasonAsync(
                      "qnf-operation-073",
                      () => fixture.drain(),
                    );
                    if (phase === "instrumented")
                      try {
                        assertFailureDecoderLifecycle(
                          await lifecycle(native, "decoder-refusal"),
                        );
                      } catch (nativeFailureError) {
                        throw failureNativeFailure(
                          nativeFailureError,
                          "qnf-check-057",
                        );
                      }
                    try {
                      assert.deepEqual(originals.map(bodyHash), hashes);
                    } catch (nativeFailureError) {
                      throw failureNativeFailure(
                        nativeFailureError,
                        "qnf-check-058",
                      );
                    }
                    try {
                      assertFailureDisposition(
                        await withFailureNativeReasonAsync(
                          "qnf-operation-074",
                          () =>
                            withinOwnerDeadline(
                              withFailureNativeReasonAsync(
                                "qnf-operation-075",
                                () => target.queue("sync-batches", [later]),
                              ),
                              30_000,
                            ),
                        ),
                        [later.id],
                        [],
                      );
                    } catch (nativeFailureError) {
                      throw failureNativeFailure(
                        nativeFailureError,
                        "qnf-check-059",
                      );
                    }
                    complete = await withFailureNativeReasonAsync(
                      "qnf-operation-076",
                      () =>
                        fixture.verifyRows(
                          combineFailureFamilies(
                            failureFamilies(base + 21),
                            failureFamilies(base + 23),
                            failureFamilies(base + 24),
                          ),
                        ),
                    );
                    try {
                      assert.deepEqual(complete.rowCounts, [3, 3, 3, 3]);
                    } catch (nativeFailureError) {
                      throw failureNativeFailure(
                        nativeFailureError,
                        "qnf-check-060",
                      );
                    }
                    await withFailureNativeReasonAsync(
                      "qnf-operation-077",
                      () => fixture.drain(),
                    );
                    if (phase === "instrumented")
                      try {
                        assertFailureDecoderLifecycle(
                          await lifecycle(native, "decoder-subsequent"),
                        );
                      } catch (nativeFailureError) {
                        throw failureNativeFailure(
                          nativeFailureError,
                          "qnf-check-061",
                        );
                      }
                  } catch (nativeFailureError) {
                    throw failureNativeFailure(
                      nativeFailureError,
                      "qnf-stage-024",
                    );
                  }
                },
              );
              try {
                assert.ok(partial && complete);
              } catch (nativeFailureError) {
                throw failureNativeFailure(nativeFailureError, "qnf-check-062");
              }
              try {
                assert.deepEqual(originals.map(bodyHash), hashes);
              } catch (nativeFailureError) {
                throw failureNativeFailure(nativeFailureError, "qnf-check-063");
              }
              return {
                ...common("decoder-refusal", built),
                bodySha256: hashes,
                dispositions: [
                  { ack: [first.id, last.id], retry: [refused.id] },
                  { ack: [later.id], retry: [] },
                ],
                partialCounts: partial.rowCounts,
                partialSha256: partial.contentSha256,
                finalCounts: complete.rowCounts,
                finalSha256: complete.contentSha256,
                runtimes: [runtime],
                replay: "same-isolate-subsequent-success",
              };
            } catch (nativeFailureError) {
              throw failureNativeFailure(nativeFailureError, "qnf-stage-023");
            }
          },
        );
      } catch (nativeFailureError) {
        throw failureNativeFailure(nativeFailureError, "qnf-stage-022");
      }
    } catch (nativeBoundaryError) {
      throw failureNativeBoundaryError(nativeBoundaryError, "decoder-refusal");
    }
  }, 120_000);
} else {
  test("the genuine unfixed queue auth control witnesses real rejection and specifically fails the client-end oracle", async () => {
    try {
      try {
        await withFixture(
          [base + 1],
          "auth-unfixed-control",
          async (fixture, built) => {
            try {
              const failed = message("failure-auth-unfixed", base + 1),
                originalHash = bodyHash(failed);
              let control: FailureCaseReceipt["negativeControl"] | undefined;
              let durable:
                | Awaited<ReturnType<FailurePostgresFixture["verifyRows"]>>
                | undefined;
              const runtime = await usingRuntime(
                built,
                "wrong-password",
                "auth-rejection",
                fixture,
                async (native, target) => {
                  try {
                    try {
                      assertFailureDisposition(
                        await withFailureNativeReasonAsync(
                          "qnf-operation-078",
                          () =>
                            withinOwnerDeadline(
                              withFailureNativeReasonAsync(
                                "qnf-operation-079",
                                () => target.queue("sync-batches", [failed]),
                              ),
                              30_000,
                            ),
                        ),
                        [],
                        [failed.id],
                      );
                    } catch (nativeFailureError) {
                      throw failureNativeFailure(
                        nativeFailureError,
                        "qnf-check-064",
                      );
                    }
                    await withFailureNativeReasonAsync(
                      "qnf-operation-080",
                      () => fixture.drain(),
                    );
                    durable = await withFailureNativeReasonAsync(
                      "qnf-operation-081",
                      () => fixture.verifyRows(emptyFailureFamilies()),
                    );
                    control = assertFailureUnfixedAuthControl(
                      await lifecycle(native, "auth-unfixed-control"),
                    );
                  } catch (nativeFailureError) {
                    throw failureNativeFailure(
                      nativeFailureError,
                      "qnf-stage-027",
                    );
                  }
                },
              );
              try {
                assert.ok(control && durable);
              } catch (nativeFailureError) {
                throw failureNativeFailure(nativeFailureError, "qnf-check-065");
              }
              try {
                assert.equal(bodyHash(failed), originalHash);
              } catch (nativeFailureError) {
                throw failureNativeFailure(nativeFailureError, "qnf-check-066");
              }
              return {
                ...common("auth-unfixed-control", built),
                negativeControl: control,
                bodySha256: [originalHash],
                dispositions: [{ ack: [], retry: [failed.id] }],
                partialCounts: durable.rowCounts,
                partialSha256: durable.contentSha256,
                finalCounts: durable.rowCounts,
                finalSha256: durable.contentSha256,
                runtimes: [runtime],
                replay: "no-replay",
              };
            } catch (nativeFailureError) {
              throw failureNativeFailure(nativeFailureError, "qnf-stage-026");
            }
          },
        );
      } catch (nativeFailureError) {
        throw failureNativeFailure(nativeFailureError, "qnf-stage-025");
      }
    } catch (nativeBoundaryError) {
      throw failureNativeBoundaryError(
        nativeBoundaryError,
        "auth-unfixed-control",
      );
    }
  }, 120_000);
}

afterAll(async () => {
  try {
    try {
      if (phaseBuilt)
        await withFailureNativeReasonAsync("qnf-operation-082", () =>
          phaseBuilt /* native-diagnostic-narrow */!
            .cleanup(),
        );
      const receipt = { version: 1 as const, phase, cases: receipts };
      try {
        assertFailureReceipt(receipt);
      } catch (nativeFailureError) {
        throw failureNativeFailure(nativeFailureError, "qnf-check-067");
      }
      const privateReceipt = {
        version: 1 as const,
        phase,
        cases: privateCases,
      };
      validateFailurePrivateEvidence(privateReceipt, receipt);
      const result = process.env.DECODER_QUALIFICATION_RESULT;
      try {
        assert.ok(result && path.isAbsolute(result));
      } catch (nativeFailureError) {
        throw failureNativeFailure(nativeFailureError, "qnf-check-068");
      }
      const bytes = JSON.stringify(receipt) + "\n";
      try {
        assert.ok(Buffer.byteLength(bytes) <= 32768);
      } catch (nativeFailureError) {
        throw failureNativeFailure(nativeFailureError, "qnf-check-069");
      }
      const privateBytes = JSON.stringify(privateReceipt) + "\n";
      try {
        assert.ok(Buffer.byteLength(privateBytes) <= FAILURE_PRIVATE_MAX_BYTES);
      } catch (nativeFailureError) {
        throw failureNativeFailure(nativeFailureError, "qnf-check-070");
      }
      withFailureNativeReason("qnf-operation-083", () =>
        writeFileSync(
          path.join(path.dirname(result), "owner-queue-failure-private.json"),
          privateBytes,
          { flag: "wx", mode: 0o600 },
        ),
      );
      withFailureNativeReason("qnf-operation-084", () =>
        writeFileSync(
          path.join(path.dirname(result), "owner-queue-failure.json"),
          bytes,
          { flag: "wx", mode: 0o600 },
        ),
      );
    } catch (nativeFailureError) {
      throw failureNativeFailure(nativeFailureError, "qnf-stage-028");
    }
  } catch (nativeBoundaryError) {
    throw failureNativeBoundaryError(nativeBoundaryError, "after-all");
  }
});
