#!/usr/bin/env bash
# Run a validator, remember whether it failed, and keep going (#10608).
#
# The validate job chained ~50 validators under Actions' default `bash -e`, so
# the FIRST failure ended the step and every validator after it was skipped.
# The gate was correct -- it just answered one question per run. Measured over
# one evening: #10577 skipped 39 of 52 steps behind a single stale generated
# type, #10572 skipped 20, #10563 skipped 14. Each of those is another full
# ~5-minute run to learn the next thing that was already knowable.
#
# Usage, inside a `run:` block that declares `shell: bash`:
#
#   source .github/scripts/run-step.sh
#   run_step npm run validate:one
#   run_step npm run validate:two
#   report_steps
#
# `report_steps` is what fails the step. FORGETTING IT MAKES THE STEP PASS
# UNCONDITIONALLY, which is the one way this file can make a gate weaker than
# the chain it replaced -- tests/workflow-run-step.test.ts asserts that every
# block sourcing this file ends with it.

# Names of the commands that failed, in the order they ran.
MG_FAILED_STEPS=()
# How many ran at all, so a block that silently executed nothing is visible in
# the log rather than reading as "all passed".
MG_RUN_STEP_COUNT=0

# Run one command. Its output is grouped in the log; a non-zero exit is
# recorded rather than propagated.
run_step() {
  local label="$*"
  MG_RUN_STEP_COUNT=$((MG_RUN_STEP_COUNT + 1))
  echo "::group::${label}"
  # `set -e` is active (Actions runs `bash -eo pipefail`), and a command on the
  # left of `||` is exempt from it -- which is exactly the property this needs.
  if "$@"; then
    echo "::endgroup::"
  else
    local status=$?
    echo "::endgroup::"
    # Outside the group so it is visible without expanding, and annotated so it
    # appears on the run summary rather than only in the log.
    echo "::error::${label} failed (exit ${status})"
    MG_FAILED_STEPS+=("${label}")
  fi
}

# Fail the step if anything did, naming every failure at once.
report_steps() {
  # A block that ran nothing is a broken block, not a passing one -- the same
  # vacuous-pass guard the validators themselves carry. Without this, deleting
  # the run_step lines (or mistyping the helper name) turns the whole group
  # green.
  if [ "${MG_RUN_STEP_COUNT}" -eq 0 ]; then
    echo "::error::run-step.sh was sourced but no step ran -- the block is broken, not passing."
    exit 1
  fi
  if [ ${#MG_FAILED_STEPS[@]} -eq 0 ]; then
    echo "All ${MG_RUN_STEP_COUNT} step(s) passed."
    return 0
  fi
  echo "::error::${#MG_FAILED_STEPS[@]} step(s) failed:"
  local step
  for step in "${MG_FAILED_STEPS[@]}"; do
    echo "  - ${step}"
  done
  exit 1
}
