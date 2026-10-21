# Inactive strict gzip primitive candidate

This repository-layout draft adds a standalone primitive and focused tests.
It is inactive: no existing production module, Worker entry, queue consumer,
limit, retry/custody path, or configuration is modified.

`src/strict-gzip-reader.ts` has this final repository-formatted identity:

```
5b7e858b87ab29fef86dc374c48a5ee105bb7c4d3af3a5f1fa603f46a4fd6dec
```

The pre-format tested source SHA-256 was
`ee7e96a9ea415685cd823819282eb7631911df8e73ced7d6ec28c810fe228d43`.
The intermediate formatted source was
`35ecab0f350a22fc3b5e86a97aa04534ca5b8537fdaa46ca46468340191c95dd`.
Formatting changed only grouping parentheses and whitespace in `u32`; normalized
TypeScript semantic ASTs were verified identical. That source passed the same
78-test isolated native policy qualification. Those receipts remain unchanged.

The current scoped refactor removes only the two redundant range checks inside
private integer-read helpers. Exact executable-token comparison verifies that
no other executable code changed. Both `u16` calls are bounded by the initial
length >= 18 check and optional-field cursor <= length - 8. Both `u32` calls
follow the short-circuiting exact eight-byte trailer check and read at length - 8
and length - 4. All reachable header/trailer validation remains. These invariants
require the documented immutable compressed snapshot. The current final bytes
also passed the 78-test isolated native policy suite, exit 0, with no recorded
host or Worker outbound attempt and all historical receipt hashes unchanged.
Genuine boundary fixtures
exercise exact/overlapping optional headers and trailer write splits.

The native helper asserts this final SHA-256 and records the fixture bundle digest.
Its bundle permits exactly three source files: the primitive, the synthetic
Worker fixture, and the synchronous observer. Built-in Node modules are external.
Changing the primitive requires a fresh review and qualification; do not update
the expected digest merely to silence a test.

## Primitive contract

The caller owns an immutable compressed snapshot. The primitive returns at most
8192 decoded bytes per demand, admits at most 4096 compressed bytes per native
write, and permits one pending write/end. It validates single-member gzip
framing, CRC32, ISIZE, optional headers and FHCRC. It rejects trailing data and
concatenated members.

`cancel()` is synchronous. It wakes a pending `next()`, destroys the inflater,
and does not wait for a native callback. `return()` performs the same cancellation
and returns a done result. Concurrent `next()` calls are rejected.

Compressed-input admission and decoded-size policy remain caller concerns.
The 8192-byte delivery size is not total memory. A readable threshold may
overshoot by one output chunk, and current, queued, native and compressed backing
allocations can coexist.

The finite-output-credit argument was checked against the matching workerd
release source at commit `26b5461b7dcc640bb16072f1ba6f2c6df82572ba`
(`v1.20260730.1`): the [zlib continuation](https://github.com/cloudflare/workerd/blob/26b5461b7dcc640bb16072f1ba6f2c6df82572ba/src/node/internal/internal_zlib_base.ts),
[Readable queue](https://github.com/cloudflare/workerd/blob/26b5461b7dcc640bb16072f1ba6f2c6df82572ba/src/node/internal/streams_readable.js),
and [Transform coordination](https://github.com/cloudflare/workerd/blob/26b5461b7dcc640bb16072f1ba6f2c6df82572ba/src/node/internal/streams_transform.js).
That is release-source provenance, not reproducible binary-source attestation.
The observed readable-queue maximum is neither a whole-owner hard memory bound
nor isolate-charged memory. Process RSS and sparse JavaScript heap observations
cannot substitute for the latter.

## Deliberately proposed resource-first policy

The byte-limit policy appears only in the synthetic Worker consumer. Once a
decoded chunk would exceed its budget, it synchronously cancels and reports a
resource refusal. It does not decode the tail to replace that refusal with a
later malformed-gzip classification.

The original equivalence gate remains failed on these exact cases:

| Original failing test                            | Prior native result | Bounded result   |
| ------------------------------------------------ | ------------------- | ---------------- |
| native error/expansion precedence: bad-crc       | malformed           | resource refusal |
| native error/expansion precedence: bad-isize     | malformed           | resource refusal |
| native error/expansion precedence: truncated     | malformed           | resource refusal |
| native error/expansion precedence: trailing-zero | malformed           | resource refusal |

The machine-readable names and original observations are in
[`tests/fixtures/strict-gzip-policy-differences.ts`](../tests/fixtures/strict-gzip-policy-differences.ts).
New tests assert these differences explicitly as a proposed policy. They do not
rename, delete, skip, or turn the original standalone equivalence failures green.
Accepted in-budget inputs still match the native reference and their expected
bytes/digests; malformed cases below the budget remain malformed.

This proposal concerns resource correctness only. It does not change ACK/retry,
custody, production imports or deployment. Whole-isolate peak memory and
production CPU remain unqualified.

## Isolated evidence already obtained

The earlier standalone native primitive suite preserved four leaf equivalence
failures. Its other framing, backpressure, and cancellation checks passed. The
separately authorized proposed resource-first suite subsequently passed 78/78
tests while hashing and preserving those original failing receipts.

The latter run accepted exactly 79,393,024 valid decoded bytes. Its larger
refusal case accepted 79,392,752 bytes before an 8192-byte overflow chunk; native
production was 79,413,248 bytes, observed queue peak was 15,788, and at most one
write remained outstanding. Input/output counters did not advance after cancel.
Of the fixture's 16 MiB beyond the ceiling, 20,224 bytes were materialized as
bounded witness/prefetch and 16,756,992 bytes remained unexpanded. The claim is
an unread tail beyond accounted credit, not an entirely untouched final 16 MiB.

The actual repository-layout adaptation also ran under Vitest 4.1.11 with the
exact main targeted config and all three setup files, using pinned dependencies.
All 393 new tests passed: 188 direct real-Node tests, five isolated coordinator
doubles, and 200 real-workerd tests. Four existing pure module-state-registry
tests also passed. Its fifth test imports the absent whole Worker graph and was
explicitly unrun in this partial source workspace; no new test was skipped.

The changed primitive measured 100% host-V8 coverage: 101/101 lines, 115/115
statements, 15/15 functions and 60/60 branches. Existing coverage include/exclude
rules and thresholds (85 branches, 90 functions, 92 lines/statements) were
unchanged and passed across the two-source partial workspace. This is measured
changed-source coverage, not a Codecov verdict or full-repository CI result.
The first adaptation run's 374 passing tests and failed coverage gate remain
preserved; the boundary/coordinator tests and scoped refactor address its gaps.

Scoped strict TypeScript checks and the pinned Prettier 3.9.6 check pass. Main's
full configured typecheck, lint, complete test graph and CI remain unrun. No
whole-isolate peak-memory or production CPU conclusion follows from coverage.

## Repository-native test layout

- `tests/strict-gzip-reader.test.ts` imports the primitive directly under
  Vitest's Node environment for host-V8 coverage. It exercises framing,
  optional headers, truncation/corruption, native errors, cancellation,
  concurrent reads and completion without mocking the codec. It makes no
  workerd memory claim.
- `tests/strict-gzip-reader-coordinator.test.ts` uses a per-file isolated
  `createInflateRaw` double for synchronous event/lifecycle timing. It covers
  write failure, cancellation/error during read, newly readable output and
  no-output callback wakeups. These five tests provide no decompression or
  native-resource evidence; real CRC and framing generation remain intact.
- `tests/strict-gzip-reader-isolate.test.ts` uses main's `beforeAll`/`afterAll`
  Miniflare lifecycle style with a focused helper. It checks actual workerd
  inflater behavior, late stalls, pending cancellation, and proposed resource
  refusal. It does not build Wrangler or import the application entry.
- Fixture generation happens in Node. Large original strings/buffers never
  enter the Worker; only gzip bytes and scalar controls do.
- The synchronous observer delegates the real inflater methods without an
  extra output queue or async output wrapper. Its controlled callback gate is
  used solely for pending-read lifecycle tests, never resource bounds.
- Host guards are restored and native runtimes disposed in failure paths and
  `afterAll`. Node unit readers are cancelled in `afterEach`. The coordinator mock remains in its isolated test file; production modules
  and application state are not imported.

Native child-process execution does not produce host-V8 source coverage.
The separate direct-import Node and isolated coordinator suites supply host
coverage. Their measured percentages above are not native-memory evidence.
Existing coverage gates remain unchanged.

## Native fixture safety and scope

The helper uses installed esbuild and Miniflare, `cf: false`, host
`127.0.0.1`, port `0`, and a rejecting/counting Worker outbound service.
A temporary host socket guard permits only numeric loopback/IPC and rejects
TLS/external sockets. Runtime/binary override environment variables are rejected.
No Wrangler command, production config, provider, storage binding, credential,
download, installation, publication, or deployment is involved.

Pinned fixture versions match main's installed test stack: Miniflare
`5.20260730.0-alpha`, workerd `1.20260730.1`, and esbuild `0.28.2`.
The host guard is defense in depth, not a child-process firewall. Main's own
no-outbound setup remains enabled.

After this draft is deliberately applied to an appropriate main checkout and
the exact action is separately approved, the focused command would use the
existing harness, for example:

```sh
env -u ESBUILD_BINARY_PATH -u MINIFLARE_WORKERD_PATH \
  -u MINIFLARE_WORKERD_V8_FLAGS -u MINIFLARE_WORKERD_AUTOGATES \
  -u MINIFLARE_WORKERD_CONFIG_DEBUG -u VSCODE_INSPECTOR_OPTIONS \
  NODE_OPTIONS= NODE_ENV=test CLOUDFLARE_CF_FETCH_ENABLED=false \
  node node_modules/vitest/vitest.mjs run --config vitest.targeted.config.ts \
    tests/strict-gzip-reader.test.ts tests/strict-gzip-reader-isolate.test.ts \
    tests/strict-gzip-reader-coordinator.test.ts
```

This example is not execution approval and is not a substitute for the real
configured suite or coverage gates. Do not run it in the isolated draft tree:
the tree intentionally has no dependency installation or copied repository
configuration.
