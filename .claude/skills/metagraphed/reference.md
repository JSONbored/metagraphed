# metagraphed contribution — deep reference

Exhaustive tables behind the `SKILL.md` playbook. Read the section you need. All commands run from the
repo root (Node 22, `npm install` first — or open `.devcontainer/devcontainer.json` for a preconfigured
environment with Playwright's Chromium already installed).

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

**The filename is the slugified name, not the netuid.** Correct: `registry/subnets/zeus.json`. Wrong:
`registry/subnets/sn-18.json`. The `sn-<netuid>` form is only correct as a fallback for the rare subnet
whose name doesn't produce a usable slug — see `scripts/subnet-new.ts`, the only correct way to
scaffold a new subnet file (`npm run subnet:new -- --netuid <n> --name "<Real Name>" --write`). Never
hand-name a new file, including during an ad-hoc enrichment pass (e.g. a taostats identity gap-fill) run
interactively rather than through a committed script — always scaffold through `subnet:new`. `npm run
validate` fails CI if any subnet filename doesn't match the slugified name (the machine-owned
`registry/subnets/generated/` directory is exempt).

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
one-file surface PR runs the same gates as a code PR. Five parallel jobs (the two Node jobs both
build):

- **`changes`** — computes docs-fast-lane eligibility for `checks` (see below), plus narrow
  path-scoped flags (`run_workflows_validation`, `run_migrations_validation`, `run_ui_validation`)
  for validators/jobs whose entire footprint is their own directory. Pure inline `git diff`, no
  third-party action.
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
- **`ui`** — lint + typecheck + test + a responsive-overflow e2e check (Playwright, baseline-diffed
  against `apps/ui/tests/e2e/overflow-baseline.json` — fails only on a NEW element escaping the
  viewport, not the pre-existing tracked backlog like #3930/#3931/#3985; regenerate the baseline via
  `npm run test:e2e:update-baseline --workspace=apps/ui` after a real fix or an accepted new layout),
  build, and bundle-size-budget for `apps/ui` (the TanStack Start/Vite frontend, folded into this
  repo as an npm workspace — #3062), plus a `packages/client/dist` drift check (rebuild fresh,
  `git diff --exit-code` against the committed runtime bundle — #3066/#3294) and, the same way, a
  `packages/ui-kit/dist` drift check plus its own `npm run typecheck --workspace=packages/ui-kit`
  step (`packages/ui-kit` is the design-system component library extracted from `apps/ui` — issue
  #4867's epic). Gated on `run_ui_validation` (`^apps/ui/` **or** `^packages/client/` **or**
  `^packages/ui-kit/` in the diff — `packages/client` and `packages/ui-kit` are both required, not
  optional: each is the only place that verifies its own committed `dist/index.js`/`index.cjs` still
  matches a fresh build, so a `packages/client`- or `packages/ui-kit`-only PR must also trip this
  job or stale/tampered committed runtime code could merge unverified) via the same per-step guard
  pattern `checks` uses for its docs fast lane — never a job-level skip. Entirely independent of the
  backend's own lint/test/build; a backend-only PR touching neither directory doesn't build or
  install `apps/ui`'s tree at all, and vice versa. Not part of the Gittensory contributor gate —
  both `apps/ui/**` and `packages/**` are `blockedPaths` entries in `.gittensory.yml`, maintainer-only.

**The docs fast lane (`checks` only) — narrower than, and does not weaken, the "no reduced ugc
fast-lane" rule above.** That rule is about _registry/community-surface_ content never getting a
weaker gate. This is a separate, much narrower thing: when a PR's diff consists entirely of paths
matching the glob `**/*.md` or `.claude/skills/**/*.md` (pure contributor-facing prose — cannot
touch registry data, schemas, code, or CI config; a non-`.md` file anywhere, including a hypothetical
future non-`.md` file under `.claude/skills/`, disqualifies the whole PR), the `changes` job sets
`docs_only=true` and `checks` skips only its build/contract/registry/deploy-dry-run steps via a
**per-step** `if: env.DOCS_ONLY != 'true'` guard — never a job-level skip, so `checks` always reports
a real `success`/`failure` conclusion, never `skipped`. `Lint + format`, `Typecheck` (`tsc --noEmit`,
added by the TypeScript migration, metagraphed#7510), `validate:docs`,
`validate:intake`, `scan:public-safety`, and `validate:private-boundary` still run
unconditionally on every PR, docs-only or not — they're cheap (no build, no network) and are
exactly what a stray secret, private-boundary leak, or broken doc-contract reference in a
"docs-only" PR would trip. **Hard guardrail, no exceptions:** any diff
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

**Gates (all must pass):** `lint` · `format:check` · `typecheck` (`tsc --noEmit`, whole-tree, not
diff-scoped — reads `tsconfig.json`'s own `include`/`exclude`) · `validate:contract-drift` ·
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

Codecov is configured in `codecov.yml`: `codecov/patch` enforces **99% patch coverage, branch-counted**
(`target: 99%, threshold: 0%`, near-zero slack) on every changed line in `src/**`/`workers/**`;
`codecov/project` is informational only (`target: auto`, `threshold: 1%`). Run
`npm run test:coverage` locally for the full-suite number. CI uploads coverage once, from the
`test:ci` pass — the two artifact writers run via child processes and contribute no in-process
coverage, so splitting them out is coverage-neutral.

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

**Linked issues are required and are a gate.** A PR with **no linked issue**, or one linked to an
issue that's already **closed**, is auto-closed on that basis alone — before content is even scored.
Link an **open** issue (`Closes #<n>`) and the gate verifies the PR against that issue's intent,
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
| Code/schema: typecheck _(new)_            | `npm run typecheck` (`tsc --noEmit`; `src/`+`workers/`+`scripts/`+`tests/` are still mostly `.mjs` — see the TypeScript migration epic, metagraphed#7510)                                                                                                   |
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
**`Closes #<issue>`** — required, and the issue must still be open (a missing or already-closed link
fails the PR on its own). No local paths, env dumps, or private notes.

---

## 7. What gets a PR closed / routed to manual

- More than the one subnet file touched (generated artifacts, scripts, workflows, a second subnet).
- A `source_url` that 404s or doesn't back the claim; an invented/unpublished surface.
- A duplicate of an existing surface or an open PR; the same surface re-titled by `kind`.
- A community `source-repo` or `website` surface whose URL the machine already promotes from
  SubnetIdentitiesV3 — `validate:surface` rejects it (CI fails → gate closes).
- Secrets/PATs/wallet paths, private/localhost URLs, real credentials in `auth`.
- Hand-set health/uptime/`verification` (probe-derived only).
- A visual `apps/ui/**` change with no before/after screenshot table in the PR body (or one pasted outside the table) — see Path C in `SKILL.md`. This is the frontend equivalent of the registry gate's deterministic-fail bar.
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
  a contract file lands on main. `validate:client-sdk-sync` emits a notice (not a failure) either way:
  when the version isn't bumped in a contributor PR (expected — automation handles it), and _also_ when
  a contributor bumps it themselves anyway (unnecessary — the workflow's own diff-since-last-bump check
  doesn't look for a manual bump, only for contract-file changes since its last `chore(client): bump
SDK` commit, so a hand-bump here is redundant at best and a conflicting version at worst once the
  auto PR lands).
- **MCP server version: do NOT bump in your PR, same as the client SDK above.** `MCP_SERVER_VERSION`
  (`src/mcp-server.mjs`) and `server.json`'s `"version"` are versioned by the post-merge
  `sync-mcp-version` workflow — same shape as `sync-client-version`, watching `src/mcp-server.mjs` since
  its last `chore(mcp): bump server version` commit and bumping both files together when a tool was
  added/changed. `validate:mcp` only checks _internal_ consistency (`MCP_SERVER_VERSION` ==
  `serverInfo.version` == `server.json`'s version) — it stays green regardless of what number those
  hold, so a PR that adds an MCP tool without touching either file passes CI fine; the workflow is what
  actually advances the number, entirely after the fact. A contributor hand-bumping either file is pure
  unrewarded toil (and setup for a merge conflict with the auto-opened `chore/sync-mcp-version` PR) —
  flag it in review the same way as a manual client-SDK bump.
- **`packages/client` is an npm workspace (#3066), with no lockfile of its own.** `apps/ui` consumes it
  as a live workspace link (`"@jsonbored/metagraphed": "*"` in `apps/ui/package.json`, resolved from
  `packages/client` directly) instead of round-tripping through the published npm package. Verified
  this does NOT silently fall back to a registry-fetched copy even when installing from directly
  inside `apps/ui` (`cd apps/ui && npm install`, no `--workspace` flag) — npm still walks up to the
  root `package.json`'s `workspaces` field and links `node_modules/@jsonbored/metagraphed` as a real
  symlink to `packages/client`, matching a root-scoped `npm ci --workspace=apps/ui` install exactly
  (confirmed by identical package counts and a real symlink check). Editing
  `packages/client/src/*` and rebuilding (`npm run build --workspace=packages/client`) is immediately
  visible to `apps/ui`, no publish needed. `packages/client`'s own `typescript` devDependency must stay
  aligned with the root/`apps/ui` range (`^5.9.3`): `tsup` (its build tool) is hoisted to the _root_
  `node_modules` and resolves `typescript` from there regardless of which workspace invokes it, so a
  workspace-local TypeScript version pin silently gets ignored by `tsup --dts` — don't reintroduce one.
  `packages/client`'s `dist/index.js` + `dist/index.cjs` (the RUNTIME bundle ONLY) are committed —
  an explicit, narrow exception to the root `.gitignore`'s blanket `dist` rule, carved out in
  `packages/client/.gitignore`. This is deliberate, not an oversight: Cloudflare Workers Builds'
  actual production deploy hit three consecutive, unreproducible-locally failures trying to build
  `packages/client` at deploy time (a `vite`-hoisting split, then `--workspace=` failing from a
  non-root cwd, then `tsup` itself not resolving via PATH in whatever cached state Cloudflare had
  restored) — each fixed in turn, but the pattern kept recurring because this repo's own environment
  could never reproduce Cloudflare's exact caching/hoisting behavior to verify a fix with full
  confidence. Committing the runtime bundle removes the entire failure class: the live deploy never
  builds `packages/client`, it just uses what's checked into git via the workspace symlink.
  **`dist/index.d.ts`/`dist/index.d.cts` (the type declarations) stay gitignored, built fresh by
  CI/local dev only** — confirmed directly that `vite build` doesn't need them at all (esbuild strips
  types without resolving them; a real build with the `.d.ts` files absent succeeds unchanged), and
  they're the ~1.1 MB majority of this package's output, growing with every new API route added
  anywhere in the backend — committing them would reintroduce the exact diff-churn-on-every-
  contract-change problem committing the runtime bundle was meant to avoid (this repo gets hundreds
  of contributor PRs; anything that churns on unrelated changes is a real ongoing cost, not a one-off
  annoyance). **After editing `packages/client/src/*`, you must run
  `npm run build --workspace=packages/client` and commit the resulting `dist/index.js`/`index.cjs`
  in the same PR** — the `ui` CI job's "Build packages/client (drift check)" step rebuilds fresh and
  fails loudly (`git diff --exit-code`) if the committed copy doesn't match; `git diff` only
  considers tracked files, so the gitignored `.d.ts` is naturally excluded from that check with no
  extra scoping needed. Neither `apps/ui`'s own scripts nor Cloudflare's Build command need to build
  `packages/client` at all anymore — do NOT reintroduce that (a
  `(cd ../../packages/client && npm run build)` step, a `prepare` lifecycle script, etc.); it only
  reintroduces the exact fragility this commits-the-artifact approach was built to eliminate.
  Deliberately NOT a package.json "prepare" script even for the drift-check purpose: that would
  auto-run on every `npm install`/`ci` repo-wide, which a security scan already flagged once as
  unnecessary install-time code execution (#3066 review).
- **`packages/ui-kit` is an internal design-system component library extracted from `apps/ui`
  (issue #4867's epic), following the identical committed-dist pattern as `packages/client` above:**
  `dist/index.js`, `dist/index.cjs`, and `dist/index.css` are committed — the same `.gitignore`
  exception, same reasoning (`apps/ui` consumes it as a live workspace link, and Cloudflare Workers
  Builds must never depend on rebuilding a sibling workspace package) — while
  `dist/index.d.ts`/`dist/index.d.cts` stay gitignored, built fresh by CI/local dev only. **After
  editing `packages/ui-kit/src/*`, you must run `npm run build --workspace=packages/ui-kit` and
  commit the resulting `dist/index.js`/`index.cjs`/`index.css` in the same PR** — the `ui` CI job's
  "Build packages/ui-kit (drift check)" step rebuilds fresh and fails loudly (`git diff --exit-code`)
  if the committed copy doesn't match, same as the `packages/client` drift check above. The job also
  runs dedicated `npm run typecheck --workspace=packages/ui-kit` ("Typecheck packages/ui-kit") and
  `npm test --workspace=packages/ui-kit` ("Test packages/ui-kit") steps. **A separate "Lint
  packages/ui-kit (app-logic import guardrail)" step (#4865) enforces that the package stays a real,
  standalone library** — `packages/ui-kit/eslint.config.js`'s `no-restricted-imports` rule fails on
  any import of `@tanstack/react-router`, `@tanstack/react-query`, or anything resolving into
  `apps/ui/**`. If a component genuinely needs routing/data, accept it as a prop from the caller
  instead of reaching for app infrastructure — that's the exact regression this package's extraction
  exists to prevent.
- **`packages/contract` is a types-only npm workspace (#3067) holding the OpenAPI-derived contract
  types** — `openapi-typescript`'s output (`scripts/generate-types.ts`/`validate-types.ts`/
  `validate-contract-drift.ts` all write/check `packages/contract/index.d.ts` now, no longer
  `generated/metagraphed-api.d.ts`, which no longer exists). `packages/client` depends on it as a
  real `devDependency` (`"metagraphed-contract": "*"`) and imports `type { components, paths } from
"metagraphed-contract"` directly — no more copying it into `packages/client/src` first (unlike
  `generated/metagraphed-client.ts`, the hand-templated SDK helper logic, which is unrelated contract
  content and still gets copied there exactly as before). **`packages/client`'s build command MUST
  keep the `--dts-resolve` flag** (`tsup ... --dts --dts-resolve ...`): without it, `tsup` leaves a
  bare `import { components, paths } from 'metagraphed-contract'` in the PUBLISHED package's own
  `dist/index.d.ts`/`index.d.cts` instead of inlining the 1.1 MB of actual type content — since
  `metagraphed-contract` is `"private": true` and never published to npm, every external SDK consumer's
  TypeScript compiler would fail outright trying to resolve that import. Verified directly: without
  `--dts-resolve`, the published output shrinks from ~1.13 MB to ~8.7 KB (the tell that nothing got
  inlined) and literally contains that import line; with it, the output is back to ~1.13 MB with zero
  occurrences of `metagraphed-contract` anywhere in it. `packages/contract` needs no build step of its
  own (no runtime code, nothing to bundle) and is a required trigger for the `ui` CI job's drift check
  same as `packages/client/**` (see the `changes` job comment above) — a schema-only PR can regenerate
  `packages/contract/index.d.ts` (caught by `checks`' `validate:contract-drift`) without anyone
  rebuilding+committing `packages/client/dist` to match, and only that job's drift check would catch it.
- **`vite` must stay an explicit ROOT-level devDependency**, even though the backend never imports it.
  Cloudflare Workers Builds' automatic dependency-install step runs scoped to `--workspace=apps/ui`
  only (never a full monorepo install — confirmed by matching package counts against a real Cloudflare
  build log, ~470 vs. a full install's ~560), which never touches root's own devDependencies. Without
  `vite` declared at root, nothing gives npm a reason to hoist `apps/ui`'s own `vite` up to the bare
  root `node_modules` during that scoped install, so anything ALSO hoisted to root with only a _peer_
  (not direct) range on vite — e.g. `@lovable.dev/vite-tanstack-config`, which `vite.config.ts` needs —
  can't find it (`Error: Cannot find module 'vite'`, real Workers Builds failure, #3183). A worktree
  nested under the main checkout can mask this locally: Node's resolution silently falls back to a
  stray `node_modules/vite` in an ancestor directory outside the repo, so a real reproduction needs a
  genuinely isolated clone (no parent `node_modules` anywhere in its ancestry) plus the exact
  `npm ci --workspace=apps/ui` command Cloudflare runs — a plain full `npm ci`/`install` won't surface
  this class of bug at all.
- **MCP server card is worker-computed — no committed artifact.** Adding or changing tools in
  `src/mcp-server.mjs` does NOT require regenerating `public/.well-known/mcp/server-card.json` (that
  file no longer exists in git). The card is served dynamically by `mcpServerCardResponse` in
  `workers/request-handlers/discovery.mjs`.
- **New `/api/v1` route or artifact** trips hidden gates depending on whether it's committed
  (DUAL_PATTERNS), live-only D1 (R2_ONLY_PATTERNS + COMPUTED_ARTIFACTS), or `/.well-known`
  worker-computed. Mirror an existing route end-to-end; the build's derived-artifact freshness gate
  fails if a committed `public/metagraph/*` is stale. It also trips gates the "new route" framing
  above doesn't cover, caught live 2026-07-18 shipping two routes with none of these:
  `scripts/validate-api.ts`'s own `checks` array needs a matching `[route, assertion]` entry (it
  asserts `checks.length === API_ROUTES.length`, a **live RPC call** against real finney, not a
  stub); codecov/patch (99%, branch-counted) needs GraphQL/MCP test coverage in the _centralized_
  `tests/graphql.test.mjs`/`tests/mcp-server.test.mjs` files specifically, not just a per-feature
  test file — a per-feature file alone leaves the GraphQL resolver and MCP tool handler at 0% patch
  coverage even with 100% coverage on the underlying `src/*.mjs` module; and the `ui` CI job's
  "Build API reference docs (drift check)" step (added 2026-07-18, mirrors the
  `packages/client`/`packages/ui-kit` drift checks just above it) fails if `apps/ui/content/docs/
api-reference/**` wasn't regenerated — run `node scripts/generate-openapi-docs.mjs` from
  `apps/ui/` and commit the result alongside the contract change. Two more, caught live 2026-07-18
  shipping a templated computed artifact: `src/contracts.mjs` has **two separate registries** for a
  route with no static file — a `route(...)` entry (API surface metadata) AND a distinct
  `artifact(id, path, description, schemaName)` entry (the schema-ref mapping); omitting the
  `artifact()` call makes `npm run build` throw `No public artifact contract maps API artifact
<path>` from `schemaRefForArtifactPath`, since `route()`'s own `artifactPath` argument is just a
  label, not a registration. And the local pre-push guard's `validate:docs` check requires a
  matching prose entry in `docs/backend-artifact-contracts.md` (mirror an existing bullet like the
  `subnet-burn` one) for every artifact path — easy to miss since nothing else in the schema/route
  wiring references this file.
- **Reader tests** serve R2-only artifacts that only exist after `npm run build` — build before the
  suite if a test reads served artifacts.
- **Never commit `public/metagraph/r2-manifest.json` or `public/metagraph/schemas/index.json`.**
  `npm run build` fully populates R2 staging (per ADR-0001) and rewrites both to reflect that local/CI
  build, but their committed copies on `main` reflect the last real deploy/publish — not a local build —
  for reasons unrelated to your change: `r2-manifest.json` is publish infrastructure read from its
  committed path by `scripts/kv-publish-pointer.ts` / `scripts/cloudflare-verify.mjs` /
  `scripts/sync-summary.ts` during the actual publish, and its `*_artifact_size_bytes` totals are
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
  (root + `deploy/wss-lb`), so a change to the latter would invalidate the CI npm cache even though
  `npm ci` in `validate.yml` only ever reads the root lockfile. `packages/client` is an npm workspace
  with no lockfile of its own — its version bumps land in the root lockfile, already covered by this
  path. If you ever add a new `actions/setup-node` step to a workflow in this repo, set this
  explicitly rather than relying on the default.
- The Worker router is `workers/api.mjs`; serving/overlay/health live in `src/*.mjs`; the contract in
  `schemas/` + `src/contracts.mjs`.

---

Keep this file and `SKILL.md` updated as the process evolves — they are the single source of truth for
both Claude Code and Codex.
