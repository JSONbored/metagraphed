#!/usr/bin/env bash
# Gate the metagraphed PyPI release: run from main, read the version from
# python/pyproject.toml, require strict semver, and refuse if the git tag or the
# PyPI version already exists. Mirrors scripts/validate-client-release.sh.
set -euo pipefail

if [ "${GITHUB_REF:-}" != "refs/heads/main" ]; then
  echo "::error::metagraphed PyPI releases must run from main."
  exit 1
fi
if [ -z "${GITHUB_OUTPUT:-}" ]; then
  echo "::error::GITHUB_OUTPUT is required."
  exit 1
fi

release_version="$(python3 -c "import tomllib, pathlib; print(tomllib.loads(pathlib.Path('python/pyproject.toml').read_text())['project']['version'])")"
if ! printf '%s' "$release_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "::error::python/pyproject.toml version must be strict semver without a v prefix."
  exit 1
fi

release_tag="python-v$release_version"
release_tag_commit=""
if release_tag_commit="$(git rev-parse "$release_tag^{commit}" 2>/dev/null)"; then
  if [ "${RELEASE_PLEASE_TRIGGERED:-}" != "true" ]; then
    echo "::error::Release tag already exists: $release_tag"
    exit 1
  fi

  if [ -z "${GITHUB_SHA:-}" ]; then
    echo "::error::GITHUB_SHA is required for release-please-triggered releases."
    exit 1
  fi
  # The publish workflow is dispatched on --ref main, so main may have
  # advanced after release-please created the tag. Accept that only when the
  # package sources being built are byte-for-byte identical to the tagged
  # release tree; otherwise an older release tag/version could publish newer,
  # untagged code.
  if ! git merge-base --is-ancestor "$release_tag_commit" "$GITHUB_SHA" 2>/dev/null; then
    echo "::error::Release tag $release_tag ($release_tag_commit) is not an ancestor of the workflow commit $GITHUB_SHA — refusing a tag that is not on this branch's history."
    exit 1
  fi
  if ! git diff --quiet "$release_tag_commit" "$GITHUB_SHA" -- python; then
    echo "::error::Release tag $release_tag ($release_tag_commit) does not match the metagraphed Python sources at workflow commit $GITHUB_SHA; refusing to publish untagged package contents."
    exit 1
  fi
  echo "Tag $release_tag is on the workflow commit's history and package sources match; continuing."
elif [ "${RELEASE_PLEASE_TRIGGERED:-}" = "true" ]; then
  echo "::error::Release tag is required for release-please-triggered releases: $release_tag"
  exit 1
fi
if curl -fsS "https://pypi.org/pypi/metagraphed/$release_version/json" >/dev/null 2>&1; then
  echo "::error::PyPI version already exists: metagraphed==$release_version"
  exit 1
fi

{
  echo "version=$release_version"
  echo "tag=$release_tag"
} >>"$GITHUB_OUTPUT"
echo "Releasing metagraphed==$release_version (tag $release_tag)."
