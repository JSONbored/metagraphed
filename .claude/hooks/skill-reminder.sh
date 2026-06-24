#!/usr/bin/env bash
# PostToolUse (Edit|Write|MultiEdit) reminder for metagraphed.
#
# When a fundamental file changes, nudge to keep the generated contract and the
# contributing-to-metagraphed skill in sync — the two things we've repeatedly
# forgotten and red-mained / shipped stale. Advisory only: always exits 0, never
# blocks an edit. Reads the hook payload (tool_input.file_path) on stdin.
command -v jq >/dev/null 2>&1 || exit 0
f=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$f" ] && exit 0

m=""
case "$f" in
  */schemas/*)
    m="schemas/ changed → run npm run build + commit public/metagraph/{openapi.json,types.d.ts,contracts.json,api-index.json} (validate:contract-drift gates this)."
    ;;
esac
case "$f" in
  */schemas/* | */scripts/build-artifacts.mjs | */scripts/submission-policy.mjs | */scripts/validate-intake.mjs | */scripts/surface-add.mjs | */scripts/subnet-new.mjs | */scripts/lib.mjs | */workers/api.mjs | */.github/workflows/validate.yml)
    m="${m:+$m | }fundamental change → update .claude/skills/contributing-to-metagraphed (SKILL.md + reference.md) if the contributor flow, gates, or schema changed."
    ;;
esac
[ -z "$m" ] && exit 0

jq -cn --arg m "$m" '{systemMessage:("metagraphed: "+$m), hookSpecificOutput:{hookEventName:"PostToolUse", additionalContext:("metagraphed reminder: "+$m)}}'
