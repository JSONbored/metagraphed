# Minimal whole-owner validation proposal

Status: the first reviewed snapshot was published to draft PR #12862 at
`ca94ffb327199b1e3ba90ad9c67b4b8ab5bd6052`. Hosted run
[39477904356](https://github.com/JSONbored/metagraphed/actions/runs/39477904356)
started the isolated PostgreSQL service and native tests but failed owner
qualification. All 490 baseline assertions passed. The diagnostics update has
passed local pure/static checks and awaits its reviewed hosted rerun.

## Immutable baseline and test split

Base: `6b8422966b1411dff6d7c486f4e9a549acecc761`.
Prior qualified head: `88b3cededcf01ddf82c86c10ca80c4e5284bb3b3`.
The 18-path integration patch remains SHA-256
`67938c85de4f8e34b673cabfded73ad765fa183ee94fab0b325930ce5d6fcf72`.
The strict primitive remains SHA-256
`5b7e858b87ab29fef86dc374c48a5ee105bb7c4d3af3a5f1fa603f46a4fd6dec`.
Production repository paths and existing Validate/deployment configuration remain
unchanged. Only this validation job applies the patch and exact hashed test overlay
to an isolated base archive. All ten baseline suites and exactly 490 assertions
remain required, with two additional named owner assertions (492 total). Existing
coverage sources/thresholds and required custody cases remain intact.

## Minimal scenarios

1. Raw: the real API entry, production split/minified builder and complete module
   graph run in one named native Worker. A real no-work scheduled event warms the
   lazy API graph first. One measured scheduled event captures 25 blocks on each
   of two lanes. Local host-generated RPC responses are held until both lanes
   arrive, then released. Actual D1 state and R2 gzip contents are read back and
   checked exactly. This is two simultaneous RPC-response waits, not two pg writes.
2. Queue: the genuine Wrangler upload multipart runs the unwrapped queue entry,
   real pg Client/serializer/CloudflareSocket and unchanged four-family writer.
   Two distinct ten-message events execute in one isolate. Two outside-owner
   transactions hold disjoint first-extrinsic keys. PostgreSQL lock witnesses must
   prove both real writes are blocked while both events remain pending. After
   release, exact native ACK sets, all 80 complete rows and two zero-writer-session
   drain samples are required. This baseline is module startup before the first
   queue event, not a warmed-writer retention study.

Setup/verification/event/teardown waits are bounded. A deadline remains a failure;
it never claims cancellation or invents a clean completion. The known pinned
createPgSql connection-failure cleanup bug is not overlaid or declared fixed.
Failure/redelivery/cancellation and the larger resource stress matrix are deferred.

## Disposable local database and transport

The official linux/amd64 PostgreSQL 17.11 image is fixed to
`docker.io/library/postgres@sha256:66aafa11cf15800a3c94763f7e11d1e7b2e37e5e84bc4ce027cb6e1e4bfaf4df`.
Its config digest is
`sha256:589f742565e4f6d22149176b032974f55f8201a8a37b71ed587ec5c6902e689f`.
Only `127.0.0.1:55432:5432` is published. Fixed fictional fixture accounts have no
production use. PGDATA uses exactly
`--tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,nodev,size=268435456`.
No bind, volume, device, privileged or host-network setting is permitted. Actions
owns the service lifecycle; its post-job forced removal releases the tmpfs without
leaving an anonymous Docker data volume. Service memory is not observed.

A setup-only bounded read of the Actions-provided service ID validates the actual
image/platform, fixed command, environment, local bridge, published mapping and
empty Mounts plus exact HostConfig.Tmpfs. Docker is never available to owner child
roles. Raw inspection/environment/mount contents are neither printed nor uploaded.
Health and restart count are explicitly setup-only observations. Expected server
version is separately verified by real SQL (`server_version_num=170011`).

Hyperdrive has exactly one fixed plaintext fixture URL with `sslmode=disable`.
The actual pinned plugin invocation is observed before native launch and must
return exactly `hyperdrive:HYPERDRIVE` with external TCP `127.0.0.1:55432` and no
other mapping or TLS proxy. The wrapper preserves original context/result and is
restored. This is native workerd TCP; Node socket-denial counts alone do not prove
its containment. The source-fixed mapping is a separate checked boundary.

Primary sources: [official image metadata](https://github.com/docker-library/repo-info/blob/d43cb516eaae5fe8aa0cac7fc10cd0a27c064adc/repos/postgres/remote/17-bookworm.md),
[Actions Docker lifecycle](https://github.com/actions/runner/blob/5fea684c16ea010a8d2b0d32dd60bae8a6372f46/src/Runner.Worker/Container/DockerCommandManager.cs),
[pg release source](https://github.com/brianc/node-postgres/tree/b617619f9fb6fbd231731823e2732a2927ded4be/packages).
The six public pg source strings in owner-pg-source-fixtures.json are inert test
fixtures from that MIT-licensed release, never imported as a driver. Fixed hashes
require the actual chained-map sources, including pg-protocol/src/serializer.ts
and pg-cloudflare/src/index.ts; an empty default transport cannot substitute.

## Identity, observations and privacy

Private build directories have exact inventories, count/per-file/total caps,
regular-file/no-follow checks and source containment. Queue multipart bytes and
raw builder metadata/maps/output hashes bind the modules actually registered.
Private output/source bytes are excluded from upload. Actual owner process PID,
start ticks and executable are observed and matched to the runner-verified nested
Miniflare workerd 1.20260730.1 path/hash, unique guarded launch and actual exit.
The root workerd 1.20260907.1 is not interchangeable. PIDs/paths are not published.
Pinned Miniflare disposal sends SIGKILL and awaits its actual exit; that truthful
owner cleanup is required independently of generic unobserved compiler exits.

The runner opts into one exact inspector launch addition: only test-worker plus
the nested pinned runtime may append `--inspector-addr=127.0.0.1:0`. Missing/false
mode retains the baseline seven-argument rule. Other roles, binaries, hosts,
ports, reordered/extra flags and nonboolean modes are refused. All credential,
network, subprocess and synchronous-fetch thread constraints otherwise remain.

Three same-isolate observations use one monotonic origin: baseline, both owners
blocked, and drained. V8 heap/backing/embedder fields and native/host RSS/HWM are
reported separately. Unsupported native-external and PostgreSQL memory remain
unobserved. Explicit phase samples can miss synchronous peaks; they are not a
continuous peak measurement. Raw baseline follows a no-work warm-up; queue
baseline precedes its first event. Public workerd enforces neither production
isolate memory nor request CPU limits, so both production acceptance fields are
always inconclusive. No production CPU budget is invented.

## Proposed hosted sequence

Use only the reviewed workflow: locked Node 22.23.2, contents:read, no retained
checkout credentials, npm ci --ignore-scripts, all pure checks, immutable archive
plus patch and owner-overlay.json, setup-only service validation, then the guarded
runner. The exact dry-run Wrangler build remains genuine and cannot publish.
Finally the dedicated owner publisher validates baseline tests/coverage, both
owner proofs, private source/build/runtime/native-lifecycle evidence and service
identity before emitting only the existing bounded summary and sanitized LCOV.
Raw logs, SQL values, source bytes, URLs, argument vectors and Docker JSON are
never uploaded. Any missing, skipped, failed, mismatched or refused evidence
prevents a pass. No ready/merge/deployment action is part of this proposal.

## Failed-run diagnostics

The first owner run preserved all 490 baseline assertions and zero guard
denials, but failed owner qualification. Its artifact did not identify the owner
failure locations, so no owner cause or success is inferred. The optional
ownerProgress summary now reports only fixed owner identities, statuses, counts
and up to five numeric source positions per owner (ten across both owners).
Paths are represented by a fixed allowlist index. Titles, errors, stacks, source
text and arbitrary paths are never copied. These diagnostics cannot satisfy or
alter any acceptance validator; missing evidence still prevents qualification.
