// PollerContainer (#9146) -- the chain-state poller running on Cloudflare
// Containers, replacing the systemd unit on the decommissioned indexer box.
//
// WHAT IT RUNS. deploy/poller.Dockerfile pins POLLER_ONLY to `metagraph` --
// the one remaining lane that both holds no Postgres client AND still has
// readers (METAGRAPH_NEURONS_SOURCE is "d1", served through DATA_API's D1 twin
// from #9160/#9165). It POSTs to the existing neurons-sync route, which #9157
// moved onto D1, so the whole lane is Cloudflare-side with no producer
// rewrite. See the Dockerfile for why the other two Postgres-free jobs are
// deliberately not run here.
//
// A SINGLETON, AND IT MUST STAY ONE. idFromName("global"), and
// max_instances: 1 in wrangler.jsonc. Two concurrent instances would each run
// the same interval loops against the same sync routes, and the neurons
// route's per-netuid prune keys on captured_at -- an older instance's snapshot
// landing after a newer one's would delete UIDs the newer one just wrote. The
// jobs are idempotent, but only against themselves, not against a second
// scheduler.
//
// LIFECYCLE. The poller is a forever-loop with its own tokio intervals
// (METAGRAPH_POLL_SECS defaults to 900), so this container is meant to be
// always-on rather than request-driven. Containers sleep when idle, so
// sleepAfter is long and the Worker's cron pings ensureRunning() to reset the
// idle timer. A ping is cheap and idempotent: if the instance is already up it
// is a no-op, and if it died it is restarted on the next tick rather than
// staying dead until someone notices.

import { Container } from "@cloudflare/containers";

export class PollerContainer extends Container<Env> {
  // Long enough that a missed cron tick cannot reap a healthy poller. The
  // ping rides RAW_CAPTURE_CRON ("*/5 * * * *", workers/config.ts), so an hour
  // tolerates eleven consecutive misses before the instance is allowed to
  // sleep.
  sleepAfter = "1h";

  // Secrets are read by the Rust binary from its own env, so they are passed
  // through here rather than baked into the image. Left undefined when unset
  // so a partially-provisioned deployment fails loudly in the job that needs
  // the missing one, rather than silently POSTing with an empty token.
  envVars = {
    NEURONS_SYNC_SECRET: this.env.NEURONS_SYNC_SECRET ?? "",
  };

  override onStart(): void {
    console.log("[poller-container] started");
  }

  override onStop(): void {
    // Not an error on its own -- an idle sleep looks the same as a crash from
    // here. The cron ping restarts it either way; this exists so the tail
    // shows the restart rather than a silent gap.
    console.log("[poller-container] stopped, will restart on the next ping");
  }

  override onError(error: unknown): void {
    console.error("[poller-container]", String((error as Error)?.message));
  }
}
