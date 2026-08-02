// The chain-state poller as a Cloudflare Container (#209): the replacement
// for the box's indexer-rs-poller docker container, which died with the box.
//
// The container runs apps/indexer-rs's `poller` binary in its Postgres-free
// shape (POLLER_ONLY=metagraph,subnet-hyperparams,account-identity — baked
// into Dockerfile.poller). Those three lanes read the chain over public RPC
// and POST to the api worker's token-authed sync routes, which persist to D1
// (#9157 and siblings). Nothing here touches a database directly: this
// Worker's whole job is keeping exactly one instance of that binary alive.
//
// LIVENESS BY CRON, NOT BY REQUEST. The poller serves no HTTP and nobody
// fetches it, so the usual keep-alive-by-traffic model does not apply. A
// 5-minute cron pings the singleton: if the container stopped (eviction,
// crash, deploy), the ping starts it again, and the poller's own 15-minute
// metagraph cadence means a worst-case restart costs one missed tick.

import { Container, getContainer } from "@cloudflare/containers";

/** This worker's own env: the poller secrets + tuning, unrelated to the main
 * api worker's generated Env type. */
interface PollerEnv {
  EVENTS_RPC_URL?: string;
  METAGRAPH_POLL_SECS?: string;
  NEURONS_SYNC_SECRET?: string;
  ACCOUNT_IDENTITY_SYNC_SECRET?: string;
  SUBNET_HYPERPARAMS_SYNC_SECRET?: string;
  POSTHOG_PROJECT_TOKEN?: string;
  POSTHOG_HOST?: string;
}

export class PollerContainer extends Container<PollerEnv> {
  // The poller exposes no port; sleepAfter is the eviction timer the cron
  // ping races. Longer than the ping interval, so a healthy loop never
  // sleeps.
  override sleepAfter = "20m";

  constructor(...args: ConstructorParameters<typeof Container<PollerEnv>>) {
    super(...args);
    const env = args[1];
    // The binary reads plain process env; secrets arrive through this
    // worker's own secret bindings. The sync URLs are the binary's own
    // defaults (api.metagraph.sh), deliberately not repeated here.
    this.envVars = {
      EVENTS_RPC_URL:
        env.EVENTS_RPC_URL || "wss://archive.chain.opentensor.ai:443",
      // 15-minute metagraph tick, matching the retired box timer; the other
      // two lanes default sanely in the binary (1h hyperparams, 24h identity).
      METAGRAPH_POLL_SECS: env.METAGRAPH_POLL_SECS || "900",
      // Sync routes + secrets: the same three the box container held.
      NEURONS_SYNC_SECRET: env.NEURONS_SYNC_SECRET || "",
      ACCOUNT_IDENTITY_SYNC_SECRET: env.ACCOUNT_IDENTITY_SYNC_SECRET || "",
      SUBNET_HYPERPARAMS_SYNC_SECRET: env.SUBNET_HYPERPARAMS_SYNC_SECRET || "",
      POSTHOG_PROJECT_TOKEN: env.POSTHOG_PROJECT_TOKEN || "",
      POSTHOG_HOST: env.POSTHOG_HOST || "",
    };
  }

  override onStart() {
    console.log("poller container started");
  }

  override onStop() {
    // Expected on deploys and platform maintenance; the cron restarts it.
    console.log("poller container stopped");
  }

  override onError(error: unknown) {
    console.error("poller container error:", error);
  }
}

interface PollerWorkerEnv extends PollerEnv {
  POLLER: DurableObjectNamespace<PollerContainer>;
}

/** getContainer's constraint is written against the library's DEFAULT env
 * generic (Cloudflare.Env), which this worker deliberately does not use --
 * the stub is still exactly a PollerContainer namespace. One cast at the
 * boundary beats widening PollerEnv to the whole generated Env. */
function pollerSingleton(env: PollerWorkerEnv) {
  return getContainer(
    env.POLLER as unknown as Parameters<typeof getContainer>[0],
  );
}

export default {
  // No public surface: a probe of the Worker reports whether the singleton is
  // up, and everything else is the cron's business.
  async fetch(_request: Request, env: PollerWorkerEnv): Promise<Response> {
    await pollerSingleton(env).start();
    return new Response("poller: running\n", { status: 200 });
  },

  async scheduled(
    _controller: ScheduledController,
    env: PollerWorkerEnv,
  ): Promise<void> {
    // Idempotent: starting a running container is a no-op, so this is purely
    // "revive if dead".
    await pollerSingleton(env).start();
  },
};
