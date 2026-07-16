# Contributor pipeline gardening — reference (metagraphed)

## Docs architecture migration — spike landed on loopover 2026-07-15, metagraphed port issue filed 2026-07-16

metagraphed's website docs (currently hand-built TanStack Router route files, one full React
component per page — see the shipped `Docs page: X` precedents like #3512/#3513/#3515) are migrating
to a shared MDX pipeline: **`fumadocs-core`/`fumadocs-mdx` (headless, not `fumadocs-ui`'s component
shell) for content/structure/search, rendered through existing ui-kit primitives, plus Scalar
(`@scalar/api-reference`) for the API playground.**

**Status as of 2026-07-16:** the loopover spike (JSONbored/loopover#6037) landed 2026-07-15 and
JSONbored/loopover#6271 (merged same day) already migrated every existing loopover-ui docs page onto
the new pattern — proven, not just spiked. Loopover's own AMS-docs epic (#6012 + sub-issues
#6022-#6032) was fully closed as a result. The metagraphed-side port is now tracked as **#6225**
(`maintainer-only`, filed 2026-07-16) and #3504/3505/3506/3507/3508/3509/3510/3511/3514/3516 are all
linked `addBlockedBy` #6225.

**Until #6225 lands:**

- Don't file new issues asking a contributor to hand-build a `docs.*.tsx` route. If a genuine docs
  gap is found during Pass 2, note it in the digest instead of filing it under the old pattern.
- Don't "fix" the `maintainer-only` labeling on the "Docs page: X" family in a future stale-sweep
  pass — check #6225's state first. Once it lands, those issues need their Requirements rewritten to
  target a `content/docs/*.mdx` file instead of a hand-built route, then `maintainer-only` removed —
  see JSONbored/loopover#6012's family for the precedent of that exact follow-up rewrite.

## Product shape

metagraphed is a Bittensor subnet registry + block-explorer product: `registry/subnets/<slug>.json`
(one file per subnet, community-contributed surfaces), a Worker API (`workers/`, OpenAPI-schema-driven,
`schemas/` is the contract), and `apps/ui` (the explorer frontend). See `.claude/skills/metagraphed/`
for the full contribution model — that skill is authoritative for how a PR gets merged here; this
skill only covers issue-pipeline hygiene, not PR review mechanics.

## Milestone taxonomy (re-check every run — this repo's hygiene and counts drift faster than gittensory's)

| Milestone                                     | Open (as of 2026-07-15)                                                                  | Nature                                                                                                                                                                                                                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Foundations & Infra` (#11)                   | ~27+ (growing — see below)                                                               | General backend/infra work, mixed maintainer/contributor. Also the default home for well-precedented REST/GraphQL/MCP parity issues (no dedicated milestone exists for that pattern yet).                                                                                                 |
| `Wave 4 — Docs & Dev Surface` (#10)           | ~21                                                                                      | Docs pages for shipped API surfaces — mostly currently `maintainer-only` but low-risk to unlock, see SKILL.md. Paused pending the fumadocs-mdx port issue #6225 (filed 2026-07-16, loopover's own spike #6037 already landed) — don't unlock the "Docs page: X" family until #6225 lands. |
| `Partner Flywheel Hardening` (#13)            | ~4                                                                                       | Small, check individually                                                                                                                                                                                                                                                                 |
| `Wave 3 — Frontend (post-consolidation)` (#9) | 11 (checked 2026-07-15 — NOT drained, an earlier "0/480" snapshot of this doc was stale) | Verify its real open count fresh each run rather than trusting a cached number here                                                                                                                                                                                                       |
| Unmilestoned                                  | ~23 (checked 2026-07-15)                                                                 | Mostly legitimate: the Enrich-SNxx rolling-intake family + the bot-managed Dependency Dashboard, both correctly standalone. Verify what's actually unmilestoned fresh each run before assuming it's a hygiene gap — an earlier "~74, real gap" snapshot of this doc was stale.            |

**Every gardening-generated issue gets a milestone — none ship unmilestoned** (reinforced by the
maintainer, 2026-07-15). Default to the closest-fitting existing one from the table above. A new
milestone is warranted only when nothing existing fits AND the work is either a genuinely major
initiative or a recurring category that will keep needing a home — see gittensory/loopover's own
`reference.md` for the `Miner Wave 4.5` precedent of the latter case. A one-off oddity alone isn't
enough justification; when genuinely unsure on a high-stakes call like this, propose 1-2 options, but
default to deciding and documenting the reasoning rather than blocking a run on confirmation.

## Labels — this repo's own convention, don't force gittensory's onto it

- `gittensor:bug` (0.05x), `gittensor:feature` (0.25x), `gittensor:priority` (1.5x) — same point
  values as gittensory, **but `gittensor:priority` is used far more liberally here** (roughly a third
  of all open issues, often standalone with no `gittensor:feature`/`gittensor:bug` pairing). Follow
  this repo's existing density, don't artificially scarce it down to match gittensory.
- `help wanted` — paired with points labels, same as gittensory.
- `backend` / `frontend` — apply when the work is clearly one or the other; skip when it's genuinely
  both or neither (e.g. a pure docs/data issue).
- `maintainer-only` — used on ~57% of open issues (81/142). Only ~14 of those also carry `roadmap`,
  so **don't assume the `roadmap`+`maintainer-only` pairing convention from gittensory applies here**
  — in this repo `maintainer-only` alone is a complete, sufficient signal.
- `good first issue` is **not** a real convention here — the label doesn't exist in this repo
  (confirmed 2026-07-14) and the maintainer doesn't want it added. Only `gittensor:*` + `help wanted`
  (+ `backend`/`frontend` where clearly applicable) matter for contributor-available issues.
- Never add anything beyond the above to a gardening-generated issue.

## What's safe to unleash

Same underlying test as gittensory's copy of this skill (clear precedent to follow, no business/product
decision required, doesn't touch security-sensitive surfaces without a maintainer design pass first,
doesn't require access a contributor can't have). metagraphed-specific instances of the boundary:

- **Docs pages for already-shipped API endpoints** (the Wave 4 "Docs page: X" family) — writing
  accurate docs for an existing, stable endpoint is mechanical and low-risk. Good unlock candidates.
- **Native-staking feature work** (real stake movement, commission/take management, re-delegation,
  the pre-launch security review, phishing-resistance/subdomain work) — stays `maintainer-only`.
  This is live financial functionality; don't unlock any of it without an explicit ask.
- **Registry/surface data contributions** are a distinct category from code issues — they're the
  community's main contribution path (one file per subnet) and don't need the same
  maintainer-vs-contributor gating a code change does, since the gate's own AI-reviewer +
  ownership-proof verification is the real safety net there, not issue labeling.

## Issue body template

```md
## Context

<what exists today, cite real file/schema/route paths, why this matters>

## Requirements

<concrete, testable requirements>

## Deliverables

- [ ] <concrete artifact 1>
- [ ] <concrete artifact 2>

## Expected Outcome

<what's true after this ships that wasn't true before>

## Links & Resources

<related issues, files to anchor on>
```

For a registry/surface-data issue (asking a contributor to add a subnet's surfaces), follow the
surface-contribution shape in `.claude/skills/metagraphed/reference.md` instead — do not use the
code-issue template above for that kind of ask.

## Native relationship linking (GraphQL — confirmed available on this repo, 2026-07-14)

**Check every new batch of issues for a real dependency before moving on — required, not optional**
(reinforced by the maintainer, 2026-07-15). Most batches of independent bug-fixes or parity additions
(e.g. a set of REST/GraphQL-mirror issues, each adding one unrelated field) genuinely have no
dependency on each other — the correct outcome of the check is then "no links needed." Reserve
`addBlockedBy` for a real case where working an issue out of order would waste a contributor's time,
and `addSubIssue` for anything genuinely part of a parent epic/tracker.

```graphql
mutation {
  addSubIssue(
    input: { issueId: "<parent node id>", subIssueId: "<child node id>" }
  ) {
    issue {
      number
    }
  }
}
mutation {
  addBlockedBy(
    input: {
      issueId: "<blocked node id>"
      blockingIssueId: "<blocker node id>"
    }
  ) {
    issue {
      number
    }
  }
}
```

**Field name gotcha:** the mutation's second input field is `blockingIssueId`, not `blockedById` —
`blockedById` fails with `argumentNotAccepted`. Confirmed live 2026-07-16 linking #3504-3511/3514/3516
as blocked by #6225.

Get a node ID: `gh api graphql -f query='query { repository(owner:"JSONbored", name:"metagraphed") { issue(number: N) { id } } }'`.

## gh CLI gotchas

- `gh api graphql -f query=@file.txt` does **not** read the file — `-f` treats `@file` as a literal
  string and the request fails with a GraphQL parse error on the `@`. Use **`-F query=@file.txt`**
  (capital F) whenever the query is large enough to be worth writing to a file first.
- `gh issue close` has no `--comment-file` flag — write the comment to a file, then pass
  `-c "$(cat file.md)"` (double-quoted around the whole substitution) so any backticks in the comment
  text are treated as literal characters, not re-parsed by bash as command substitution.
- Never embed a body/comment string containing backticks directly inside a `python3 -c "..."`
  double-quoted bash argument for the same reason — write it to a file first.
