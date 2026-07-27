// self-health (metagraphed#8317) -- metagraphed's own uptime, measured from
// outside its own edge.
//
// Every other health signal this project publishes is about SOMEONE ELSE:
// surface_checks probes subnet APIs, endpoint incidents cover public RPC
// endpoints. Nothing measured whether metagraphed itself was up, which meant
// /status could only ever answer "are the things we watch up" -- never "are
// WE up", the question a visitor on that page is actually asking.
//
// Probed from the indexer box rather than from a Worker deliberately: a
// Worker checking Cloudflare-hosted routes shares a failure domain with what
// it's checking, and would report green through exactly the outage a reader
// most wants to know about. The box is separate infrastructure on a separate
// network, so its view is an outside view.
//
// THREE COMPONENTS, two fetched and one derived:
//   api     -- GET /api/v1/health. Exercises the Worker plus its KV read path.
//   site    -- GET / on the UI origin. Exercises the UI Worker.
//   publish -- NOT a separate fetch. Derived from the api response's own
//              `meta.generated_at`: the data pipeline can be stale while
//              every HTTP surface answers 200, and that failure mode is
//              invisible to a status check that only reads status codes.
//
// HTTP client: curl subprocess, matching lib.rs's post_sync_json convention.
// Its doc comment establishes that "a single, rare, non-hot-path POST doesn't
// earn a new HTTP client dependency"; a GET every 60s is still nowhere near
// earning one. curl's `-w` gives status code and total time from the same
// invocation that fetches the body, so one process per check covers all three
// of ok/status/latency.
//
// FAILURE SEMANTICS: a failed check is DATA, not a job error. A 503 from the
// API writes an ok=false row and the tick succeeds -- that row IS the point.
// Job-level Err is reserved for "couldn't write Postgres at all", matching
// log_job_outcome's contract; anything looser would make the poller's own
// error rate spike during exactly the outage this job exists to record.

use std::time::Duration;

use anyhow::{Context, Result};
use backfill_rs::now_ms;

use crate::JobOutcome;

const API_HEALTH_URL: &str = "https://api.metagraph.sh/api/v1/health";
const SITE_URL: &str = "https://metagraph.sh/";

/// Hard per-check timeout. Well above a healthy response (tens of ms) and
/// well below the 60s tick, so a hung endpoint can't stall the loop.
const CHECK_TIMEOUT_SECS: &str = "10";

/// `meta.generated_at` older than this counts as a publish failure.
///
/// metagraphed#8352: this was 12h, sized against a 6h publish cadence that no
/// longer exists. The publish pipeline was redesigned to a DAILY floor (cron
/// `17 7 * * *` in `.github/workflows/publish-cloudflare.yml`) plus
/// event-triggered runs on registry-content pushes -- the volatile tiers
/// (surface health, economics) refresh independently on their own faster
/// cadences and were never gated on this publish at all. A 12h threshold
/// against a 24h floor meant this component read "down" for up to half of
/// every quiet day, which is exactly what happened: `/status` spent a full
/// day publicly reporting a pipeline outage that was the poller's own
/// miscalibration, not a real failure.
///
/// 26h: the 24h floor plus 2h slack for run duration and queue delay. Two
/// full daily runs missed in a row is the real signal this should catch, not
/// one daily cron finishing a few hours later than usual.
const PUBLISH_STALE_MS: i64 = 26 * 60 * 60 * 1000;

/// One component's result for one tick.
#[derive(Debug, PartialEq)]
pub struct CheckResult {
    pub component: &'static str,
    pub ok: bool,
    /// None when the request never completed (DNS, connect, timeout).
    pub http_status: Option<i32>,
    pub latency_ms: Option<i32>,
}

/// Parses curl's `-w '%{http_code} %{time_total}'` trailer.
///
/// The body is written to stdout first, so the trailer is the LAST line --
/// parsed from the end, not the start, because a JSON body may itself contain
/// newlines. Returns None when the trailer is absent or unparseable, which is
/// how a curl failure (non-zero exit, no output) surfaces.
pub fn parse_curl_trailer(stdout: &str) -> Option<(i32, i32)> {
    let trailer = stdout.rsplit('\n').find(|line| !line.trim().is_empty())?;
    let mut parts = trailer.split_whitespace();
    let code: i32 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        // A third field means this isn't our trailer -- most likely the body's
        // own last line. Better to record a missing latency than a wrong one.
        return None;
    }
    Some((code, (seconds * 1000.0).round() as i32))
}

/// Everything before the trailer line: the response body.
pub fn body_before_trailer(stdout: &str) -> &str {
    match stdout.rfind('\n') {
        Some(idx) => &stdout[..idx],
        None => "",
    }
}

/// A 2xx or 3xx is up. Everything else -- including a 404 on a route that is
/// supposed to exist -- is down.
pub fn status_is_ok(code: i32) -> bool {
    (200..400).contains(&code)
}

/// Days since the Unix epoch for a civil date (Howard Hinnant's days_from_civil).
/// Correct across leap years and centuries without pulling in a date crate --
/// same reasoning as lib.rs's curl-instead-of-an-HTTP-client note: one
/// timestamp parse doesn't earn a new dependency.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Parses the UTC ISO-8601 shape this project's own API emits, e.g.
/// `2026-07-26T16:27:10.973Z`. Fractional seconds optional; anything that
/// isn't UTC-with-Z returns None rather than being silently misread as UTC --
/// a wrong timestamp here would mean a wrong up/down verdict.
pub fn parse_utc_iso_ms(value: &str) -> Option<i64> {
    let value = value.strip_suffix('Z')?;
    let (date, time) = value.split_once('T')?;

    let mut date_parts = date.split('-');
    let y: i64 = date_parts.next()?.parse().ok()?;
    let mo: i64 = date_parts.next()?.parse().ok()?;
    let d: i64 = date_parts.next()?.parse().ok()?;
    if date_parts.next().is_some() || !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }

    let (hms, frac) = match time.split_once('.') {
        Some((hms, frac)) => (hms, frac),
        None => (time, ""),
    };
    let mut time_parts = hms.split(':');
    let h: i64 = time_parts.next()?.parse().ok()?;
    let mi: i64 = time_parts.next()?.parse().ok()?;
    let sec: i64 = time_parts.next()?.parse().ok()?;
    if time_parts.next().is_some() || h > 23 || mi > 59 || sec > 60 {
        return None;
    }

    // Pad or truncate the fraction to exactly milliseconds.
    let ms: i64 = if frac.is_empty() {
        0
    } else {
        let mut digits: String = frac.chars().take_while(char::is_ascii_digit).collect();
        if digits.is_empty() {
            return None;
        }
        while digits.len() < 3 {
            digits.push('0');
        }
        digits[..3].parse().ok()?
    };

    Some((days_from_civil(y, mo, d) * 86_400 + h * 3_600 + mi * 60 + sec) * 1_000 + ms)
}

/// Reads `meta.generated_at` out of the API health response and decides
/// whether the publish pipeline is fresh.
///
/// A body we can't parse is NOT a publish failure: that's an `api` failure,
/// already recorded by the api check, and double-counting it would make one
/// outage look like two. Returns None when there's nothing to judge.
pub fn publish_ok(body: &str, now: i64) -> Option<bool> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let generated_at = parsed.get("meta")?.get("generated_at")?.as_str()?;
    Some(now - parse_utc_iso_ms(generated_at)? <= PUBLISH_STALE_MS)
}

/// One curl GET. Never returns Err: a failed fetch is a CheckResult with
/// ok=false, which is the row this job exists to write.
async fn check(component: &'static str, url: &str) -> (CheckResult, String) {
    let output = tokio::process::Command::new("curl")
        .args([
            "-sS",
            // NOT -f: a 4xx/5xx must reach us as a status code to record, and
            // -f makes curl exit non-zero with no body instead.
            "-m",
            CHECK_TIMEOUT_SECS,
            "-o",
            "-",
            "-w",
            "\n%{http_code} %{time_total}",
            url,
        ])
        .output()
        .await;

    let stdout = match output {
        Ok(o) => String::from_utf8_lossy(&o.stdout).into_owned(),
        Err(e) => {
            eprintln!("self-health: {component} curl spawn failed: {e}");
            return (
                CheckResult {
                    component,
                    ok: false,
                    http_status: None,
                    latency_ms: None,
                },
                String::new(),
            );
        }
    };

    match parse_curl_trailer(&stdout) {
        Some((code, latency_ms)) => (
            CheckResult {
                component,
                ok: status_is_ok(code),
                http_status: Some(code),
                latency_ms: Some(latency_ms),
            },
            body_before_trailer(&stdout).to_string(),
        ),
        // Timeout / DNS / connection refused: curl wrote nothing parseable.
        None => (
            CheckResult {
                component,
                ok: false,
                http_status: None,
                latency_ms: None,
            },
            String::new(),
        ),
    }
}

/// Connects its own Postgres client (kept alive for the loop's lifetime,
/// separate from every other job's -- see main.rs's own doc comment for why)
/// and ticks `run` on `interval` forever.
pub async fn run_loop(db_url: String, interval: Duration) {
    let mut pg = backfill_rs::connect_pg_retrying("self-health", &db_url).await;
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let t0 = std::time::Instant::now();
        let result = run(&pg).await;
        if result.is_err() {
            // Same reconnect-on-any-failure reasoning as subnet_ownership's
            // run_loop: this loop holds one connection for its whole life, and
            // a Postgres restart otherwise makes every later tick fail forever.
            pg = backfill_rs::connect_pg_retrying("self-health", &db_url).await;
        }
        crate::log_job_outcome("self-health", &result, t0.elapsed(), interval);
    }
}

async fn run(pg: &tokio_postgres::Client) -> Result<JobOutcome> {
    let now = now_ms();

    // Sequential, not concurrent: three requests a minute is nothing, and
    // running them in order keeps the api body available for the publish
    // check without threading state through a join.
    let (api, api_body) = check("api", API_HEALTH_URL).await;
    let (site, _) = check("site", SITE_URL).await;

    let mut results = vec![api, site];
    if let Some(fresh) = publish_ok(&api_body, now) {
        results.push(CheckResult {
            component: "publish",
            ok: fresh,
            // Derived, not fetched: no HTTP status or latency of its own.
            http_status: None,
            latency_ms: None,
        });
    }

    let scanned = results.len() as u64;
    let mut written = 0u64;
    for r in &results {
        write_check(pg, r, now).await?;
        upsert_daily(pg, r, now).await?;
        written += 1;
    }

    // Failed checks are data, so they are NOT counted as job errors -- see
    // this module's doc comment. Reported here only so the poller's own logs
    // show at a glance that a tick recorded a problem.
    let failing = results.iter().filter(|r| !r.ok).count();
    if failing > 0 {
        eprintln!(
            "self-health: {failing}/{scanned} component(s) failing: {}",
            results
                .iter()
                .filter(|r| !r.ok)
                .map(|r| r.component)
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    Ok(JobOutcome {
        scanned,
        written,
        errors: 0,
    })
}

async fn write_check(pg: &tokio_postgres::Client, r: &CheckResult, now: i64) -> Result<()> {
    pg.execute(
        "INSERT INTO self_health_checks (checked_at_ms, component, ok, http_status, latency_ms)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (component, checked_at_ms) DO NOTHING",
        &[&now, &r.component, &r.ok, &r.http_status, &r.latency_ms],
    )
    .await
    .with_context(|| format!("insert self_health_checks component={}", r.component))?;
    Ok(())
}

/// Increment-style upsert into the 90-day serving rollup, same convention as
/// account_events_daily: the raw table is pruned by a retention policy, so the
/// daily counts have to be accumulated as they happen rather than recomputed
/// from raw rows that will be gone.
async fn upsert_daily(pg: &tokio_postgres::Client, r: &CheckResult, now: i64) -> Result<()> {
    let ok_increment: i32 = if r.ok { 1 } else { 0 };
    pg.execute(
        "INSERT INTO self_health_daily (day, component, checks, ok_count)
         VALUES ((to_timestamp($1::bigint / 1000.0) AT TIME ZONE 'UTC')::date, $2, 1, $3)
         ON CONFLICT (day, component) DO UPDATE SET
           checks = self_health_daily.checks + 1,
           ok_count = self_health_daily.ok_count + EXCLUDED.ok_count",
        &[&now, &r.component, &ok_increment],
    )
    .await
    .with_context(|| format!("upsert self_health_daily component={}", r.component))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_curl_status_and_latency_from_the_trailing_line() {
        let stdout = "{\"ok\":true}\n200 0.198";
        assert_eq!(parse_curl_trailer(stdout), Some((200, 198)));
    }

    #[test]
    fn parses_a_trailer_after_a_body_containing_newlines() {
        // A pretty-printed JSON body is the normal case, not an edge case --
        // parsing from the front would read the body's first line as a status.
        let stdout = "{\n  \"ok\": true,\n  \"meta\": {}\n}\n503 1.5";
        assert_eq!(parse_curl_trailer(stdout), Some((503, 1500)));
    }

    #[test]
    fn returns_none_when_curl_produced_no_trailer() {
        // Timeout / DNS failure / connection refused.
        assert_eq!(parse_curl_trailer(""), None);
        assert_eq!(parse_curl_trailer("curl: (28) Operation timed out"), None);
    }

    #[test]
    fn refuses_a_line_with_extra_fields_rather_than_guessing() {
        // A body whose last line happens to start with two numbers must not be
        // mistaken for the trailer.
        assert_eq!(parse_curl_trailer("200 0.5 extra"), None);
    }

    #[test]
    fn splits_the_body_off_the_trailer() {
        assert_eq!(
            body_before_trailer("{\"ok\":true}\n200 0.1"),
            "{\"ok\":true}"
        );
        assert_eq!(body_before_trailer("no trailer"), "");
    }

    #[test]
    fn treats_2xx_and_3xx_as_up_and_everything_else_as_down() {
        assert!(status_is_ok(200));
        assert!(status_is_ok(301));
        assert!(!status_is_ok(404));
        assert!(!status_is_ok(503));
        assert!(!status_is_ok(0));
    }

    #[test]
    fn parses_the_utc_iso_shape_our_own_api_emits() {
        // Cross-checked against `date -u -d ... +%s`.
        assert_eq!(parse_utc_iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            parse_utc_iso_ms("2026-07-26T16:27:10.973Z"),
            Some(1_785_083_230_973)
        );
        // Fractional seconds are optional, and a shorter fraction pads.
        assert_eq!(
            parse_utc_iso_ms("2026-07-26T16:27:10Z"),
            Some(1_785_083_230_000)
        );
        assert_eq!(
            parse_utc_iso_ms("2026-07-26T16:27:10.5Z"),
            Some(1_785_083_230_500)
        );
        // A longer one truncates rather than overflowing into seconds.
        assert_eq!(
            parse_utc_iso_ms("2026-07-26T16:27:10.973999Z"),
            Some(1_785_083_230_973)
        );
    }

    #[test]
    fn handles_leap_days_and_century_boundaries() {
        // 2000 is a leap year, 1900 is not -- the case a naive /4 rule breaks.
        assert_eq!(
            parse_utc_iso_ms("2000-02-29T00:00:00.000Z"),
            Some(951_782_400_000)
        );
        assert_eq!(
            parse_utc_iso_ms("2024-02-29T00:00:00.000Z"),
            Some(1_709_164_800_000)
        );
    }

    #[test]
    fn refuses_a_non_utc_or_malformed_timestamp_instead_of_misreading_it() {
        // Silently treating an offset timestamp as UTC would shift the verdict
        // by hours, which for a 26h staleness threshold can flip it.
        assert_eq!(parse_utc_iso_ms("2026-07-26T16:27:10+02:00"), None);
        assert_eq!(parse_utc_iso_ms("2026-07-26 16:27:10Z"), None);
        assert_eq!(parse_utc_iso_ms("2026-13-01T00:00:00Z"), None);
        assert_eq!(parse_utc_iso_ms("2026-07-26T25:00:00Z"), None);
        assert_eq!(parse_utc_iso_ms(""), None);
    }

    #[test]
    fn derives_publish_freshness_from_meta_generated_at() {
        let now = parse_utc_iso_ms("2026-07-26T16:27:10.973Z").unwrap();
        let fresh = "{\"meta\":{\"generated_at\":\"2026-07-26T15:27:10.973Z\"}}";
        assert_eq!(publish_ok(fresh, now), Some(true));

        // 26h is the threshold: 25h ago is still fresh, 27h ago is stale.
        // metagraphed#8352 -- was 12h/13h against a publish pipeline that
        // moved to a daily floor; see PUBLISH_STALE_MS's own doc comment.
        let still_fresh = "{\"meta\":{\"generated_at\":\"2026-07-25T15:27:10.973Z\"}}";
        assert_eq!(publish_ok(still_fresh, now), Some(true));

        let stale = "{\"meta\":{\"generated_at\":\"2026-07-25T13:27:10.973Z\"}}";
        assert_eq!(publish_ok(stale, now), Some(false));
    }

    #[test]
    fn reports_no_publish_verdict_when_the_body_is_unusable() {
        // An unreachable or malformed API is an `api` failure, already
        // recorded by that check. Counting it again as a publish failure would
        // make one outage look like two.
        assert_eq!(publish_ok("", 0), None);
        assert_eq!(publish_ok("not json", 0), None);
        assert_eq!(publish_ok("{\"meta\":{}}", 0), None);
        assert_eq!(
            publish_ok("{\"meta\":{\"generated_at\":\"nope\"}}", 0),
            None
        );
    }
}
