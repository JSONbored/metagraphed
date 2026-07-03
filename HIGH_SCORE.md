# High Score — Update PR Workflow

Use this checklist before opening any PR against `JSONbored/metagraphed`.

## 0) Keep repository in-date first

```bash
git fetch upstream main
export PR_BRANCH="update-pr-workflow"
git checkout -B "$PR_BRANCH" upstream/main
git status
```

If the branch is behind, rebase before editing:

```bash
git fetch upstream main
git rebase upstream/main
```

## 1) Read the contributor contract

Before any file edits, read:

- `.claude/skills/metagraphed/SKILL.md`
- `.claude/skills/metagraphed/reference.md`
- `AGENTS.md`

Key non-negotiables:

- One subnet contribution must edit exactly one `registry/subnets/<slug>.json` file.
- Surface entries must include `authority: "community"` and `review.state: "community-submitted"`.
- No generated artifacts in `public/` for surface-only PRs.
- No secrets/private URLs/placeholder credentials.
- No new in-code comments.

## 2) Review current PR landscape first

The maintainer flow is one-shot: duplicated surface, scoped scope-breaks, clear reject signals, or red CI closes PRs quickly.

Current visible rejection patterns (from recent closes) include:

- Duplicate entry in existing registry manifest (`gittensor/gradients` duplicate URL).
- Changed-file scope violation (surface PR plus worker/scripts/tests/public artifacts in one PR).
- CI blockers (`codecov` patch coverage, guard-blocked path checks).

## 3) Duplicate/scope conflict scan against open PRs

Run this before opening your PR:

```bash
open_prs="$(curl -sS -H 'Accept: application/vnd.github+json' \
  'https://api.github.com/repos/JSONbored/metagraphed/pulls?state=open&per_page=100' \
  | jq -r '.[].number')"

for pr in $open_prs; do
  printf "\n#%s\n" "$pr"
  curl -sS -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/JSONbored/metagraphed/pulls/$pr/files?per_page=100" \
    | jq -r '.[].filename' | sed 's/^/  /'
done
```

Before creating the PR diff, compare your target path(s) to open PR changed files:

- `registry/subnets/<slug>.json` already appears in another open PR.
- Same subnet appears in multiple PRs with different intents.
- You are touching non-registry files for a registry contribution.

## 4) Validate by contribution type

- **Surface updates** (`registry/subnets/...` only):
  - `npm run validate:surface -- registry/subnets/<slug>.json`
  - `npm run scan:public-safety`
  - Ensure `git diff --stat` shows only the subnet manifest file.
- **Code/schema changes**:
  - Make changes in `src/`, `schemas/`, scripts, etc.
  - Run required tests and `npm run build`.
  - Commit generated artifacts from this PR only.
  - Never commit `public/metagraph/r2-manifest.json` or `public/metagraph/schemas/index.json` unless the project rules change.

## 5) PR text and final gate

PR body should include:

- For surface PRs: summary, proof links (`url` + `source_url`), and local validate commands.
- For code/schema PRs: include validation and test commands plus artifact scope.
- Duplicate check result with open PR/issue review (if any overlap).
- Conventional commit subject style and no AI/agent attribution.

After opening:

- Watch `Validate` and `Gittensory Gate`.
- If red, fix and reopen via fresh PR only.
- Never push a PR that violates scope checks above.
