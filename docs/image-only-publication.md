# Image-only artifact publication

An image release replaces the current and compatibility landing PNGs without refreshing chain data, probing endpoints, rebuilding the registry, or changing its freshness timestamps. It clones the identified active immutable manifest, replaces only the approved image entries, and promotes a new pointer through the same governed release owner as normal data publication.

The full and compact manifests retain all unrelated entries and unknown fields. The original build-summary bytes are copied into the new immutable run. The pointer retains `published_at`, `generated_at`, native capture time and health counts. `release_bound_at` in the separate completion receipt records publication of the artwork; it is not a new data observation.

## Review and publication

The `Publish Cloudflare Backend` workflow has explicit `data`, `images`, `bootstrap`, and `resume` scopes. Manual runs default to `dry-run`. Only main can run these jobs, and real image/control publication verifies the checkout still matches main before writing. The `images` job does not enter the production data build, adapters, probes, changelog, manifest generator, or general R2 uploader.

The same stages can be inspected separately:

```sh
node scripts/publish-og-image.ts capture /absolute/new-bundle-directory
node scripts/publish-og-image.ts render /absolute/new-bundle-directory
node scripts/publish-og-image.ts plan /absolute/new-bundle-directory
```

`capture` explicitly reads the active pointer, immutable full and compact manifests, original build summary, and the content-addressed registry summary named by that manifest. It verifies the compact manifest against the pointer's existing parsed-JSON hash convention. The pointer currently has no full-manifest digest; the source receipt binds the exact full bytes obtained through authenticated storage access.

`render` uses the captured summary and approved renderer. It records the exact source revision, font digests, image digests, MIME, dimensions and byte counts. A replay uses the saved PNG and receipt, without downloading fonts again. `plan` is offline and produces exact intended immutable keys. It rejects changed source bytes, stale renderer versions, incomplete receipts, extra or nested PNGs, symlinks, malformed PNG chunks and invalid pixel extents. PNGs are bounded to 1200×630 and 2 MiB.

Real `publish` and `resume` require the main workflow owner, Cloudflare account/token/namespace, and both existing R2/KV write guards. They cannot be enabled merely by passing a write flag in an arbitrary checkout. Bundles from a different renderer revision are not accepted by `publish`. The workflow retains review bundles for 30 days; durable operation and completion receipts remain in R2.

## Migration without interrupting data publication

This code does **not** initialize a production journal on merge. During the explicit `METAGRAPH_RELEASE_MIGRATION=pending` window, ordinary publication retains its existing pointer behavior only while both the journal and activation marker are absent. Image publication remains disabled. The first verified journal or activation marker permanently disables that compatibility branch, including for queued runs of this implementation.

The deployment sequence is:

1. Merge and deploy the governed publisher. Confirm all older publish workflows have completed or been stopped; a running old revision does not acquire the new concurrency group. Do not initialize while an older or external writer can still promote a pointer.
2. Run an image `dry-run` capture under the common workflow owner. Review the returned exact `pointer_hash`, its immutable control references, the original data timestamps, and source/render receipts. Confirm the identified release is settled. A KV read by itself is not proof of settlement; use the prior publisher completion and normal serving evidence too.
3. Dispatch `publication_scope=bootstrap`, `publish_mode=publish`, and the reviewed `expected_pointer_hash`. Initialization rejects a different visible pointer, writes and reads back the committed journal, then writes the durable activation marker. It never changes the active pointer. If the pointer advanced between review and bootstrap, capture and review the new base.
4. If initialization is interrupted after the journal write, repeat the same expected-pointer operation. Existing matching state is retained and the missing activation marker is completed. If ordinary publication advanced the valid journal in the meantime, review its current settled head before completing activation.
5. Confirm activation, run a fresh image dry-run, then publish the reviewed image release. Verify the ordinary GET bytes separately. Remove the temporary migration environment setting in a subsequent reviewed cleanup once activation is established.

No expected production pointer is embedded in source: it would become stale before deployment. The capture receipt is the concrete migration input. These commands and workflow scopes prepare the operation; running local tests does not bootstrap or publish anything remotely.

After activation, a missing or malformed journal fails closed even if the migration environment variable remains present. Never delete the activation marker to bypass an error. Restore the identified journal or reconcile the pending operation. Rolling the code back to a pre-journal pointer writer after activation would bypass coordination and is not a safe rollback.

## Durable intent and recovery

Every approved repository pointer writer uses `artifact-release-commit.ts`. The workflow uses one fixed `publish-cloudflare-release` concurrency group across refs and modes, with cancellation disabled. R2 holds the committed head and `prepared`/`pointer-pending` intent. This is a governed owner, **not** a distributed lock or a Cloudflare KV compare-and-swap. An arbitrary credential holder or an older workflow that bypasses the owner remains outside this guarantee.

Immutable PNG and control objects are uploaded and read back before intent is prepared. A timed-out upload first checks whether the exact bytes were accepted; an existing different object is a collision, never an overwrite. The durable operation receipt records all prerequisite keys and hashes, so recovery does not depend on a retained runner directory.

Before a pointer attempt, the exact intent is saved and verified. An acknowledgement timeout leaves it pending. `resume` loads that exact operation and its immutable bytes; it either verifies or retries the same target. It cannot start a different release, restore older catalog references, or erase the pending state. A completed release replay is idempotent; if a newer release has superseded it, replay reports `superseded` without writing the older pointer.

Normal publication reconciles the journal **before** mutable uploads. It first resumes any exact pending operation and proceeds only after that operation is bound. An unresolved prior intent blocks the new upload. Real data publication requires all three credentials, including the KV namespace; a missing namespace cannot fall through to an R2-only upload. A successful image render must have a complete source-bound receipt. If rendering skipped, it stages the active approved image bytes and retains image provenance in the next immutable manifest. A checkout older than an active image version cannot delete that newer binding. Failure to read or verify an existing approved image blocks replacement; it does not silently revert to an old mutable latest object.

## Serving verification and limits

After binding, run:

```sh
node scripts/verify-og-image-release.ts /absolute/reviewed-bundle-directory
```

Each invocation makes one ordinary GET to the canonical API image URL and records MIME, PNG integrity, digest and cache headers. It reads the durable release head and reports `release-bound` or `superseded` separately from `served` or `serving-pending`. HTTP 200, HEAD, ETag, fallback artwork, or a cache-busting query does not prove the intended image is served.

Observation is resumable for at most 12 GETs within 75 minutes and never holds the release write owner. The cache can still retain older bytes beyond a particular observation window; a pending serving check is not permission to roll back newer data.

Each capture/render/commit process is bounded by 64 requests, 128 MiB total transfer and ten minutes. Individual reads are capped independently of Content-Length: full and compact manifests 8 MiB, source/build summaries 1 MiB, each font 1 MiB, and PNGs 2 MiB. Each immutable write has at most two attempts, with acceptance reconciliation before retry. Exceeding a bound stops preparation or retains explicit pending intent when pointer outcome is uncertain.
