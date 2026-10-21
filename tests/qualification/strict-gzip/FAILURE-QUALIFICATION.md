# Additional failure, replay and cleanup qualification

Status: the first failure-slice attempt at draft PR #12862 head `b9229ae6d9bf024781a9df5fd8a0d1695073c63e`, run `39526016509`, failed private phase-proof replay. Its baseline requalified all 492 assertions with 100% two-source coverage. All three uninstrumented named tests completed with exit zero, zero denials and four completed guarded threads, but that phase did not qualify. Instrumented and genuine unfixed phases did not run. Service identity, bounded publication and terminal container cleanup succeeded. The prior green result remains immutable: head `3e0545ee7f5cdadbd73157f37fc73564cae57536`, run `39510174099`.

## Replay correction under review

The unchanged preload records a generic guard-exit observation from Worker threads as well as host processes. The first replay validator incorrectly counted every generic exit as one of its four required process exits. A pure differential reproduces this source-level incompatibility; the first sanitized artifact does not establish it as the exact hosted refusal.

The local successor preserves exactly four process starts/exits and three real Node child exits. Optional generic thread exits must match an already complete, guarded thread lifecycle by identity, entry and parent, occur after thread readiness and before the actual parent-observed exit, and contain clean counters. They cannot replace actual thread exits. Orphan, duplicate, spoofed, failed or native-launching thread records remain refused. Parent-written handshake ordering may race a thread's exit observation and is not used as an extra ordering requirement.

Fixed, source-bound replay reason codes cover the additional phase predicates and operation/type boundaries. Diagnostics preserve the original error privately, retain the deepest recognized failure, and independently revalidate before bounded public projection. They do not satisfy a proof, alter a predicate, or copy arbitrary errors, SQL, paths or lifecycle records. Existing deeper build-proof codes remain a separately validated fixed family. This successor is local and awaiting exact-snapshot review and a separate draft CI publication decision.

The first failed artifact is `12313706914`, ZIP SHA-256 `5858beaa98381e7b6ada0fb5a4718551040859f3a5476a171df80aea87fe7413`. Its summary and unchanged redacted LCOV are preserved separately from the original green artifact.

## Exact source transition

The separate candidate pins merged connection cleanup commit `ea18c9e309063fb339cd8c8109e2e179c70f3289`, tree `e603296c2e55f14d0e6ac53da23e28b851545b25`, whose sole parent is the prior `6b8422966b1411dff6d7c486f4e9a549acecc761` source. Its six-file delta is the three connection wrappers and their regressions. All six are explicitly added to expected-hashes.json; the entire Git tree remains verified. The public source index retains its exact 3,231-entry conservative selection and updates only these six blobs plus its base identity. The historical discarded-import review describes the old observed build and is unchanged: its 20 source files and compiler/config pins are byte-identical across this merge.

The proposed 18-path decoder integration patch remains SHA-256 `67938c85de4f8e34b673cabfded73ad765fa183ee94fab0b325930ce5d6fcf72`. The primitive remains `5b7e858b87ab29fef86dc374c48a5ee105bb7c4d3af3a5f1fa603f46a4fd6dec`. Later registry/producer/main merges are outside this reviewed source snapshot.

## Four mandatory sequential phases

1. Original uninstrumented 490 tests plus both positive owner assertions, with all existing source/build/coverage/guard gates. This initializes the disposable PostgreSQL schema and synthetic writer role exactly as before.
2. A separate uninstrumented root runs three additional owner assertions: immutable incorrect synthetic password and independent valid control; exact owned query cancellation with partial durability and byte-identical manual same-isolate replay; over-budget bad-tail refusal with valid neighbors and later same-isolate success.
3. A separate instrumented root repeats those three assertions. Exact additive transforms observe real default pg clients, actual inflater/reader operations, message/writer boundaries and handler completion. Original operations, receiver, arguments, return values, Promise identity and errors remain intact. Four active transformed paths are pg-sql.ts, lane-health-store.ts, strict-gzip-reader.ts and data-api.ts. Lane-health clients are included because the queue performs real verdict work. read-store.ts remains merged and byte-identical; this slice makes no read-route native coverage claim.
4. A distinct genuine unfixed control root replaces only pg-sql.ts and lane-health-store.ts with their exact parent bytes, then applies the same forwarding hooks. Its one auth assertion must witness actual 28P01, no query or end calls, real socket/driver closure, and the fixed lifecycle oracle's specific missing-end rejection. Generic failure cannot qualify the negative control.

All four source trees are materialized before execution, with fresh directories and exact inventories. The uninstrumented reference is never temporarily edited/restored. Variant verification compares every path, file hash, link and executable mode; only the closed phase data file and exact four transformations may differ. No production repository source/configuration changes are proposed.

Expected total after successful hosted execution: 492 baseline + 3 uninstrumented functional + 3 supplemental lifecycle + 1 genuine unfixed control = 499. Seven additional tests do not replace any prior check. Baseline coverage thresholds and required identities remain unchanged; extra phases do not supply substitute coverage.

## Fixed local fault and observation boundary

The service image, tmpfs, numeric loopback mapping, read-only service inspection, actual Hyperdrive plugin observation, native executable/source pins and host/thread guards remain unchanged. The immutable bad-auth variant changes only the fixed synthetic password sent to the same single `127.0.0.1:55432` mapping. It cannot change roles, authentication settings, destinations, schemes or TLS behavior.

The cancellation controller owns an uncommitted insert at a reserved synthetic key. It revalidates database, writer role, exact SQL, PID, backend_start, query_start, age and still-held transaction lock before the identity-filtered pg_cancel_backend. The supplemental real driver must observe 57014 classified as a user-request cancellation; a natural statement timeout cannot satisfy the oracle. Controller ROLLBACK precedes exact partial readback. Extrinsics and account events remain durable; chain event and coverage are absent until replay. Native ACK/retry sets, complete row values, no duplicate keys and writer-session drain are asserted.

Each phase uses one genuine Wrangler dry-run bundle. Private multipart/module/map/source evidence is preserved and independently revalidated. Supplemental maps must associate the exact owner, pg-sql, lane-health, strict reader and observer bytes. The actual pg package and serializer/Cloudflare transport identities remain mandatory. Private bounded receipts retain lifecycle ledgers, query-cancellation identity and real owner process observations; publication reruns their validators and exact native launch/exit correlation.

The reader observation does not infer a read was pending from Promise bookkeeping. It requires actual cancellation/destruction, settlement of observed reads, no post-cancel advancement and no writer entry for the refused message. The original genuine pending-next native tests remain mandatory in the 490-test phase.

## Packaging and reporting

The native overlay cap remains 64 files, 512 KiB per file and 2 MiB total. Pure cases and five large pure-only resources remain in the harness and continue to run; they are omitted only from the native copy. Packaging regressions require all direct sibling imports, all safety/evidence helpers and the public index. No thresholds are raised.

The public upload inventory remains only qualification-summary.json and candidate-coverage.lcov. Extra private files are allowlisted and bounded; no raw SQL, backend identities, rows, errors, paths, logs or lifecycle ledgers are uploaded. A successful combined status requires original baseline revalidation and all three additional phase revalidations. Failed or missing evidence remains failed. Other unref'ed native exits may remain unobserved and are disclosed; every scenario-owned runtime must have a real correlated exit.

Production memory and CPU remain inconclusive. Manual replay does not establish broker timing, automatic redelivery/backoff, budget exhaustion or DLQ routing. Local direct TCP does not establish production Hyperdrive pooling/failover. Deadlines are failures and cleanup attempts, not per-message cancellation. No actual traffic activation or provider command belongs to this dedicated workflow; existing repository branch automation is outside this workflow and must not be described as globally absent.
