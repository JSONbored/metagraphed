// PostHog error tracking for both of this crate's binaries (../main.rs and
// bin/poller/). No prior Sentry footprint here at all -- this is a new
// capability, not a migration -- added alongside metagraphed#7766's
// "eliminate Sentry, PostHog everywhere" pass once it surfaced that this
// crate (a first-party service that runs continuously against production
// chain data) had zero error-tracking of any kind, only stdout/stderr logs
// via tracing-subscriber plus one narrow Discord webhook for a single
// specific failure mode (main.rs's own alert_stuck_block).
//
// Same shape as every other component's PostHog capture (src/usage-
// telemetry.ts's recordExceptionEvent): a manually-built `$exception` event
// posted to PostHog's raw capture endpoint, no SDK. Unlike the Workers
// (bundle-budget constrained) this crate has no such constraint -- a native
// binary pays no bundle-size cost either way -- but there's still no
// mature, widely-adopted official PostHog Rust SDK the way posthog-node/
// posthog (Python) are for the other native components in this program, so
// hand-rolled raw capture stays the more consistent, lower-risk choice here
// too. Shells out to curl via tokio::process::Command rather than adding an
// HTTP client crate (reqwest et al.) as a new dependency, matching this
// crate's own established convention (see lib.rs's post_sync_json and
// main.rs's alert_stuck_block, both doing the same for their own rare,
// non-hot-path POSTs).
//
// Rust has no JS-style `Error.stack` to walk (no PostHog SDK's manual-
// capture stacktrace.frames shape without adding a `backtrace` dependency
// and parsing its text output, for uncertain added value) -- `value` below
// is instead anyhow's own `{:#}` alternate Display, which already chains
// every `.context()` layer from the error site up to wherever it was
// finally handled into one readable message. That's the same diagnostic
// depth this crate's own `eprintln!("... ({e:#}) ...")` calls already rely
// on everywhere else.

const POSTHOG_CAPTURE_PATH: &str = "/i/v0/e/";
const DEFAULT_POSTHOG_HOST: &str = "https://us.i.posthog.com";
// Stable, shared distinct_id -- matches every other box-side/infra
// component's own POSTHOG_DISTINCT_ID convention (one logical "service"
// identity, not per-process/per-machine).
const POSTHOG_DISTINCT_ID: &str = "metagraphed-infra";

fn posthog_token() -> Option<String> {
    std::env::var("POSTHOG_PROJECT_TOKEN")
        .ok()
        .filter(|s| !s.trim().is_empty())
}

fn posthog_host() -> String {
    std::env::var("POSTHOG_HOST")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_POSTHOG_HOST.to_string())
}

/// Builds the same `$exception` event shape recordExceptionEvent
/// (src/usage-telemetry.ts) sends, so a captured error here reads
/// consistently with every other component's PostHog issues list.
/// `component` becomes both the `component` property and half of the
/// `$exception_fingerprint` (paired with the error's Display, the closest
/// Rust equivalent to a JS Error's `name`/type) -- grouping every
/// occurrence of "this component threw this shape of error" into one
/// PostHog issue, same convention as the TS side's route/mcp_tool pairing.
fn exception_body(
    token: &str,
    component: &str,
    err: &anyhow::Error,
    tags: &[(&str, String)],
) -> String {
    let value = format!("{err:#}");
    let mut properties = serde_json::Map::new();
    properties.insert(
        "$exception_list".to_string(),
        serde_json::json!([{
            "type": "Error",
            "value": value,
            "mechanism": {"handled": true, "synthetic": false},
        }]),
    );
    properties.insert(
        "$exception_fingerprint".to_string(),
        serde_json::json!(format!("{component}:Error")),
    );
    properties.insert("component".to_string(), serde_json::json!(component));
    for (key, val) in tags {
        properties.insert((*key).to_string(), serde_json::json!(val));
    }
    serde_json::json!({
        "api_key": token,
        "event": "$exception",
        "distinct_id": POSTHOG_DISTINCT_ID,
        "properties": properties,
    })
    .to_string()
}

async fn post_capture(body: String) {
    use tokio::io::AsyncWriteExt;
    let url = format!("{}{POSTHOG_CAPTURE_PATH}", posthog_host());
    let child = tokio::process::Command::new("curl")
        .args([
            "-fsS",
            "-m",
            "10",
            "-X",
            "POST",
            &url,
            "-H",
            "content-type: application/json",
            "-d",
            "@-",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            eprintln!("observability: spawn curl failed: {e}");
            return;
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(e) = stdin.write_all(body.as_bytes()).await {
            eprintln!("observability: write curl stdin failed: {e}");
            return;
        }
    }
    match child.wait_with_output().await {
        Ok(out) if !out.status.success() => {
            eprintln!(
                "observability: PostHog capture POST failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        Err(e) => eprintln!("observability: wait for curl failed: {e}"),
        _ => {}
    }
}

/// Fire-and-forget capture -- for a non-fatal fault the caller is already
/// retrying/recovering from on its own (a job tick failure, a stuck-block
/// tick). Spawned as a detached tokio task so a slow/hung PostHog endpoint
/// can never add latency to the actual indexing/polling work it's
/// reporting on. No-ops silently (no task spawned at all) if
/// POSTHOG_PROJECT_TOKEN is unset, matching every other capture site in
/// this program's "optional, no-op-when-unconfigured" convention.
pub fn capture_exception(component: &str, err: &anyhow::Error, tags: &[(&str, String)]) {
    let Some(token) = posthog_token() else {
        return;
    };
    let body = exception_body(&token, component, err, tags);
    tokio::spawn(post_capture(body));
}

/// Awaited capture -- for the fatal path only (a top-level `Err` about to
/// end the process). Unlike `capture_exception` above, this is NOT spawned
/// detached: the process exits right after the caller returns, so the
/// capture must actually complete (or fail trying) before that happens,
/// not just get queued and then killed mid-flight along with everything
/// else. Same no-op-when-unconfigured contract.
pub async fn capture_exception_immediate(component: &str, err: &anyhow::Error) {
    let Some(token) = posthog_token() else {
        return;
    };
    let body = exception_body(&token, component, err, &[]);
    post_capture(body).await;
}

/// Per-key aggregation window, matching the same "escalate periodically,
/// don't spam" shape used everywhere else a persistently-failing loop
/// could otherwise call capture_exception once per tick for as long as the
/// underlying condition lasts (scripts/chain-firehose-relay.ts's
/// computeDropWindowUpdate, deploy/wss-lb's computeNoUpstreamWindowUpdate,
/// metagraphed-infra's validator-ops observability.py windowed_capture_
/// exception -- see any of those for the full reasoning). `key` should
/// identify one logical failure stream (e.g. a job name) so one
/// persistently-broken job's spam never suppresses or delays reporting for
/// a different job's independent issue.
pub struct CaptureWindow {
    count: u32,
    started_at: std::time::Instant,
}

impl Default for CaptureWindow {
    fn default() -> Self {
        Self {
            count: 0,
            started_at: std::time::Instant::now(),
        }
    }
}

impl CaptureWindow {
    /// Registers one more occurrence; captures (and resets the window) once
    /// `threshold` occurrences or `interval` elapsed, whichever comes
    /// first. Returns true when it actually captured, purely so callers can
    /// log/test the decision without needing to inspect internal state.
    pub fn record(
        &mut self,
        component: &str,
        err: &anyhow::Error,
        threshold: u32,
        interval: std::time::Duration,
    ) -> bool {
        if self.count == 0 {
            self.started_at = std::time::Instant::now();
        }
        self.count += 1;
        let elapsed = self.started_at.elapsed();
        if self.count >= threshold || elapsed >= interval {
            let occurrences = self.count.to_string();
            let window_seconds = elapsed.as_secs().to_string();
            capture_exception(
                component,
                err,
                &[
                    ("occurrences", occurrences),
                    ("window_seconds", window_seconds),
                ],
            );
            self.count = 0;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exception_body_includes_the_anyhow_context_chain_and_component_fingerprint() {
        let err = anyhow::anyhow!("root cause")
            .context("mid layer")
            .context("top layer");
        let body = exception_body("phc_test", "subnet-ownership", &err, &[]);
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["api_key"], "phc_test");
        assert_eq!(parsed["event"], "$exception");
        assert_eq!(parsed["distinct_id"], POSTHOG_DISTINCT_ID);
        assert_eq!(
            parsed["properties"]["$exception_fingerprint"],
            "subnet-ownership:Error"
        );
        assert_eq!(parsed["properties"]["component"], "subnet-ownership");
        let value = parsed["properties"]["$exception_list"][0]["value"]
            .as_str()
            .unwrap();
        assert!(value.contains("top layer"));
        assert!(value.contains("mid layer"));
        assert!(value.contains("root cause"));
        assert_eq!(
            parsed["properties"]["$exception_list"][0]["mechanism"]["handled"],
            true
        );
    }

    #[test]
    fn exception_body_carries_extra_tags_as_flat_properties() {
        let err = anyhow::anyhow!("boom");
        let body = exception_body(
            "phc_test",
            "poller",
            &err,
            &[("job", "metagraph".to_string())],
        );
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["properties"]["job"], "metagraph");
    }

    #[test]
    fn capture_window_does_not_fire_before_the_threshold_or_interval() {
        let mut window = CaptureWindow::default();
        let err = anyhow::anyhow!("transient");
        for _ in 0..9 {
            assert!(!window.record("job", &err, 10, std::time::Duration::from_secs(300)));
        }
    }

    #[test]
    fn capture_window_fires_once_the_threshold_is_crossed_and_resets() {
        let mut window = CaptureWindow::default();
        let err = anyhow::anyhow!("transient");
        let mut fired = false;
        for _ in 0..10 {
            fired = window.record("job", &err, 10, std::time::Duration::from_secs(300));
        }
        assert!(fired);
        assert_eq!(window.count, 0);
    }

    #[test]
    fn capture_window_fires_on_interval_elapsed_even_below_the_count_threshold() {
        let mut window = CaptureWindow::default();
        let err = anyhow::anyhow!("transient");
        // Establishes the window for real (count 0 -> 1, started_at set) --
        // backdating started_at before any real occurrence would just get
        // overwritten by record()'s own "count == 0 means a fresh window"
        // reset, which is correct: an empty window has no meaningful start
        // time to backdate in the first place.
        assert!(!window.record("job", &err, 10, std::time::Duration::from_secs(300)));
        window.started_at = std::time::Instant::now() - std::time::Duration::from_secs(301);
        assert!(window.record("job", &err, 10, std::time::Duration::from_secs(300)));
    }
}
