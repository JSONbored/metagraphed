# Minimal whole-owner validation proposal

Status: the first reviewed snapshot was published to draft PR #12862 at
`ca94ffb327199b1e3ba90ad9c67b4b8ab5bd6052`. Hosted run
[39477904356](https://github.com/JSONbored/metagraphed/actions/runs/39477904356)
started the isolated PostgreSQL service and native tests but failed owner
qualification. All 490 baseline assertions passed. The diagnostics rerun
[39480601007](https://github.com/JSONbored/metagraphed/actions/runs/39480601007)
also failed owner qualification while preserving all 490 baseline passes. It
located a rejected raw build import and an incorrect inspector URL assumption.
The inspector correction advanced the next hosted attempt, described below.

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

Pinned Miniflare returns a websocket inspector origin. The observer now validates
that exact `ws://127.0.0.1:<port>/` shape and derives the HTTP `/json/list` endpoint
on the same numeric-loopback port. Alternate hosts, schemes, credentials, paths,
queries and fragments remain refused. The raw build still accepts only Node and
Cloudflare builtin external imports; new fixed refusal labels distinguish three
known optional package names from `other` without publishing a raw target. No
additional module is permitted on the strength of an inferred failure cause.

## Source-bound optional CommonJS record

Run [39482215203](https://github.com/JSONbored/metagraphed/actions/runs/39482215203)
passed the real queue-owner assertion and all 490 baseline assertions, with zero
guard denials. The queue assertion validates the real overlap, 80-row readback,
session drain, private build/source identity and actual native exit before it
passes. Combined qualification still failed because the raw build identified
`pg-native` as its refused external import.

The proposed exception recognizes one unresolved optional CommonJS require from
[pg 8.22 source](https://github.com/brianc/node-postgres/tree/b617619f9fb6fbd231731823e2732a2927ded4be/packages/pg).
It requires exact release-source bytes for the ESM facade, main entry, native
entry and native client; exact metadata edges and require-call kind; positive
output contribution and actual source-map mappings, including the require line;
and association with the exact registered output/map bytes. Only the proven
output/import tuple is recognized. All other package imports remain refused.

No pg-native package, native addon, alias or force-native environment/binding is
supplied. The genuine builder and output bytes are unchanged. Pinned esbuild
retains this unresolved try/catch require behind its callable runtime shim; it
does not become an eager ESM import. This is not a universally closed graph or
proof that every optional pg mode works. Any successful raw run will establish
only that the optional branch was non-fatal for that exact scenario. No launch,
network, native addon or provider permission is added. Actual output and raw-owner
acceptance remain dependent on the exact hosted rerun.

## Canonical dependency input identity

Run [39485269601](https://github.com/JSONbored/metagraphed/actions/runs/39485269601)
again passed the real queue-owner case and all 490 baseline assertions, with zero
guard denials. The raw case failed inside the optional-import proof adapter.
Its bounded frames did not identify the exact checker line, so the path-spelling
explanation remains a source-supported inference until a successful rerun.

The pinned production builder uses esbuild's default symlink resolution. Its
metadata may name dependency files by their canonical path relative to the
candidate, because node_modules points to the separately installed locked base.
One shared identity mapper now recognizes only exact normalized project paths
or exact relative paths into that verified canonical dependency root. The real
metadata key is retained for input edges and output contributions; no metadata
or builder output is rewritten. Logical custody names remain node_modules/… .
Duplicate aliases, foreign roots, dot/traversal spellings, and filesystem aliases
are rejected. Both metadata and custody paths must resolve to the exact expected
canonical file. Source bytes, mapped-call proof and hashes remain mandatory.
The checker now has one additional fixed diagnostic file index, without raw
messages or path disclosure. Hosted compatibility and combined acceptance are
still pending.

## Complete bounded build-failure diagnostics

Run [39487268538](https://github.com/JSONbored/metagraphed/actions/runs/39487268538)
passed the real queue-owner case and all 490 baseline assertions again, with zero
guard denials. The fixed checker frame identifies the earlier external-import
assertion: an additional non-pg-native, non-builtin external was refused before
canonical source identities were checked. Its exact package is still unknown,
and the canonical-path compatibility hypothesis remains untested.

Failure-only diagnostics now identify fixed stages across the raw build,
preservation, private validation/association and optional-import proof. A failed
optional proof performs separate bounded complete scans of input/output metadata
and reports only six fixed external-import categories and integer counts. A
malformed, proxy, accessor or over-budget scope is explicitly incomplete with
zero counts. The scans never run before or instead of a proof check. They cannot
grant an import exception or supply acceptance evidence.

The public reducer accepts only one exact stage and, for optional-proof failures,
one canonical bounded count marker per scope from the one failed required
assertion. Duplicate, conflicting, malformed or excessive diagnostics are omitted.
Publisher-only private association failures use the same reducer, accepting only
closure-private branded markers. No raw target, source, path, error or cause text
is copied. Private errors retain
the original cause, and already branded errors are rethrown unchanged to avoid
duplicated marker chains. All original proof checks, runtime/service/network
rules and acceptance gates are retained. Hosted qualification remains failed
until an exact run supplies every required owner and baseline proof.

## Public identities for refused input-only records

Run [39489525233](https://github.com/JSONbored/metagraphed/actions/runs/39489525233)
again passed the real queue-owner case and all 490 baseline assertions, with zero
guard denials. Complete metadata scans found 33 additional input externals and
zero additional output externals. Those 33 records are still unidentified.
Pinned esbuild source shows that discarded TypeScript imports can appear as input
externals, but the aggregate counts do not prove these records are type-only.
The canonical dependency spelling stage has still not been reached.

This diagnostic-only snapshot preserves the existing refusal. After that proof
fails, a read-only adapter can identify at most 64 records against a SHA-256-pinned
index of public repository sources. The index contains 3,231 mode 100644 paths
from the exact base plus changed/new code blobs from the unchanged integration
patch. Its conservative extension subset is .ts, .tsx, .js, .jsx, .mjs, .mts and
.cts; .cjs and executable-mode files are deliberately excluded. Paths containing
public route syntax such as $ or [.] remain exact indexed names.

Both bounded original metadata scans must complete before any identification.
Each emitted record requires an exact indexed source path, recomputed Git blob,
matching metadata byte count, unique canonical input identity, fixed import kind
and import index, and absence of its exact target from every original output
import path. At most three bounded numeric quoted-text locations aid subsequent
manual source inspection. These are literal occurrence locations, not syntax
classification or proof of TypeScript erasure.

Only the verified public path, pinned Git blob, import index/kind and numeric
locations can be published. Target text/hashes, metadata keys, source bytes,
dependency/private paths, URLs and arbitrary errors are never copied. Source
reads require canonical containment, nonsymlink ancestors and bounded regular-file
opens. Unindexed, unavailable (including missing/unreadable/oversized/aliased),
changed, ambiguous, emitted or otherwise unsupported records remain explicit
fixed refusal counts. Incomplete scans and overflow cannot claim complete
identification. The publisher independently reconstructs each bounded report
against the same immutable index and rejects duplicate or malformed markers.
The original marked failure is retained only in a private weak reference map,
so a rendered error-cause chain cannot duplicate the strict stage/count markers.
No diagnostic result participates in acceptance or grants an import exception.
Actual individual identities and combined owner qualification remain pending
the exact reviewed hosted rerun.

## Third-party fixture notice

The inert source strings in owner-pg-source-fixtures.json and
optional-pg-source-fixtures.json come from node-postgres at the pinned release
commit above. Its original notice is preserved here:

```text
MIT License

Copyright (c) 2010 - 2021 Brian Carlson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
