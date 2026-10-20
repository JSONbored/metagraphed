# Validation-only strict gzip queue qualification

Draft validation proposal. Production `src/**`, `workers/**`, Wrangler config,
package manifests, and existing workflows/gates are unchanged in the proposed
repository diff. The integration exists only as `integration.patch`; the job
applies it to a disposable archive of base
`6b8422966b1411dff6d7c486f4e9a549acecc761`.

`expected-hashes.json` pins the patch, original Git blobs, and resulting
source/test files. The primitive remains byte-identical to commit
`1c4518f8b4b6837f8978222bcab83c7a41ec9f7d`, SHA-256
`5b7e858b87ab29fef86dc374c48a5ee105bb7c4d3af3a5f1fa603f46a4fd6dec`.
No passing qualification, provider result, or production activation is claimed.
The [first hosted attempt](https://github.com/JSONbored/metagraphed/actions/runs/39457875085)
passed setup and synthetic regressions, then failed closed on a runtime policy
refusal before focused test evidence. Fixed-enum diagnostics identify refusals
without publishing raw logs or relaxing the policy.

## Invocation

After reviewing the complete proposal, installing the full base lockfile with
`npm ci --include=dev --ignore-scripts --no-audit --no-fund`, and
applying the patch to a separate directory:

```sh
DECODER_QUALIFICATION_RECEIPTS=/absolute/temporary/receipts \
  node tests/qualification/strict-gzip/run.ts \
    /absolute/isolated/candidate /absolute/pinned/base
```

The runner rejects a candidate inside the harness checkout or base directory,
verifies the pinned base commit, original Git blobs, patch digest, every declared
candidate hash, all ten executed fixture identities, and the primitive digest.
It also verifies the exact patch-path allowlist and the entire candidate source
tree against the pinned Git archive plus those changes. Unlisted source changes,
extra files, changed symlinks, and changed executable modes fail verification.
It repeats candidate verification after execution, allowing only installed
dependencies and named temporary runtime directories. The native test's raw
deployment-bundle registration and assertions are unchanged.

## Scope and evidence

The focused list contains compression, decoded limits, strict-reader integration,
actual queue-consumer, custody-store, exact-bundle native custody, all three
primitive suites, and the corrected host-guard suite with all 18 synthetic cases. The workflow is path-scoped `pull_request` validation with no
draft exclusion; manual dispatch is optional. Existing Validate behavior and
coverage thresholds remain untouched. This focused job does not establish that
existing full gates passed.

Candidate-scoped V8 coverage includes only `src/strict-gzip-reader.ts` and
`src/sync-batch-compress.ts`. It inherits the repository's original threshold
values and retains text, JSON summary, and LCOV reports in the receipts. It is
not sent to Codecov and is not full-suite production coverage.

The guarded runtime uses a new temporary HOME, a minimal environment, no account
credentials, disabled Wrangler metrics/keyring, explicit empty Wrangler env
file, Miniflare `cf:false`, numeric loopback, local bindings, and the fixture's
refusing `outboundService`.

The preload is installed before coordinator imports and explicitly before
Vitest worker imports. All seven `child_process` APIs are guarded in every host
role. Each child must match a reviewed Vitest worker, esbuild service, workerd
runtime, Wrangler wrapper, or Wrangler CLI launch; unknown programs, arbitrary
Node scripts, shells, unsafe options, and extra environment values are refused.
Node descendants retain the exact preload. Native executable identities are
version-checked against lockfile entries, hashed, and rechecked on every launch.

Only the exact Wrangler `execFile` build-only action is amended with a preload.
Its original `deploy --dry-run` argument vector, empty env file, working
directory, environment keys, timeout, output cap, and Node custom-promisify
behavior are preserved and checked. The genuine bundle gate is not substituted.

The Node API guard refuses external TCP, numeric-string-port external TCP,
all TLS, name/external DNS, and UDP. Numeric loopback and nonempty local IPC
paths remain available. Empty IPC paths follow TCP host checks. Refusal events
contain fixed categories rather than original hostnames, URLs or arguments.
Caught denials still fail qualification. Coordinator, test-worker, Wrangler
wrapper, and genuine Wrangler CLI guard startup records are required, as are
matching start/exit records for every Node child. Vitest normally stops its
workers with SIGTERM. In that role alone, the preload records the actual signal
and immediately calls its captured original exit function with code 143, allowing
its exit listener to record real guard state. The parent still must observe the
child exit; its signal field may be null because the handler exits with code 143.
The public summary reports the count of observed worker SIGTERMs. No signal or
child-exit observation is inferred from registration or teardown requests.
Actual native exit/close
events are recorded when observed; unref’ed compiler services may exit after
their Node owner, so missing native exits are counted, never fabricated as
successful closes. Guard recording failures and event-budget overflow fail closed.

A passing receipt requires valid Vitest JSON for every one of the ten focused
files, all required custody/cancellation assertion titles, and no skipped, todo,
pending or failed tests. Both source coverage summaries and LCOV must be present
and valid. Exit zero alone is insufficient. Pure synthetic policy regressions
run before installation/native execution and never open sockets or start child
processes.

## Artifact boundary

Raw stdout/stderr is capped at 8 MiB; overrun terminates the qualification's
fresh process group and fails it. Shared guard events are capped at 1 MiB and
individual events at 2 KiB. Raw files have independent bounded reads. The
publication step rejects symlinks, unexpected files/directories, excessive
sizes, duplicate runs, missing required evidence on a pass, and reused output
directories. No raw receipt, log, environment, exception, argument or URL is
uploaded.

Only a fresh validated directory containing `qualification-summary.json`
(maximum 128 KiB) and optional `candidate-coverage.lcov` (maximum 1 MiB) may be
uploaded. The summary contains fixed identities, booleans, numeric results and up to 128
fixed-enum refusal-count groups. Unknown labels and excess distinct groups become
`other`; counts must sum exactly to the reported refusal total. No raw labels are
echoed.
Failed runs may include diagnostic progress for the ten pinned suite paths: fixed
statuses, numeric assertion counts, and fixed required-case indices in
`REQUIRED_ASSERTIONS` order. Failed required cases may include at most three
numeric line/column pairs extracted only from that suite’s exact candidate path;
raw titles, messages, stacks and paths are never copied. Missing or duplicate
required cases receive fixed `missing` or `ambiguous` statuses. These partial
results do not satisfy or replace the unchanged full acceptance checks.
Coverage contains only the two allowlisted relative source paths and metrics.
LCOV test/function names and arbitrary source paths are removed or refused.
The upload step runs only after successful publication validation.

## Explicit blockers and limits

- Local dependency installation failed with official-registry DNS `EAI_AGAIN`;
  no alternate route or native retry was used.
- Wrangler 4.129.1 is absent locally. The exact release wrapper was reviewed via
  its official repository and its source bytes are pinned before execution;
  compiled CLI behavior still has not executed under this guard. Unrecognized
  behavior must fail for review, never silently relax the policy or substitute
  another bundler.
- Dependency installation is a separate network-enabled phase with lifecycle
  scripts disabled. The job never runs an automatic postinstall/rebuild fallback.
  If required locked platform binaries are unavailable without scripts, setup
  fails for review of the minimum necessary local setup. Runtime API refusal
  does not claim that installation was network-free or that registry URLs alone
  constrain lifecycle traffic.
- The preload is not an OS firewall and does not constrain arbitrary native
  child sockets, native addons, or direct system calls. No system/network
  settings are changed.
- Raw-bundle custody outcomes do not prove native cancellation ordering or
  a whole-isolate memory/CPU bound. Primitive resource receipts and actual
  entrypoint outcomes remain separate evidence.
- DLQ delivery is explicit/manual in the fixture. Provider exhaustion,
  retention, and production KV consistency remain unqualified.

Local raw receipts include `native-output.txt`, `vitest-results.json`,
`network-events.ndjson`, and `receipt.json`; these are never uploaded. Failures
and missing evidence remain failures. The proposal grants no deployment capability.

## Workflow/toolchain provenance

Action pins and Node `22.23.2` match the pinned base's existing
`.github/workflows/validate.yml`, Git blob
`4f2f47c59c96d7a65b949cebdc5ba947a8dbdb16`, SHA-256
`7d7f2b6fcc8531aa743a4096194852d0a9bc522745bd80d6694e295e3d5cb077`:

- [Checkout pin, line 138](https://github.com/JSONbored/metagraphed/blob/6b8422966b1411dff6d7c486f4e9a549acecc761/.github/workflows/validate.yml#L138)
- [Setup-node pin and Node version, lines 268–270](https://github.com/JSONbored/metagraphed/blob/6b8422966b1411dff6d7c486f4e9a549acecc761/.github/workflows/validate.yml#L268-L270)
- [Upload-artifact pin, line 999](https://github.com/JSONbored/metagraphed/blob/6b8422966b1411dff6d7c486f4e9a549acecc761/.github/workflows/validate.yml#L999)

## Wrangler wrapper source review

The official `wrangler@4.129.1` tag resolves to commit
`87fd28ce586693e50aa17d410f121394c5fef24c`. Its
[wrapper source](https://github.com/cloudflare/workers-sdk/blob/87fd28ce586693e50aa17d410f121394c5fef24c/packages/wrangler/bin/wrangler.js)
has Git blob `774ecc2ce6ecdd77cfb3555d4af0daf825e4c66d` and SHA-256
`780661a508810f3b65786895b1ca9aacbc4f55d329ae6b8c1e49ec8433569f77`.
The job refuses any installed wrapper with different bytes. The reviewed
wrapper launches only its sibling CLI with `--no-warnings`, inherited Node
arguments (the required preload), unchanged dry-run arguments and inherited
stdio plus IPC. Its child-exit listener terminates the wrapper immediately;
the guard records actual child exit before that listener runs.
