# metagraphed contribution — deep reference

Exhaustive tables behind the `SKILL.md` playbook. Read the section you need. All commands run from the
repo root (Node 22, `npm install` first).

---

## 0. The single-file surface model (what changed, and why)

**Surfaces live in ONE file per subnet:** `registry/subnets/<slug>.json` → its `surfaces[]` array. A
community contribution **appends a surface to that one file** with `authority: "community"` and
`review.state: "community-submitted"`. If the subnet has no manifest on the base branch, the valid
one-file shape is a new `subnet:new` scaffold plus the community surface in that same file. The
Gittensory Gate flips the review state in place on merge; the build's prober fills
`verification`/health.

This **replaces** the old per-surface intake lane (`registry/candidates/community/<one-file-per-surface>.json`).
That lane created the farm: one surface = one file = one PR = one merge, so a contributor split a single
subnet's surfaces across several near-identical PRs (re-titled by `kind`) to multiply merges. The
single-file model closes it: a subnet's surfaces are **one diff = one merge**, the gate sees them
together (trivial dedup), and redundant/split PRs touching the same file are closed.

**Trust is preserved per surface, not per file:** `authority` (`official` / `provider-claimed` /
`community` / `registry-observed`) + the per-surface `review.state` tell the API and the gate how much
to trust a surface. "community-submitted" ≠ verified truth until the gate/build promote it.

---

## 1. The surface object (`schemas/subnet-manifest.schema.json` → `$defs.surface`)

Required on every surface: `id, name, kind, url, provider, auth_required, authority, public_safe`.

| Field                           | Type / values                                                                                                                                                                                                                 | Who sets it                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `id`                            | `^[a-z0-9][a-z0-9-]*$`, unique in the file (convention `sn-<netuid>-<provider>-<kind>`)                                                                                                                                       | you (helper)                                                    |
| `name`                          | human label                                                                                                                                                                                                                   | you                                                             |
| `kind`                          | see enum below                                                                                                                                                                                                                | you                                                             |
| `url`                           | public URI you can fetch                                                                                                                                                                                                      | you                                                             |
| `provider`                      | registered provider slug `^[a-z0-9][a-z0-9-]*$`                                                                                                                                                                               | you (`providers:list`; debut via `surface:add --provider-name`) |
| `authority`                     | `official` · `provider-claimed` · **`community`** · `registry-observed`                                                                                                                                                       | you → **`community`**                                           |
| `auth_required` / `public_safe` | boolean                                                                                                                                                                                                                       | you (`false` / `true` for auto-review kinds)                    |
| `source_urls`                   | array of URIs that **prove** the claim                                                                                                                                                                                        | you (≥1, required in practice)                                  |
| `review`                        | `{ state, submitted_by?, submitted_at?, confidence?, review_notes? }` — `state` ∈ `community-submitted · maintainer-reviewed · rejected` (HUMAN-governance axis only; machine verify/freshness is the separate probe overlay) | you set `community-submitted`; a maintainer promotes/rejects    |
| `verification`                  | `{ classification, verified_at, status_code, latency_ms, confidence_score, … }`                                                                                                                                               | **build prober only — never by hand**                           |
| `schema_url` / `schema_status`  | OpenAPI URL · `machine-readable`/`ui-only`/`not-captured`                                                                                                                                                                     | you (optional)                                                  |
| `rate_limit`                    | `{ requests, window, burst?, scope?, cost_notes? }` (`requests`+`window` required)                                                                                                                                            | you (optional, integration-only)                                |
| `auth`                          | `{ scheme, location?, name?, value_format?, … }` — **placeholders only, never a secret**                                                                                                                                      | you (optional)                                                  |
| `probe`                         | `{ enabled, method, expect, timeout_ms? }` (`method` ∈ GET/HEAD/JSON-RPC/WSS-RPC)                                                                                                                                             | you (optional)                                                  |

**Contributor `kind` enum (11):** `docs · website · source-repo · openapi · subnet-api · dashboard ·
sse · sdk · example · repo-registry · data-artifact` — all auto-reviewable. Higher-trust within these
(harder review, airtight ownership proof): authed/paid APIs and unknown providers.

> **`source-repo` and `website` have a native-chain dedup gate.** The build pipeline auto-promotes
> these kinds from SubnetIdentitiesV3 on-chain data. `validate:surface` will reject any community
> `source-repo` or `website` surface whose `(kind, netuid, normalized-url)` triple matches a
> machine-promoted native-chain candidate (`classification: live` or `redirected`). Focus contributor
> effort on callable surfaces the machine cannot discover: `openapi`, `subnet-api`, `sse`,
> `data-artifact`, `sdk`.

> **Base-layer chain endpoints** (`subtensor-rpc` / `subtensor-wss` / `archive`) are NOT contributor
> surfaces — they are maintainer-curated network infrastructure served through the endpoint lane (the
> `/rpc` proxy + `/api/v1/rpc/*`). They stay valid in the schema (for `registry/subnets/root.json` +
> the endpoint pipeline) but are excluded from the contributor surface template.

Subnet-level fields you must **not** touch in an existing-manifest community PR: `curation` (`level` +
`review_state`), `status`, `categories`, `baseline_excluded_*`, `social`, `contact`. Those are
maintainer/build-owned after the manifest exists. New subnet manifests are the exception: `subnet:new`
must create the required scaffold fields before the first surface is added.

---

## 2. CI — the `Validate` workflow (`.github/workflows/validate.yml`)

**Every contributor PR runs the FULL validation — there is no reduced "ugc" fast-lane.** (It was
retired: it skipped the safety scans and kept tripping a stale-base preflight false-positive.) A
one-file surface PR runs the same gates as a code PR. Four parallel jobs (the two Node jobs both
build):

- **`changes`** — computes docs-fast-lane eligibility for `checks` (see below). Pure inline
  `git diff`, no third-party action.
- **`test`** — builds, then runs the suite in two non-overlapping passes: `test:ci` (everything
  except the two filesystem-mutating artifact writers, run in parallel, WITH coverage → the single
  Codecov upload) then `test:ci:artifacts` (those two writers, serial). Locally just use
  `npm test` / `npm run test:coverage` (full suite, serial — the config default is race-safe). Does
  **not** participate in the docs fast lane below — coverage is a repo-wide delta gate, not
  diff-scoped, and it isn't the wall-clock long pole regardless.
- **`checks`** — builds, then lint + format + the ~20 contract/schema/safety validators (below).
- **`python`** — runs the Python SDK's unittest suite via `uv run --extra test python -m unittest
discover -s tests` (the `[test]` extra pulls in httpx so the async cases run). Node-independent, so
  it adds no wall-clock to the long poles. The same step runs in `publish-python.yml`'s unprivileged
  `build` job before the artifact is built, so a red suite blocks a PyPI publish.

**The docs fast lane (`checks` only) — narrower than, and does not weaken, the "no reduced ugc
fast-lane" rule above.** That rule is about _registry/community-surface_ content never getting a
weaker gate. This is a separate, much narrower thing: when a PR's diff consists entirely of paths
matching the glob `**/*.md` or `.claude/skills/**/*.md` (pure contributor-facing prose — cannot
touch registry data, schemas, code, or CI config; a non-`.md` file anywhere, including a hypothetical
future non-`.md` file under `.claude/skills/`, disqualifies the whole PR), the `changes` job sets
`docs_only=true` and `checks` skips only its build/contract/registry/deploy-dry-run steps via a
**per-step** `if: env.DOCS_ONLY != 'true'` guard — never a job-level skip, so `checks` always reports
a real `success`/`failure` conclusion, never `skipped`. `Lint + format`, `validate:docs`,
`validate:intake`, and `scan:public-safety` still run unconditionally on every PR, docs-only or
not — they're cheap (no build, no network) and are exactly what a stray secret or broken
doc-contract reference in a "docs-only" PR would trip. **Hard guardrail, no exceptions:** any diff
touching `registry/` forces `docs_only=false` regardless of what else is in the diff — computed as an
independent override in the same `changes` job step, before the docs-pattern check even runs. This
exists because the retired "ugc" lane above was scoped to registry/community-surface PRs specifically
and caused a real stale-base preflight false-positive; registry-touching diffs get zero special
treatment here. The filter is a plain `git diff --name-only` + `grep` in the trusted workflow — **not**
`dorny/paths-filter` or any other third-party action: this repo's Actions allowlist
(`repos/JSONbored/metagraphed/actions/permissions/selected-actions`) only allows GitHub-owned +
verified-creator actions plus one explicit `peter-evans/create-pull-request` pattern, and
`dorny/paths-filter` is published by an individual GitHub user (not a GitHub-verified-creator org) —
using it as-is would hit a `startup_failure`. If a future change wants a real path-filter action, it
needs an explicit allowlist pattern added via Settings → Actions → General first (a live settings
change, not something a PR can do).

**Two further narrow, independent skips in the same `changes` job — unrelated to `docs_only`.**
`Validate workflows` (`npm run validate:workflows`) reads only `.github/workflows/*.yml`/`.yaml`, and
`Validate migration sequence` (`npm run validate:migrations`) reads only `migrations/*.sql` — each
verified by reading its script's full source, neither imports anything outside its own directory. The
`changes` job sets `run_workflows_validation`/`run_migrations_validation` to `true` only when the
diff touches that specific path, and `checks` gates each validator step on its own flag
(`env.RUN_WORKFLOWS_VALIDATION`/`env.RUN_MIGRATIONS_VALIDATION`), independent of `docs_only` and of
each other — a PR can be workflow-only or migration-only without being a docs PR. These are the only
two `checks` validators with a clean enough path boundary to skip safely; every other validator
(`validate:schemas`/`api`/`mcp`/`ai`/`openapi`/`types`/`client-sdk-sync`) transitively imports most of
`src/`+`workers/**` via `workers/api.mjs`, so no path glob short of "almost the whole repo" would
safely exclude them — see the "new artifact/route checklist" in §8 for why a route/handler change can
trip a contract gate with no lexical hint in the diff. Per-area **test** splitting (e.g. skip
MCP-specific tests when `src/mcp-server.mjs` wasn't touched) was evaluated and rejected: the suite has
no per-subject directory structure (all 154 files sit flat in `tests/`), a third of it imports
`workers/api.mjs`'s shared router directly, and `vitest.config.mjs`'s `fileParallelism: false` exists
for a filesystem-race reason (see below) unrelated to subject area — splitting by area would need a
real test-tree/module-boundary refactor, not a CI config change.

**Gates (all must pass):** `lint` · `format:check` · `validate:contract-drift` ·
`validate:schema-enums` · `validate:openapi-examples` · `validate:generated-client` ·
`validate:committed-seed` · `npm run build` · committed-derived-artifact freshness (working tree clean
under `public/` after a fresh build — only CONTRACT artifacts are gated; DATA/CONTENT-derived artifacts
are NOT: `public/datasets/` + the llms.txt catalogs are gitignored, the README catalog is refreshed
out-of-band by `readme-catalog-refresh.yml`, and `operational-surfaces.json` is committed-but-excluded —
adding a probe-enabled operational-kind surface (subnet-api/sse/data-artifact) regenerates the prober's
input list, which a one-file surface PR does not commit; it is served fresh on deploy) · `validate` ·
`validate:schemas` · `validate:api` ·
`validate:mcp` · `validate:ai` · `validate:openapi` · `validate:types` · `validate:artifact-budgets` ·
`validate:docs` · `validate:intake` · `validate:surface` · `validate:workflows` ·
`validate:migrations` (unique, gap-free D1 migration prefixes) ·
`cloudflare:verify:dry-run` · r2/kv dry-runs · `worker:deploy:dry-run` · `worker:bundle:budget`
(gzip-measures the `wrangler deploy --dry-run` Worker bundle against a budget so an over-1MiB bundle
fails at PR time, not at the Cloudflare deploy) · `scan:public-safety` · `validate:private-boundary`.

Codecov is configured in `codecov.yml`; run `npm run test:coverage` locally for the full-suite number.
CI uploads coverage once, from the `test:ci` pass — the two artifact writers run via child processes
and contribute no in-process coverage, so splitting them out is coverage-neutral.

---

## 3. The Gittensory Gate — auto-MERGE / auto-CLOSE / MANUAL (not advisory)

The review gate is **gittensory** (the old "reviewbot" was converged into gittensory 2026-06-22). It
posts `Gittensory Gate` + `Gittensory Context` checks and acts on **contributor** PRs with autonomy:

| Condition                                                                                                                                | Disposition                          |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Both AI reviewers confidently approve (**≥0.9**) verified + owner-matched + fresh + netuid-grounded content, CI green, mergeable-clean   | **auto-MERGE**                       |
| **Deterministic fail** — duplicate surface, placeholder, private/localhost URL, secret, dead `source_url`                                | **auto-CLOSE**                       |
| **Every** reviewer returns a clear reject                                                                                                | **auto-CLOSE**                       |
| Any CI check failed                                                                                                                      | **CLOSE** (cites the failing check)  |
| Legitimate but uncertain — a reviewer < 0.9, a reviewer said `manual`, reviewers split, owner-mismatch, stale repo, unfetchable evidence | **MANUAL** (held, never auto-closed) |
| CI pending / unverified fork run                                                                                                         | no action — waits                    |

**Content bar** (benchmarked strict): official/primary sources wherever possible, 100% verifiable, the
`url` owner must match the subnet's registered identity, source repo fresh, no prompt-injection in
fetched or submitted text. Make the `source_url` an _independent_ proof of ownership.

**Linked issues are optional, not a gate.** A PR with **no linked issue** is judged on its own merit —
the missing link is **never** a fail/close reason (for contributors or maintainers). When an issue
tracks the work, link it (`Closes #<n>`) and the gate verifies the PR against that issue's intent,
clause by clause. (What the gate does with a linked issue is configured in the gittensory system,
**not** in this repo.)

The gate's private scoring rubric/thresholds must **never** appear in this repo —
`validate:private-boundary` fails CI if they do. Keep gate heuristics in the gittensory system only.

---

## 4. npm scripts you'll actually use

| Need                                      | Command                                                                                                                                                                                                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find the data gaps                        | `npm run curation:brief` (`-- --limit 20`, `-- --json`)                                                                                                                                                                                                     |
| List / register providers                 | `npm run providers:list` (debut a new provider via `surface:add --provider-name`)                                                                                                                                                                           |
| Add a community surface to a subnet file  | `npm run surface:add -- --netuid … --kind … --url … --source-url … --provider … --submitted-by … --write` — debut provider: add `--provider-name "…" --provider-url …` (the `website_url`, **must be a public URL**) and it scaffolds the provider stub too |
| Scaffold a brand-new subnet file _(new)_  | `npm run subnet:new -- --netuid <n>`                                                                                                                                                                                                                        |
| Validate a surface contribution _(new)_   | `npm run validate:surface -- registry/subnets/<slug>.json`                                                                                                                                                                                                  |
| Public-safety scan                        | `npm run scan:public-safety`                                                                                                                                                                                                                                |
| Code/schema: regenerate the contract      | `npm run build`                                                                                                                                                                                                                                             |
| Code/schema: validators                   | `npm run validate` · `validate:schemas` · `validate:api` · `validate:openapi` · `validate:types` · `validate:contract-drift` · `validate:mcp` · `validate:ai` · `validate:docs` · `validate:intake` · `validate:workflows`                                  |
| Tests / coverage                          | `npm test` · `npm run test:coverage`                                                                                                                                                                                                                        |
| Full local pipeline (after a clean build) | `npm run pipeline:check`                                                                                                                                                                                                                                    |

> `surface:add`, `subnet:new`, and `validate:surface` are the single-file-model commands. They fully
> replaced the retired `candidate:new` / `validate:candidate` intake lane — and `surface:add`
> live-verifies the URLs at add-time (probes reachability, fills openapi schema fields) and
> auto-scaffolds a debut provider stub. Providers are flat objects in
> `registry/providers/*.json` (trust is the `authority` field, not a directory —
> there is no `providers/community/` subdir).

---

## 5. Anti-farming rules (why this model exists — do not work around them)

- **One subnet = one file = one PR.** Add all of a subnet's new surfaces in a single diff to its one
  file. That is one merge — correct and complete.
- **Never split** a subnet's surfaces across multiple PRs to inflate merge count. The gate dedups
  within the file and closes redundant/split PRs.
- **Never re-title** the same surface as a different `kind`, provider, or subnet to dodge dedup. The
  gate compares the actual file diff, not the PR title.
- **Never pad** — no docs/website surfaces invented to bulk a PR, no generated-artifact noise.
- **Don't duplicate machine-promoted native-chain surfaces.** `validate:surface` loads
  `registry/candidates/generated/public-sources.json` + `registry/verification/promotions.json` at
  start-up and rejects any community surface whose `(kind, netuid, normalized-url)` triple matches a
  native-chain candidate already classified `live` or `redirected`. These surfaces are auto-promoted by
  `generateBaselineOverlaySet` — a community submission adds no signal and will fail CI.
- A contribution's value is the **verified surface**, not the PR. Low-effort / bulk-generated /
  no-real-surface PRs are closed.

---

## 6. Commits & PR text

**Commit (Conventional):** `type(scope): summary` — types `feat fix test docs refactor build ci chore
revert`; lowercase specific scope (`registry api mcp schema build ci docs …`); no trailing period; not
a bare generic word; **no AI/Claude/agent mention**. Examples:

```
feat(registry): add SN43 Graphite subnet-api surface (#1623)
feat(registry): enrich SN15 ORO — openapi + data-artifact surfaces (#1280)
fix(health-serving): stamp merged RPC endpoint observed_at with sweep time (#1612)
```

**PR body:** GitHub pre-fills `.github/pull_request_template.md`. Fill it — don't replace it: a real
`## Summary`, the `url` + `source_url` proof (Path A) or the validation commands you ran (Path B), and
**`Closes #<issue>`** when an issue tracks the work (optional — a missing link never fails a PR). No
local paths, env dumps, or private notes.

---

## 7. What gets a PR closed / routed to manual

- More than the one subnet file touched (generated artifacts, scripts, workflows, a second subnet).
- A `source_url` that 404s or doesn't back the claim; an invented/unpublished surface.
- A duplicate of an existing surface or an open PR; the same surface re-titled by `kind`.
- A community `source-repo` or `website` surface whose URL the machine already promotes from
  SubnetIdentitiesV3 — `validate:surface` rejects it (CI fails → gate closes).
- Secrets/PATs/wallet paths, private/localhost URLs, real credentials in `auth`.
- Hand-set health/uptime/`verification` (probe-derived only).
- UI/frontend changes (those belong in metagraphed-ui).
- Editing the contract by hand without `npm run build` (contract-drift), or stale committed artifacts.
- Committing generated artifacts — `public/datasets/*` or any `public/metagraph/*` outside the reviewed
  contract (regenerated on build/deploy; `ci-verify-submitted-artifacts` rejects them).
- Bundling `public/metagraph/r2-manifest.json` or `public/metagraph/schemas/index.json` into the diff —
  even on a Path A surface PR. `npm run build` always rewrites both locally; they are deploy/publish-
  pipeline-owned (see §8) and the gate's registry-review lane treats their presence as "bundling other
  file changes" outside the one subnet file. Revert them before committing — see §8 for the exact
  command.

---

## 8. Code/schema gotchas (Path B)

- **Schema-first:** edit `schemas/`/`schemas/components/` → `npm run build` → commit `openapi.json` +
  types/clients. `validate:contract-drift` + `validate:schema-enums` + `validate:committed-seed` guard it.
- **Client SDK version: do NOT bump in your PR.** `packages/client/package.json` is versioned by the
  post-merge `sync-client-version` workflow, which auto-opens a `chore/sync-client-version` PR whenever
  a contract file lands on main. `validate:client-sdk-sync` now emits a notice (not a failure) when the
  version isn't bumped in a contributor PR.
- **MCP server card is worker-computed — no committed artifact.** Adding or changing tools in
  `src/mcp-server.mjs` does NOT require regenerating `public/.well-known/mcp/server-card.json` (that
  file no longer exists in git). The card is served dynamically by `mcpServerCardResponse` in
  `workers/request-handlers/discovery.mjs`.
- **New `/api/v1` route or artifact** trips hidden gates depending on whether it's committed
  (DUAL_PATTERNS), live-only D1 (R2_ONLY_PATTERNS + COMPUTED_ARTIFACTS), or `/.well-known`
  worker-computed. Mirror an existing route end-to-end; the build's derived-artifact freshness gate
  fails if a committed `public/metagraph/*` is stale.
- **Reader tests** serve R2-only artifacts that only exist after `npm run build` — build before the
  suite if a test reads served artifacts.
- **Never commit `public/metagraph/r2-manifest.json` or `public/metagraph/schemas/index.json`.**
  `npm run build` fully populates R2 staging (per ADR-0001) and rewrites both to reflect that local/CI
  build, but their committed copies on `main` reflect the last real deploy/publish — not a local build —
  for reasons unrelated to your change: `r2-manifest.json` is publish infrastructure read from its
  committed path by `scripts/kv-publish-pointer.mjs` / `scripts/cloudflare-verify.mjs` /
  `scripts/sync-summary.mjs` during the actual publish, and its `*_artifact_size_bytes` totals are
  inherently non-deterministic build-to-build; `schemas/index.json` is a network-capture cache the build
  "reconciles in place". Both are explicitly excluded from the derived-artifact freshness gate in
  `.github/workflows/validate.yml` (see the comment above that step) — CI won't catch this, but the
  Gittensory Gate's registry-review lane will reject a PR that bundles them in. After `npm run build`,
  revert them against your **base** remote — `upstream/main` if you forked per Phase A0, or
  `origin/main` if you cloned this repo directly (no `upstream` configured):
  `git checkout "$(git remote | grep -qx upstream && echo upstream || echo origin)/main" -- public/metagraph/r2-manifest.json public/metagraph/schemas/index.json`.
  `npm run build` itself prints a non-fatal warning if either changed, with the same command.
- **`format:check`:** `main` is not fully prettier-clean — never `prettier --write` whole files you
  didn't change; format only your own lines.
- **`pipeline:check`** is only trustworthy in isolation after a clean `npm run build`.
- **`validate.yml`'s `actions/setup-node` steps set `cache-dependency-path: package-lock.json`
  explicitly.** Without it, `setup-node`'s cache key hashes every `package-lock.json` in the tree
  (root + `packages/client` + `deploy/wss-lb`), so a routine SDK version bump in
  `packages/client/package-lock.json` (the `sync-client-version` workflow does this every few
  days) would invalidate the CI npm cache even though `npm ci` in `validate.yml` only ever reads
  the root lockfile (no npm `workspaces` config ties them together). If you ever add a new
  `actions/setup-node` step to a workflow in this repo, set this explicitly rather than relying on
  the default.
- The Worker router is `workers/api.mjs`; serving/overlay/health live in `src/*.mjs`; the contract in
  `schemas/` + `src/contracts.mjs`.

---

Keep this file and `SKILL.md` updated as the process evolves — they are the single source of truth for
both Claude Code and Codex.
