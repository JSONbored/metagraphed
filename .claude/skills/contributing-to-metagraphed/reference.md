# metagraphed contribution — deep reference

Exhaustive tables behind the `SKILL.md` playbook. Read the section you need. All commands run from the
repo root (Node 22, `npm install` first).

---

## 0. The single-file surface model (what changed, and why)

**Surfaces live in ONE file per subnet:** `registry/subnets/<slug>.json` → its `surfaces[]` array. A
community contribution **appends a surface to that one file** with `authority: "community"` and
`review.state: "community-submitted"`. The Gittensory Gate flips the review state in place on merge;
the build's prober fills `verification`/health.

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

| Field                           | Type / values                                                                                                                                                                                                                 | Who sets it                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `id`                            | `^[a-z0-9][a-z0-9-]*$`, unique in the file (convention `sn-<netuid>-<provider>-<kind>`)                                                                                                                                       | you (helper)                                                 |
| `name`                          | human label                                                                                                                                                                                                                   | you                                                          |
| `kind`                          | see enum below                                                                                                                                                                                                                | you                                                          |
| `url`                           | public URI you can fetch                                                                                                                                                                                                      | you                                                          |
| `provider`                      | registered provider slug `^[a-z0-9][a-z0-9-]*$`                                                                                                                                                                               | you (`providers:list` / `provider:new`)                      |
| `authority`                     | `official` · `provider-claimed` · **`community`** · `registry-observed`                                                                                                                                                       | you → **`community`**                                        |
| `auth_required` / `public_safe` | boolean                                                                                                                                                                                                                       | you (`false` / `true` for auto-review kinds)                 |
| `source_urls`                   | array of URIs that **prove** the claim                                                                                                                                                                                        | you (≥1, required in practice)                               |
| `review`                        | `{ state, submitted_by?, submitted_at?, confidence?, review_notes? }` — `state` ∈ `community-submitted · maintainer-reviewed · rejected` (HUMAN-governance axis only; machine verify/freshness is the separate probe overlay) | you set `community-submitted`; a maintainer promotes/rejects |
| `verification`                  | `{ classification, verified_at, status_code, latency_ms, confidence_score, … }`                                                                                                                                               | **build prober only — never by hand**                        |
| `schema_url` / `schema_status`  | OpenAPI URL · `machine-readable`/`ui-only`/`not-captured`                                                                                                                                                                     | you (optional)                                               |
| `rate_limit`                    | `{ requests, window, burst?, scope?, cost_notes? }` (`requests`+`window` required)                                                                                                                                            | you (optional, integration-only)                             |
| `auth`                          | `{ scheme, location?, name?, value_format?, … }` — **placeholders only, never a secret**                                                                                                                                      | you (optional)                                               |
| `probe`                         | `{ enabled, method, expect, timeout_ms? }` (`method` ∈ GET/HEAD/JSON-RPC/WSS-RPC)                                                                                                                                             | you (optional)                                               |

**Contributor `kind` enum (11):** `docs · website · source-repo · openapi · subnet-api · dashboard ·
sse · sdk · example · repo-registry · data-artifact` — all auto-reviewable. Higher-trust within these
(harder review, airtight ownership proof): authed/paid APIs and unknown providers.

> **Base-layer chain endpoints** (`subtensor-rpc` / `subtensor-wss` / `archive`) are NOT contributor
> surfaces — they are maintainer-curated network infrastructure served through the endpoint lane (the
> `/rpc` proxy + `/api/v1/rpc/*`). They stay valid in the schema (for `registry/subnets/root.json` +
> the endpoint pipeline) but are excluded from the contributor surface template.

Subnet-level fields you must **not** touch in a community PR: `curation` (`level` + `review_state`),
`status`, `categories`, `baseline_excluded_*`, `social`, `contact`. Those are maintainer/build-owned.

---

## 2. CI — the `Validate` workflow (`.github/workflows/validate.yml`)

**Every contributor PR runs the FULL validation — there is no reduced "ugc" fast-lane.** (It was
retired: it skipped the safety scans and kept tripping a stale-base preflight false-positive.) A
one-file surface PR runs the same gates as a code PR. Two parallel jobs both build:

- **`test`** — builds, then `npm run test:coverage` (Codecov is the coverage gate).
- **`checks`** — builds, then lint + format + the ~20 contract/schema/safety validators (below).

**Gates (all must pass):** `lint` · `format:check` · `validate:contract-drift` ·
`validate:schema-enums` · `validate:openapi-examples` · `validate:generated-client` ·
`validate:committed-seed` · `npm run build` · committed-derived-artifact freshness (working tree clean
under `public/` after a fresh build — only CONTRACT artifacts are gated; DATA artifacts like
`public/datasets/` + the llms.txt catalogs are gitignored, and the README catalog is refreshed
out-of-band by `readme-catalog-refresh.yml`) · `validate` · `validate:schemas` · `validate:api` ·
`validate:mcp` · `validate:ai` · `validate:openapi` · `validate:types` · `validate:artifact-budgets` ·
`validate:docs` · `validate:intake` · `validate:surface` · `validate:workflows` ·
`cloudflare:verify:dry-run` · r2/kv dry-runs · `worker:deploy:dry-run` · `scan:public-safety` ·
`validate:private-boundary`.

Codecov is configured in `codecov.yml`; run `npm run test:coverage` unsharded locally (CI shards +
merges, so a single shard under-reports).

---

## 3. The Gittensory Gate — auto-MERGE / auto-CLOSE / MANUAL (not advisory)

The review gate is **gittensory** (the old "reviewbot" was converged into gittensory 2026-06-22). It
posts `Gittensory Gate` + `Gittensory Context` checks and acts on **contributor** PRs with autonomy:

| Condition                                                                                                                                                  | Disposition                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Both AI reviewers confidently approve (**≥0.9**) verified + owner-matched + fresh + netuid-grounded content, CI green, mergeable-clean, valid linked issue | **auto-MERGE**                       |
| **Deterministic fail** — duplicate surface, placeholder, private/localhost URL, secret, dead `source_url`                                                  | **auto-CLOSE**                       |
| **Every** reviewer returns a clear reject                                                                                                                  | **auto-CLOSE**                       |
| **No linked issue** (repo hard-rule)                                                                                                                       | **fail / close** — add `Closes #<n>` |
| Any CI check failed                                                                                                                                        | **CLOSE** (cites the failing check)  |
| Legitimate but uncertain — a reviewer < 0.9, a reviewer said `manual`, reviewers split, owner-mismatch, stale repo, unfetchable evidence                   | **MANUAL** (held, never auto-closed) |
| CI pending / unverified fork run                                                                                                                           | no action — waits                    |

**Content bar** (benchmarked strict): official/primary sources wherever possible, 100% verifiable, the
`url` owner must match the subnet's registered identity, source repo fresh, no prompt-injection in
fetched or submitted text. Make the `source_url` an _independent_ proof of ownership.

**Hard rule for everyone, including maintainers:** a PR with **no linked issue** fails the gate. This
also blocks release-please bot PRs unless exempted in the gittensory config (that config lives in the
gittensory system, **not** in this repo). Don't `--admin`-bypass — the policy is deliberate.

The gate's private scoring rubric/thresholds must **never** appear in this repo —
`validate:private-boundary` fails CI if they do. Keep gate heuristics in the gittensory system only.

---

## 4. npm scripts you'll actually use

| Need                                      | Command                                                                                                                                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find the data gaps                        | `npm run curation:brief` (`-- --limit 20`, `-- --json`)                                                                                                                                                                    |
| List / register providers                 | `npm run providers:list` · `npm run provider:new`                                                                                                                                                                          |
| Add a community surface to a subnet file  | `npm run surface:add -- --netuid … --kind … --url … --source-url … --provider … --submitted-by … --write` — debut provider: add `--provider-name "…" --provider-url …` and it scaffolds the provider stub too              |
| Scaffold a brand-new subnet file _(new)_  | `npm run subnet:new -- --netuid <n>`                                                                                                                                                                                       |
| Validate a surface contribution _(new)_   | `npm run validate:surface -- registry/subnets/<slug>.json`                                                                                                                                                                 |
| Public-safety scan                        | `npm run scan:public-safety`                                                                                                                                                                                               |
| Code/schema: regenerate the contract      | `npm run build`                                                                                                                                                                                                            |
| Code/schema: validators                   | `npm run validate` · `validate:schemas` · `validate:api` · `validate:openapi` · `validate:types` · `validate:contract-drift` · `validate:mcp` · `validate:ai` · `validate:docs` · `validate:intake` · `validate:workflows` |
| Tests / coverage                          | `npm test` · `npm run test:coverage`                                                                                                                                                                                       |
| Full local pipeline (after a clean build) | `npm run pipeline:check`                                                                                                                                                                                                   |

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
**`Closes #<issue>`** (the gate hard-fails without a linked issue). No local paths, env dumps, or
private notes.

---

## 7. What gets a PR closed / routed to manual

- More than the one subnet file touched (generated artifacts, scripts, workflows, a second subnet).
- A `source_url` that 404s or doesn't back the claim; an invented/unpublished surface.
- A duplicate of an existing surface or an open PR; the same surface re-titled by `kind`.
- Secrets/PATs/wallet paths, private/localhost URLs, real credentials in `auth`.
- Hand-set health/uptime/`verification` (probe-derived only).
- No linked issue. UI/frontend changes (those belong in metagraphed-ui).
- Editing the contract by hand without `npm run build` (contract-drift), or stale committed artifacts.

---

## 8. Code/schema gotchas (Path B)

- **Schema-first:** edit `schemas/`/`schemas/components/` → `npm run build` → commit `openapi.json` +
  types/clients. `validate:contract-drift` + `validate:schema-enums` + `validate:committed-seed` guard it.
- **New `/api/v1` route or artifact** trips hidden gates depending on whether it's committed
  (DUAL_PATTERNS), live-only D1 (R2_ONLY_PATTERNS + COMPUTED_ARTIFACTS), or `/.well-known`
  worker-computed. Mirror an existing route end-to-end; the build's derived-artifact freshness gate
  fails if a committed `public/metagraph/*` is stale.
- **Reader tests** serve R2-only artifacts that only exist after `npm run build` — build before the
  suite if a test reads served artifacts.
- **`format:check`:** `main` is not fully prettier-clean — never `prettier --write` whole files you
  didn't change; format only your own lines.
- **`pipeline:check`** is only trustworthy in isolation after a clean `npm run build`.
- The Worker router is `workers/api.mjs`; serving/overlay/health live in `src/*.mjs`; the contract in
  `schemas/` + `src/contracts.mjs`.

---

Keep this file and `SKILL.md` updated as the process evolves — they are the single source of truth for
both Claude Code and Codex.
