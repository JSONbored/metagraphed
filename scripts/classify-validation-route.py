#!/usr/bin/env python3
"""Classify a PR's validation route for CI (UGC submission vs full validation).

Reads ``changed-files.txt`` (one path per line, produced by the merge-base diff in
the classify-validation-route composite action) and decides:

  * ``mode=ugc``   — the PR is a community direct submission with no classifier
                     errors: a single candidate, a single provider, or an atomic
                     provider+candidate pair
                     (registry/{candidates,providers}/community/<slug>.json). The
                     checks job runs the light submission preflight only.
  * ``mode=full``  — everything else. The full build + contract/schema/safety
                     suite runs (and the test job runs the test suite).

This is pure stdlib so it can run BEFORE ``npm ci`` (letting the test job skip
install for UGC PRs). It mirrors the canonical classifier in
``scripts/submission-policy.mjs`` (also exposed via ``scripts/ci-validate-route.mjs``);
keep the two in sync. Writes ``validate-route.json`` for debugging and appends
``mode``/``scope`` to ``$GITHUB_OUTPUT`` when present.
"""

import json
import os
import pathlib
import re

changed_files = sorted(
    file.strip().replace("\\", "/").removeprefix("./")
    for file in pathlib.Path("changed-files.txt")
    .read_text(encoding="utf-8")
    .splitlines()
    if file.strip()
)
candidate_pattern = re.compile(r"^registry/candidates/community/[a-z0-9][a-z0-9-]*\.json$")
provider_pattern = re.compile(r"^registry/providers/community/[a-z0-9][a-z0-9-]*\.json$")
candidate_files = [file for file in changed_files if candidate_pattern.fullmatch(file)]
provider_files = [file for file in changed_files if provider_pattern.fullmatch(file)]
touched_community = [
    file
    for file in changed_files
    if file.startswith("registry/candidates/community/")
    or file.startswith("registry/providers/community/")
]
errors = []
submission_files = candidate_files + provider_files
# An atomic provider+candidate PAIR (one of each) is a valid debut shape: a
# first-time team registers its provider and lands its first surface in one PR.
is_pair = len(candidate_files) == 1 and len(provider_files) == 1
if not submission_files and not touched_community:
    scope = "normal-pr"
else:
    if is_pair:
        scope = "direct-pair"
    elif len(provider_files) == 1:
        scope = "direct-provider"
    else:
        scope = "direct-candidate"
    # Allowed shapes: exactly one candidate, exactly one provider, OR the atomic
    # pair. Anything else is out-of-shape (mirrors classifyPrScope).
    if len(submission_files) != 1 and not is_pair:
        errors.append(
            {
                "category": "unsupported-shape",
                "message": "direct submissions must change exactly one registry/candidates/community/*.json or registry/providers/community/*.json file, or an atomic provider+candidate pair (one of each)",
            }
        )
    unrelated = [
        file
        for file in changed_files
        if not candidate_pattern.fullmatch(file) and not provider_pattern.fullmatch(file)
    ]
    if unrelated:
        errors.append(
            {
                "category": "generated-artifact-tampering",
                "message": "direct submissions cannot change other files: " + ", ".join(unrelated),
            }
        )
# Mirrors scripts/ci-validate-route.mjs: any non-normal-pr scope with no classifier
# errors takes the light ugc lane; an error (any shape/tampering issue) forces full.
mode = "ugc" if scope != "normal-pr" and not errors else "full"
report = {
    "schema_version": 1,
    "mode": mode,
    "scope": scope,
    "changed_files": changed_files,
    "candidate_files": candidate_files,
    "provider_files": provider_files,
    "errors": errors,
}
pathlib.Path("validate-route.json").write_text(
    json.dumps(report, indent=2) + "\n", encoding="utf-8"
)
output_path = os.environ.get("GITHUB_OUTPUT")
if output_path:
    with open(output_path, "a", encoding="utf-8") as output:
        output.write(f"mode={mode}\n")
        output.write(f"scope={scope}\n")
print(json.dumps(report, indent=2))
