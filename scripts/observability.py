"""Shared Sentry init for the box-side chain-direct fetch scripts -- used by
fetch-metagraph-native.py, fetch-account-identity.py,
fetch-subnet-hyperparams.py, and fetch-validator-nominator-counts.py so all
four report to the same consolidated `metagraphed` Sentry project with a
consistent `component` tag. Deployed via metagraphed-infra's data-refresh-cron
Ansible role, which clones this repo at container runtime rather than
tracking its own copy of these scripts -- see metagraph-fetch-entrypoint.sh's
own header for why (a prior copy-based deployment let this exact class of
file go stale between the two repos).
"""

import os


def init_sentry(component):
    """No-ops silently if SENTRY_DSN is unset, matching this fetch
    container's own "gets zero secrets" design (see
    deploy/metagraph-fetch.Dockerfile's header) -- SENTRY_DSN is NOT a
    secret in the same sense (Sentry DSNs are designed to be safe to embed
    in client-side/public code, write-only), so passing it into this
    untrusted container is consistent with that design, not a violation of
    it. Safe to call even if sentry_sdk somehow isn't installed (falls back
    to a no-op with a stderr warning instead of crashing the caller).
    """
    dsn = os.environ.get("SENTRY_DSN")
    if not dsn:
        return
    try:
        import sentry_sdk
    except ImportError:
        import sys

        print(
            f"[{component}] SENTRY_DSN is set but sentry_sdk is not installed -- skipping init",
            file=sys.stderr,
        )
        return

    sentry_sdk.init(
        dsn=dsn,
        environment=os.environ.get("SENTRY_ENVIRONMENT", "production"),
        # Set by metagraphed-infra to the deployed metagraphed git SHA (the
        # commit this container's entrypoint cloned at startup). None is a
        # valid, accepted value (Sentry just omits release tagging), not an
        # error condition.
        release=os.environ.get("SENTRY_RELEASE"),
        # Error tracking only -- these are short-lived batch scripts run on
        # a daily/weekly cron, not request-serving services.
        traces_sample_rate=0.0,
    )
    sentry_sdk.set_tag("component", component)


def capture_exception(exc=None, **tags):
    """Thin wrapper so callers never need `import sentry_sdk` directly --
    keeps every fetch script importable/unit-testable without sentry_sdk
    installed at all, matching this codebase's existing lazy-bittensor-
    import convention. Safe to call unconditionally.
    """
    try:
        import sentry_sdk
    except ImportError:
        return
    with sentry_sdk.new_scope() as scope:
        for key, value in tags.items():
            scope.set_tag(key, value)
        sentry_sdk.capture_exception(exc)
