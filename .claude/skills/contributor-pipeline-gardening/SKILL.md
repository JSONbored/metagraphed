---
name: contributor-pipeline-gardening
description: >-
  Maintenance of the contributor issue pipeline for JSONbored/metagraphed — closing issues that
  are already done but not marked so, and keeping the contributor-available backlog at its
  50-100+ steady-state floor with well-scoped new issues. Runs every ~8h via the scheduled task
  (raised from daily on 2026-07-15 so the floor is maintained continuously, not caught up once a
  day). Invoke for "run the issue gardening", "audit open issues for stale/complete ones",
  "generate new contributor issues", or any recurring/scheduled run of this process.
  `reference.md` (next to this file) has the exhaustive label/milestone/template detail — read it
  before doing real work, not just this file. This is the metagraphed-specific instance;
  JSONbored/gittensory (loopover) has its own separate copy with different conventions — do not
  cross-apply either repo's specifics to the other without being asked.
---

# Contributor pipeline gardening — metagraphed

metagraphed is a Bittensor subnet registry / block-explorer product. Unlike gittensory/loopover,
**a linked issue is optional here** — the gate judges a PR on its own merit when nothing is linked,
it only auto-closes for a missing link if a linked issue was claimed and doesn't hold up (see
`.claude/skills/metagraphed/SKILL.md`). So the existential pressure to keep a full pipeline is lower
than in gittensory, but it's still the main way to (a) direct contributor effort at what actually
matters instead of ad-hoc surface PRs, and (b) hand out `gittensor:*` points fairly. Do both passes
below; treat the top-up target as "keep good, well-directed work available," not "prevent PRs from
being rejected."

## Pass 1 — stale-issue sweep (do this first, every run)

Same method as gittensory's copy of this skill (see that repo's `reference.md` if you need the full
GraphQL walkthrough) — for every open issue, query `timelineItems(itemTypes: [CROSS_REFERENCED_EVENT])`
for merged PRs that referenced it, then read the actual PR body for any hit where `willCloseTarget`
was false. Close what's genuinely done (with a comment naming the shipping PR and, ideally, a direct
grep confirming the described code/route/page exists); leave partial work open, optionally with a
scope-clarifying comment.

**Verify against synced upstream, not a stale local checkout.** Before treating any local grep/read
as evidence that an issue's described work does or doesn't exist, confirm the code you're reading
matches the default branch's current tip — fetch and fast-forward the checkout (or use a disposable
worktree off `origin/main` if the primary checkout is dirty or has unpushed work on another branch)
before doing any verification. A checkout that's merely _clean_ isn't the same as _current_ — a
stale-but-clean checkout silently produced false "already done"/"not done" conclusions here and in a
sibling repo's gardening run on 2026-07-17/18, causing duplicate issues to be filed for already-shipped
work. Confirm sync every run; never assume a previous run's freshness carried over.

**metagraphed-specific things to check while doing this:**

- Milestone **#9 "Wave 3 — Frontend (post-consolidation)"**: checked 2026-07-15, it is **not**
  actually drained (11 open issues at that point, not the 0/480 an earlier snapshot of this doc
  claimed) — re-verify its open-issue count fresh each run rather than trusting either number here,
  this repo's milestones fill back up between runs.
- **Unmilestoned-issue count**: checked 2026-07-15, only 23 of ~94 open issues were unmilestoned, and
  all 23 were legitimately standalone (the Enrich-SNxx rolling-intake family, which is correctly
  unmilestoned per its own separate automation, plus the bot-managed Dependency Dashboard) — not an
  orphan-hygiene gap the way the original "74 of 142" snapshot implied. Re-verify fresh each run
  rather than assuming either the old or new number still holds; if genuine orphans turn up (a
  real code/schema/data issue with no milestone, not Enrich-SNxx or the Dependency Dashboard), fold
  them into the closest fit (`Foundations & Infra`, `Wave 4 — Docs & Dev Surface`, `Partner Flywheel
Hardening`) same as before.
- The **native-staking feature work** (`gittensor:feature`/`maintainer-only` issues in the low-5200s
  numbering, "take/commission management," "move/re-delegate stake flow," "risk disclosure copy") is
  active and security-sensitive — treat anything touching real stake movement, phishing surface, or
  the pre-launch security review as `maintainer-only` by default; don't second-guess that boundary.

## Pass 2 — backlog top-up

1. Compute this repo's own contributor-available count (unassigned, no `maintainer-only`, carries a
   `gittensor:*` label) before deciding how much to generate here — the target is **50-100+ open
   contributor-available issues, independently per repo, maintained AT ALL TIMES** (reinforced by the
   maintainer 2026-07-15 — this is a steady-state floor to keep continuously, not a one-time catch-up;
   the scheduled task's cadence was raised from daily to every 8h the same day specifically so this
   gets re-checked well within a day). This is NOT a combined/shared pool with gittensory/loopover;
   each repo is judged on its own backlog and must clear the bar on its own merits, focused on that
   repo's actual goals (corrected by the maintainer 2026-07-14 — an earlier version of this doc wrongly
   said "combined total, not per-repo"). **Exclude the "Enrich SNxxx" family (see below) from this
   count** — it's a separately-automated queue, not this skill's backlog. **Don't just aim for the
   floor (50) — push toward the top of the range (closer to 100) whenever real, non-padded gaps are
   still findable** (reinforced by the maintainer 2026-07-15: more well-scoped available issues is
   straightforwardly good for the project, since it's more real work contributors can pick up). If the
   count is under ~100, keep sourcing issues until it's close to 100 (or a pass genuinely turns up no
   more real, non-duplicate gaps) — don't stop at a modest first batch just because "quality over
   volume" (point 7 below) was satisfied, and don't declare victory the moment 50 is cleared.
   1a. **The "Enrich SN<netuid> ..." family (tracked via #427, ~20-30 issues at any time) is handled by
   a separate automation, not this skill.** Don't count them toward the 50-100 top-up target (filter
   out any issue whose title matches "Enrich SN" before comparing against the target), and don't
   generate more of them yourselves — that automation owns that queue. Pass 1's stale-sweep/hygiene
   work (closing genuinely-done ones, fixing stale checkboxes) still applies to them like any other
   issue; the exclusion is specifically about Pass 2's top-up math (confirmed by the maintainer
   2026-07-14).
2. This repo's contributor-availability query needs `gittensor:priority` counted alongside
   `gittensor:feature`/`gittensor:bug` — unlike gittensory, metagraphed frequently uses
   `gittensor:priority` as a **standalone** points label (54 of 59 `gittensor:priority` issues here
   carry no `gittensor:feature`/`gittensor:bug` pairing, as of 2026-07-14). Don't "fix" this to match
   gittensory's scarcer convention unless asked — it's this repo's own established norm.
3. Real, concrete gaps worth scoping from first: the **"Docs page: <endpoint>" family** in
   `Wave 4 — Docs & Dev Surface` (docs for existing shipped API surfaces — `/rpc/*`, `/api/v1/search`,
   `/api/v1/webhooks/*`, etc.) are currently `maintainer-only` but look like exactly the kind of
   low-risk, precedent-following, no-business-judgment work this framework says is safe to unlock —
   worth a first-pass review to confirm and relabel rather than only generating net-new issues.
4. **Every new issue gets a real milestone — no issue ships unmilestoned.** A `gittensor:bug`/
   `gittensor:feature`/`gittensor:priority` label (this repo's own convention — priority isn't scarce
   here the way it is in gittensory, but still means "the maintainer actually wants this soon," don't
   apply it reflexively to everything), and `help wanted` (paired convention here too). Do NOT apply
   `good first issue` — it isn't a real convention in this repo (the label doesn't exist here,
   confirmed 2026-07-14) and the maintainer doesn't want it introduced. Only `gittensor:*` +
   `help wanted` matter for contributor-available issues.
5. Full body template — Context, Requirements, Deliverables, Expected Outcome, Links & Resources (see
   `reference.md`). Registry/surface-data contributions have their own distinct shape (one file per
   subnet, `registry/subnets/<slug>.json`) — don't template a data-contribution issue the same as a
   code/schema issue; see the `metagraphed` skill's own reference.md for the surface model if
   generating that kind of issue.
6. **Check every new batch for a real dependency, then link it with GitHub's native
   `addSubIssue`/`addBlockedBy` mutations** (confirmed available on this repo, same as gittensory) —
   never a markdown checklist. This is a required check, not optional: most batches of independent
   bug-fixes or REST/GraphQL/MCP-parity additions genuinely have no dependency on each other, and the
   correct outcome of the check is then "no links needed" — don't force one just to look thorough.
   Reserve the links for a real case where working out of order would waste a contributor's time.
7. Quality over the number in what gets filed — don't pad with weak/duplicate/vague issues. This is
   not license to stop early: see point 1's "if under floor" note.

## Pass 3 — Strategic epic/milestone health (once-per-day cadence)

Beyond Pass 1/2's issue-level hygiene, this skill also runs a lighter, once-per-day strategic pass
over active epics/roadmap issues — a `roadmap` label, "Epic:" in the title, or any issue with a
`- [ ]`/`- [x]` child-issue checklist or native GitHub sub-issues. The scheduling automation gates
this to at most once per day independent of how often the outer job itself fires (an external cadence
tracker in the scheduling layer handles that gate — not part of this file).

**When it runs:**

1. Verify every active epic's claimed children are actually filed and in the right state — same
   GraphQL cross-reference method as Pass 1, not text search. Surface now-unblocked follow-on work
   when a previously-blocking issue closes.
2. **Source real forward-looking work, not just verify.** Read each active epic/milestone's own
   stated scope, the current shipped surface (`registry/`, `workers/`, `apps/ui`), and repo docs to
   find concrete, buildable feature or milestone-scoped work that hasn't been filed yet — grounded in
   the product as it exists and the milestone's documented direction, not speculative ideas untethered
   from evidence.
3. **Pass 3 shares Pass 2's own 50-100+ (push toward 100+) contributor-available target — one
   combined per-run volume goal, not a separate small quota** (revised 2026-07-17; an earlier version
   of this pass capped itself at "0-2 issues/day, zero is fine," which under-delivered). If Pass 2's
   own top-up already reached the target, Pass 3 doesn't need to force more just to hit a number; if
   the count is still under-target after Pass 2, Pass 3 should actively help close the gap with real
   feature/milestone issues instead of sitting in verify-only mode. Quality still matters — don't pad
   with weak/duplicate/vague issues — but that's not license to under-deliver: a pass that can't find
   enough real work should say so explicitly in the digest (what was tried, why nothing else was
   fileable), not quietly file 1-2 and call it done.
4. Respect the same "what's safe to unleash" boundary as Pass 2 (native-staking/real-money work stays
   `maintainer-only` by default — don't second-guess it).
5. **Anything that's genuinely business/monetization/competitive-strategy thinking (pricing,
   positioning, hosted-product business strategy) stays out of public issues entirely** — flag it in
   the digest for the maintainer's private roadmap instead of filing it here. This repo's issue
   tracker is contributor-facing; vague vision issues aren't actionable by a contributor anyway.
6. Link every new issue as a native sub-issue of its parent epic via `addSubIssue` where a real parent
   exists; give it a real milestone, same discipline as Pass 2.

## Daily digest

Same shape as gittensory's: issues closed + why, milestones/checklists fixed, new issues filed with
milestone/label (Pass 2 and Pass 3 combined), before/after contributor-available count, whether Pass 3
ran this cycle, anything left alone on purpose.
