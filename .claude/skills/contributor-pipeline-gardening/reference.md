# Contributor pipeline gardening — reference (metagraphed)

## Scope boundary — registry enrichment is a separate automation (see SKILL.md)

Don't file, triage, or fix anything under `registry/subnets/*.json` from this pipeline — not just the
Enrich-SNxx new-subnet-intake family, but registry data work of any kind (accuracy passes,
probe-config gaps, curation fields, etc). See SKILL.md's "Scope boundary" section for the 2026-07-19
incident that established this.

This is about not _authoring_ registry content, not about ignoring issue-state hygiene for an issue
whose deliverable happens to touch `registry/`. The MCP execute "verify + wire SN\*" family is the
one exception where Pass 1's normal stale-sweep verification still applies — see SKILL.md's dedicated
subsection under Pass 1 and the milestone-table row below.

## Docs architecture migration — RESOLVED 2026-07-16, fully shipped

metagraphed's website docs migrated off hand-built TanStack Router route files (one full React
component per page — the old `docs.*.tsx` pattern) onto a shared MDX pipeline. **#6225** (the port
issue, filed 2026-07-16 after loopover's own spike/rollout — JSONbored/loopover#6037 + #6271) closed
the same day as **superseded**: the pipeline shipped via a native `fumadocs-mdx` + `fumadocs-ui` +
`fumadocs-openapi` integration (not the originally-proposed Scalar `@scalar/api-reference`) — content
now lives in `content/docs/*.mdx` behind a single `docs.$.tsx` catch-all route, and the API-reference
half is generated straight from `openapi.json` via `fumadocs-openapi` (#6210) rather than an embedded
Scalar component.

**All 10 previously-paused "Docs page: X" issues (#3504-#3511, #3514, #3516) plus the earlier
#3512/#3513/#3515 are written and closed (#6232).** This family is fully drained — don't look here
for Pass 2 top-up material, and don't re-open or re-triage any of these issues; they're done.

## Product shape

metagraphed is a Bittensor subnet registry + block-explorer product: `registry/subnets/<slug>.json`
(one file per subnet, community-contributed surfaces), a Worker API (`workers/`, OpenAPI-schema-driven,
`schemas/` is the contract), and `apps/ui` (the explorer frontend). See `.claude/skills/metagraphed/`
for the full contribution model — that skill is authoritative for how a PR gets merged here; this
skill only covers issue-pipeline hygiene, not PR review mechanics.

## Milestone taxonomy (re-check every run — this repo's hygiene and counts drift faster than gittensory's)

**2026-07-31 correction — still zero contributor-available, and both 2026-07-25 "productive veins" are now
fully drained.** Total open issues: 42 at run start, 38 after Pass 1's stale-sweep closed 4 (three
epics whose full native-sub-issue set had shipped without closing the tracker itself — #8606 API access
GA, #8701 upgrade radar, #8350 PWA/T9 — plus one superseded design-spike, #6646, whose own ask was
fully answered by ADR 0022 + epic #8606's implementation). All 38 remaining open issues are
`maintainer-only` and assigned to the maintainer; contributor-available count was 0 before this run and
stayed 0 after — the second consecutive run to observe the floor at literally zero (first was
2026-07-25). Confirmed exhausted this run, so don't re-derive from scratch next time unless a run finds
otherwise:

- **Design-token lint-ratchet**: `src/hooks/**`, `src/lib/**`, `src/components/**` are now ratcheted in
  both `apps/ui` and `packages/ui-kit` (the 2026-07-25 batches #8167-8172 did it). The one remaining
  un-ratcheted directory, `apps/ui/src/routes/**`, was grep-swept this run (approximating the actual
  `no-restricted-syntax` selectors — palette colors, `font-bold`, anchored raw hex, `rounded-sm/lg/3xl`,
  raw `z-*`, `shadow-[`, `bg-card/NN`) and came back near-zero real hits (most naive hex matches were the
  same `#nnnn`-issue-reference false positive the eslint config itself warns about). Not a productive
  vein anymore — don't re-check without a `git diff` signal that new drift landed in `routes/**`.
- **Generated-types epic follow-on**: batches D1-D9 (#8158-8166) all closed 2026-07-25/26. Tri-surface
  parity (REST/GraphQL/MCP) for newly-shipped fields is now codegen-enforced by `npm run build` +
  `validate:contract-drift`, not a manual gap — spot-checked this run against the just-shipped v440
  emission-gate fields (`emission_gate_bar`/`emission_bar_quantile`/`emission_gate_exponent`/
  `emission_gate_exponent_effective`, epic #8739): present and in sync across `public/metagraph/openapi.json`,
  `generated/graphql/types.ts`, and the resolver map, same day the REST route shipped. Don't expect a
  manual parity-gap vein here again unless codegen itself breaks.
- **Also checked and empty**: a repo-wide `TODO`/`FIXME`/`HACK:` grep across `src/`, `workers/`,
  `apps/ui/src/` found exactly one hit (`apps/ui/src/lib/metagraphed/partners.ts:22`, a real partner
  hotkey placeholder — needs the maintainer's own wallet data, not contributor-fileable). Every active
  epic's own "Sub-issues" section names concrete near-term work, but on inspection every one either (a)
  already has its named sub-issues filed and closed (epic bodies don't self-update, so read the epic's
  actual `subIssues` via GraphQL, not just its prose — #8350/T9 looked like a 2-issue gap from its body
  text alone and was actually fully shipped, #8384/#8385/#8527 all closed) or (b) is genuinely blocked on
  a maintainer-only prerequisite (archive node reaching chain tip for #8345/T4's #8368; a design decision
  or backend groundwork not yet merged for the SN74/#8617, TAO/USD/#8600-8603, and v440/#8739 epic
  families' UI-layer sub-issues).
- **Net takeaway for the next run**: don't assume zero-yield is a script bug — verify fresh, but if the
  same drought shows up a third consecutive time, that's a real signal worth raising to the maintainer
  directly (parked design-spikes resolving, or the "what's safe to unleash" bar needing a second look)
  rather than something to keep silently re-deriving.

**2026-07-25 correction — the entire prior snapshot below is obsolete, not just drifted.** Between
roughly 2026-07-20 and 2026-07-25 the maintainer (plus a small number of very active contributors)
drained essentially the entire historical backlog this table used to describe: all four `Wave 1-4`
milestones (49 + 6 + 411 + 39 = 505 issues) closed out completely, the ~120-issue "MCP execute:
verify + wire SN\*" family fully closed (verified anti-pattern-free — see SKILL.md's dedicated
subsection), the entire REST/GraphQL/MCP tri-surface parity effort essentially finished (spot-checked
2026-07-25: 174 MCP tools / 177 REST routes / 178 GraphQL Query fields, all near-complete parity), and
the generated-types epic (#7858, Zod/OpenAPI/Postgres/GraphQL/MCP codegen, batches lettered A-F) closed
the same day this correction was written. **Total open issues dropped to 28, of which zero were
contributor-available** (unassigned, no `maintainer-only`, carrying a `gittensor:*` label) at the start
of the 2026-07-25 run — the first time this pipeline has observed the floor at literally zero. Do not
trust any milestone count below as anything but a historical snapshot; re-derive fresh every run via
`gh api graphql` `milestones(states:[OPEN,CLOSED])` with per-milestone `issues(states:OPEN)`/
`issues(states:CLOSED)` counts, exactly as this correction did.

| Milestone                                                    | Open (as of 2026-07-25)                           | Nature                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Foundations & Infra` (#11)                                  | 6 open / 480 closed                               | General backend/infra work, mixed maintainer/contributor. Also the default home for well-precedented REST/GraphQL/MCP parity issues and (as of 2026-07-25) the design-token lint-ratchet-completion batch (#8167-8172) — no dedicated frontend-cleanup milestone exists yet.                          |
| `Wave 1 — Backend (CSV · Events · Correctness · Tests)` (#7) | 0 open / 49 closed — **milestone itself CLOSED**  | Fully drained. Don't source here.                                                                                                                                                                                                                                                                     |
| `Wave 2 — Backend Data (Validators & Economics)` (#8)        | 0 open / 6 closed — **milestone itself CLOSED**   | Fully drained. Don't source here.                                                                                                                                                                                                                                                                     |
| `Wave 3 — Frontend (post-consolidation)` (#9)                | 0 open / 411 closed — **milestone itself CLOSED** | Fully drained as of 2026-07-25 (was 11 open on 2026-07-15 — do not trust that older snapshot either; re-verify every run, this repo's counts move fast in both directions).                                                                                                                           |
| `Wave 4 — Docs & Dev Surface` (#10)                          | 0 open / 39 closed — **milestone itself CLOSED**  | Fully drained. The fumadocs-mdx port (#6225) landed 2026-07-16 and all "Docs page: X" issues shipped and closed by #6232 — don't look here for top-up material, per SKILL.md.                                                                                                                         |
| `Partner Flywheel Hardening` (#13)                           | 1 open / 18 closed                                | Small, check individually                                                                                                                                                                                                                                                                             |
| `MCP Platform — Unified Subnet Access` (#14)                 | 4 open / 138 closed                               | The "MCP execute: verify + wire SN\*" family (#7017-#7136) fully closed 2026-07-22 and re-verified anti-pattern-free 2026-07-25 (see SKILL.md). The 4 remaining open issues are a _different_ sub-effort (#6893/6895/6896/6897, "publish a metagraphed Agent Skill") — don't generate more of either. |
| `iOS App (TestFlight)` (#15)                                 | 6 open / 0 closed                                 | Brand-new epic (#6910), all 6 sub-issues are design-spikes/account-setup/scaffolding — genuinely too early-stage for any contributor unlock yet (tech stack and v1 scope aren't decided). All correctly `maintainer-only`.                                                                            |
| `PostHog Consolidation` (#17)                                | 4 open / 10 closed                                | Active epic (#7757). Remaining open items (#7765 insights/dashboards buildout, #7767 Umami decommission, #7803 data-warehouse spike) are PostHog-console/business-gated work, not code a contributor PR naturally fits — correctly `maintainer-only` as of 2026-07-25.                                |
| `Frontend - Lovable Design Enhancements` (#16)               | 0 open / 18 closed — **milestone CLOSED**         | Fully drained.                                                                                                                                                                                                                                                                                        |
| Unmilestoned                                                 | re-verify fresh every run                         | The Enrich-SNxx rolling-intake family + the bot-managed Dependency Dashboard are correctly standalone; anything else unmilestoned is a real hygiene gap.                                                                                                                                              |

**Every gardening-generated issue gets a milestone — none ship unmilestoned** (reinforced by the
maintainer, 2026-07-15) — **except the established `types-epic <letter> batch N` precedent** (see
"Reuse-existing-pattern" below), which the maintainer's own issues in this exact family (#8055-8064,
#8065-8076, and the D-batches filed 2026-07-25) consistently ship with `milestone: null`; mirror that
precedent exactly for that one issue family rather than force-fitting a milestone onto it. Default to
the closest-fitting existing one from the table above for everything else. A new milestone is
warranted only when nothing existing fits AND the work is either a genuinely major initiative or a
recurring category that will keep needing a home — see gittensory/loopover's own `reference.md` for the
`Miner Wave 4.5` precedent of the latter case. A one-off oddity alone isn't enough justification; when
genuinely unsure on a high-stakes call like this, propose 1-2 options, but default to deciding and
documenting the reasoning rather than blocking a run on confirmation.

## Where contributor-available issues actually come from, now that Wave 1-4 are gone (added 2026-07-25)

With the entire Wave 1-4 backlog and the tri-surface parity effort drained, the two productive veins
found on 2026-07-25 were:

- **Design-token lint-ratchet completion** (`apps/ui/src/components/metagraphed/**`,
  `packages/ui-kit/src/components/**`): PR #8101 (closing #7851) introduced a one-way
  `RATCHETED_DIRS` eslint mechanism and promoted every _already-clean_ directory to error-tier, but
  explicitly left the two components directories un-ratcheted (81 + 19 files still had
  `no-restricted-syntax` violations) as follow-up work. Filed as #8167-8172 (6 issues, `gittensor:bug`
  - `help wanted` + `frontend`, milestone `Foundations & Infra`) — genuinely contributor-safe (a
    contributor-authored PR already closed the analogous #7912 refactor), mechanical (each violation's
    own eslint message names the exact token/component fix), and independently batchable per file group.
    Note: any apps/ui-touching PR still needs the before/after screenshot table and is still always held
    for manual review per CLAUDE.md's own frontend rule — that doesn't change contributor-eligibility of
    the issue, just how its PR gets reviewed.
- **Generated-types epic follow-on batches** (types-epic D, GraphQL resolver typing): epic #7858
  closed with sub-issues A/C/E fully complete but B and D each landing as a 5-field/route pilot with
  the remaining fields explicitly deferred to a batch decomposition (exactly B's own established
  precedent, which the maintainer worked through directly as batches 1-10 on 2026-07-25 while this
  gardening run was in progress). D's ~150-field batch decomposition was still unfiled as of this run
  — filed as #8158-8166 (9 issues) mirroring B/E's exact batch precedent. **These are `maintainer-only`
  by precedent** (every prior B/E batch issue was `maintainer-only`/assigned-JSONbored even after a
  contributor ended up merging the PR) — they do NOT count toward the contributor-available target,
  but are legitimate Pass 3 epic-health forward-looking work.

Both REST/GraphQL/MCP parity (dozens of PRs merged 2026-07-20 through 2026-07-25) and the Postgres/DB
row-type codegen (types-epic C) are now essentially fully mined — don't expect more low-hanging fruit
there without a fresh code change creating new drift. If a future run also finds the contributor-
available count stuck near zero, the next things worth checking (not yet tried as of this run): a
targeted eslint sweep for the OTHER Bone & Ink sub-rules beyond `no-restricted-syntax`, a fresh
`npm run test:coverage` read for any file that dipped below the repo's ~98%/~90% norm, and whatever new
surface area the PostHog Consolidation / iOS App epics open up once their current design-spike/business
-gated issues resolve into buildable scope.

## Labels — this repo's own convention, don't force gittensory's onto it

- `gittensor:bug` (0.05x), `gittensor:feature` (0.25x), `gittensor:priority` (1.5x) — same point
  values as gittensory, **but `gittensor:priority` is used far more liberally here** (historically
  roughly a third of all open issues, often standalone with no `gittensor:feature`/`gittensor:bug`
  pairing — re-verify the ratio fresh each run, since the 2026-07-25 backlog drain reset the open-issue
  population this stat is drawn from to a tiny N). Follow this repo's existing density, don't
  artificially scarce it down to match gittensory.
- `help wanted` — paired with points labels, same as gittensory.
- `backend` / `frontend` — apply when the work is clearly one or the other; skip when it's genuinely
  both or neither (e.g. a pure docs/data issue).
- `maintainer-only` — historically used on the majority of open issues (~57%, 81/142 as of 2026-07-14).
  As of the 2026-07-25 backlog drain, it's **all 28** of the (much smaller) surviving open-issue
  population — re-derive the ratio fresh each run rather than trusting either number, this repo's
  denominator can now swing an order of magnitude between runs. Only ~14 of the historical 81 also
  carried `roadmap`, so **don't assume the `roadmap`+`maintainer-only` pairing convention from
  gittensory applies here** — in this repo `maintainer-only` alone is a complete, sufficient signal.
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

## Reuse-existing-pattern is mandatory, not implied, whenever a real precedent exists

Maintainer's own words, 2026-07-21: "gittensor miners are lazy and don't care, so we need to be
extremely clear about what's wanted/needed." Applies here exactly as it does on gittensory/loopover's
own copy of this skill (see that repo's `reference.md` for the full incident writeup) — a contributor's
AI-harness agent reads only the issue text, not this skill file, not either repo's CLAUDE.md, and not
"the obviously right way to do it."

**What this broke on the sibling repo already:** a batch of issues had their labels flipped to
contributor-eligible, but the body text was left saying `maintainer-only` verbatim in the footer, and
one issue's Deliverables left the actual artifact ambiguous between three different plausible shapes
with no pick. Caught only because the maintainer asked for the whole body to be reread end-to-end
rather than trusting each edit in isolation.

**How to apply here:** whenever an issue's fix has a real existing precedent to follow — an existing
route/endpoint's shape, an existing schema pattern, an existing Worker handler, a comparable already-
merged PR — name the _exact_ file/PR to mirror as a leading, standalone callout (not buried in prose
Context), and state explicitly what does **not** satisfy the issue (a differently-shaped
implementation, an unspecified choice among multiple plausible artifacts, a new parallel mechanism
instead of extending the cited one). Applies to code issues under the template below; for
registry/surface-data issues, the equivalent is naming the exact sibling subnet file whose surface
shape/format should be mirrored, per `.claude/skills/metagraphed/reference.md`'s own conventions.

Before publishing any batch, reread each finished issue body end-to-end — not just the diff of what
changed — to catch exactly this class of self-contradiction.

## Full-scope completeness is mandatory — no partial-credit issues (reinforced 2026-07-25)

Maintainer's own words, 2026-07-25: "contributors will throw their AI tools at this for the least
path of resistance and submit the shittiest / lowest quality stuff possible to get it completed as
fast as possible unless we are extremely explicit on exactly what we expect... I expect the entire
issue done flawlessly start to finish, not broken up into smaller pieces and nothing skipped."

This extends the "Reuse-existing-pattern is mandatory" rule above from _which shape to follow_ to
_how much of it must ship_. Every generated issue must leave zero room for a contributor's AI-harness
agent to rationally conclude that implementing a subset of the Deliverables checklist, or the
laziest-possible interpretation of a Requirement, satisfies the issue.

**How to apply when authoring a new issue:**

- **Requirements must be concrete and testable, never open to interpretation.** Not "add filters to
  X" — name every filter param, its type, its validation behavior, and cite the exact sibling
  route/field whose parameter-handling to mirror (per the precedent-callout rule above).
- **Every item in the Deliverables checklist ships together, in one PR, or the issue is not done.**
  Say this explicitly in the issue body (a fixed closing line, see the template below) — don't rely on
  the checklist format alone to imply it. A PR that completes 2 of 4 checklist items and asks to land
  is a partial delivery, not a done issue.
- **Expected Outcome must be a falsifiable end-state, not a vague direction.** Someone (or an
  automated reviewer) must be able to check yes/no from the PR diff alone — "the field now supports a
  `sort` and `order` param, matching `<sibling route>`'s validation" is falsifiable; "the field is
  improved" is not.
- **Don't under-scope a coherent unit of work just to make the issue look more approachable** — an
  issue whose own Requirements are incomplete, or whose Deliverables can be half-satisfied and still
  plausibly read as "done," invites exactly the shortcut-taking this section exists to prevent. This is
  separate from splitting a genuinely large epic into multiple _sequential, individually-complete_
  issues (e.g. the `types-epic B batch N` family) — each batch issue is itself fully scoped and
  independently completable end to end, and that decomposition is fine. What's not fine is a single
  issue that itself ships incomplete or half-satisfiable.
- Before publishing, reread the finished issue body and ask: "if a contributor did the least possible
  work that could arguably satisfy this text, would that match what the maintainer actually wants
  shipped?" If there's daylight between those two, tighten the text until there isn't.

Applies to every new issue from Pass 2 and Pass 3, and to any existing issue's body that Pass 1
rewrites for clarity — this is a standing authoring bar, not a one-time pass.

## Issue body template

```md
## Context

<what exists today, cite real file/schema/route paths, why this matters>

## Requirements

<concrete, testable requirements>

## Deliverables

- [ ] <concrete artifact 1>
- [ ] <concrete artifact 2>

All of the above ship together in one PR — a PR that completes only some of these items does not
satisfy this issue.

## Expected Outcome

<what's true after this ships that wasn't true before — falsifiable from the PR diff alone>

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
