---
name: frontend-visual-qa
description: >-
  Systematic visual QA sweep of the live metagraphed frontend (apps/ui, served at
  metagraph.sh) — actually browsing pages at real viewports and looking for defects
  only visible on inspection (crowding, overflow, truncation, misalignment), not
  catchable by reading code or trusting a PR's own screenshot table. Produces
  precise, root-caused GitHub issues a contributor's AI coding agent can act on
  correctly without needing design judgment of its own. Invoke for "run a visual QA
  sweep", "find real UI/UX bugs", "check the site for mobile/tablet crowding issues",
  or any request to audit the live frontend for visual defects. Distinct from the
  metagraphed skill (which covers writing a contribution) and code-review (which
  reviews a diff, not live rendered output) — this skill's whole point is that a
  defect can look completely correct in code and still be visually broken.
---

# Frontend visual QA

## Why this exists

Contributors (and the AI agents/harnesses they point at gittensor issues) reliably miss
defects that are only visible on actual inspection: a component's JSX can be
"correct" — right data, right classes, right structure — and still crowd, overflow,
or truncate illegibly at a real viewport width. The mandatory before/after screenshot
table on every frontend PR exists precisely to catch this, but in practice it's
rarely scrutinized carefully by either the contributor's own tooling or a casual
human glance. This skill is the countermeasure: actually look, verify against
source before concluding something is broken, and write up findings precisely
enough that a contributor's AI agent has no room to misjudge "did I actually fix
this."

**The standard this session's sweep (2026-07-19) met, and the bar to keep meeting:**
every finding was confirmed against source code (never filed on visual impression
alone) and root-caused to an exact file/line where feasible — not just "this looks
wrong" but "here is the exact CSS/component reason it's wrong." That rigor is what
makes an issue usable by an agent that can't itself exercise design judgment.

## Method

### 1. Viewports (matches this repo's own PR screenshot convention)

Fixed viewports, not device emulation: **375×812 (mobile)**, **768×1024 (tablet)**,
**1280×800 (desktop)**. Use the Browser tool's `resize_window` with explicit
`width`/`height` — the `preset` shorthand has been unreliable for `desktop` in this
tool (silently kept a stale width in at least one run); always verify the actual
`window.innerWidth` via `javascript_tool` after resizing, don't trust the resize
confirmation message alone.

### 2. Page inventory

Enumerate every route template under `apps/ui/src/routes/*.tsx` (not every dynamic
instance — one visit to `/subnets/1` stands in for all `/subnets/{netuid}`, since
the template is what's being reviewed, not the data). Prioritize by traffic/
complexity: homepage, `/subnets` (index + detail), `/validators` (index + detail),
`/blocks` (index + detail), `/extrinsics` (index + detail), `/accounts/{ss58}`,
`/health`, `/leaderboards`, `/providers`, `/docs`, `/about` — these are the
highest-density, highest-traffic templates and where defects concentrate.

### 3. Two complementary detection techniques — use both, neither alone is enough

**A. Automated overflow scan (fast, precise, catches real horizontal-overflow bugs
a screenshot might not make obvious).** Run this via `javascript_tool` at each
viewport:

```js
(function () {
  const viewportW = window.innerWidth;
  const results = [];
  document.querySelectorAll("*").forEach((el) => {
    // Exclude known-intentional horizontal-scroll patterns before judging anything
    // an overflow bug — see "False positives to rule out" below.
    if (
      el.closest(".mg-ticker-track") ||
      el.closest(".snap-x") ||
      el.classList.contains("snap-start") ||
      el.closest('[class*="overflow-x-auto"]')
    )
      return;
    const rect = el.getBoundingClientRect();
    if (rect.right > viewportW + 2 && rect.width > 0 && rect.width < 400) {
      results.push({
        tag: el.tagName,
        cls: (el.className || "").toString().slice(0, 80),
        right: Math.round(rect.right),
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        text: (el.textContent || "").slice(0, 40),
      });
    }
  });
  return JSON.stringify({
    viewportW,
    count: results.length,
    results: results.slice(0, 10),
  });
})();
```

This finds elements whose right edge exceeds the viewport — the exact signature of
a real overflow bug. Also check `document.body.scrollWidth` vs `window.innerWidth`
as a fast top-level smoke check before drilling into individual elements.

**B. Actual screenshot review (catches what bounding-box math can't).** Crowding,
insufficient spacing, poor information hierarchy, low contrast, awkward wrapping,
and touch-target sizing all require genuinely looking at a rendered screenshot —
no automated check substitutes for this. Scroll through the full page at each
viewport; don't stop at the first fold.

### 4. False positives to rule out before filing anything

Confirmed this session — don't re-learn these the hard way:

- **Marquees/tickers** (`.mg-ticker-track`, or any component whose own source
  comment says "duplicate so the CSS loop is seamless") are _supposed_ to overflow
  their container — that's how a scrolling ticker works. Check the component's
  source before flagging edge-cutoff on anything that looks animated.
- **Horizontally-scrollable snap-carousels** (`snap-x`/`snap-start` classes) are
  intentionally wider than their viewport — content cut off at the edge indicates
  "more to scroll to," not a broken layout. Still worth a UX note if there's no
  visible scroll affordance (fade gradient, arrow), but that's a polish suggestion,
  not a "this is broken" bug.
- **The Browser pane can render solid black / stale content after being idle or
  right after a `resize_window` call** — a known tool quirk, not a site bug. Cross-
  verify with `read_page` (DOM-based, unaffected by pane rendering issues) before
  concluding a blank screen means broken content. A fresh `tabs_create` + navigate
  often resolves it.
- **Suspense/loading states caught mid-render** can look like a large blank gap or
  a missing section. If a value shows an ellipsis/skeleton indicator, the "bug"
  may just be a snapshot mid-load — re-screenshot after a beat (another read_page
  or javascript_tool call, which takes a moment) before concluding anything.
- **`computer` scroll actions frequently report a 30s timeout in this tool but often
  still completed** — re-screenshot to check actual state rather than assuming the
  scroll failed.

### 5. Root-causing a real finding

Once a defect survives the false-positive check, trace it to source before
writing the issue:

1. Find the rendering component (`grep -rn` for the visible text or a distinctive
   class name across `apps/ui/src/routes` and `apps/ui/src/components/metagraphed`,
   and `packages/ui-kit/src` for shared components).
2. Read enough surrounding code to state the _mechanism_ — not just "this
   overflows" but "this grid is `grid-cols-2` at mobile holding 3 items with long
   labels, and the shared `StatTile` component's `truncate` prop defaults to
   `true` instead of wrapping." A mechanism-level description is what lets a
   contributor (or their agent) fix the actual cause instead of patching the
   symptom.
3. If a shared component/utility is the root cause (like a `classNames()` helper
   that doesn't resolve Tailwind conflicts), check whether the same pattern
   appears elsewhere before deciding whether this is a one-off instance fix or a
   systemic issue worth its own separate audit-scoped issue.

### 6. Writing the issue

Follow this repo's own issue template (Context/Requirements/Deliverables/Expected
Outcome/Links), with two things specific to visual bugs:

- **State the reproduction precisely**: exact URL, exact viewport(s) affected
  (many bugs are mobile-only — say so, don't imply it's universal), and either a
  screenshot or the exact DOM measurements that prove it (bounding-box numbers are
  often more precise and reviewable than a description of a screenshot).
- **Don't over-prescribe the fix when there's a genuine judgment call.** If two
  fix directions are both valid (e.g. "wrap the label" vs. "go single-column"),
  present both and say picking one is a judgment call — that's honest about where
  design taste enters, versus the mechanism diagnosis, which shouldn't be a
  judgment call.

### 7. Labeling

Visual bugs found this way are almost always safe contributor work (mechanical,
no business judgment, no security surface) — `gittensor:bug` + `help wanted` +
`frontend`, milestone `Wave 3 — Frontend (post-consolidation)` unless the fix
requires a shared component/utility change that's more backend-adjacent (e.g. a
`classNames`/`packages/ui-kit` audit), in which case `Foundations & Infra` fits
better. Every visual PR still needs the before/after screenshot table regardless
of how it was sourced — that requirement doesn't change.

## Cadence

This is not currently wired to a scheduled task — run on demand ("run a visual QA
sweep") or fold into an existing gardening pass when asked. If a recurring cadence
is wanted, that's a `/schedule` decision for the maintainer to make explicitly, not
something this skill should assume.
