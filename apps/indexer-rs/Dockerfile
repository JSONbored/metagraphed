# Rust genesis backfill — runs on Railway (and later the archive box unchanged).
# subxt uses rustls (no system openssl); tokio-postgres talks plaintext to the
# private Railway Postgres (postgres.railway.internal). Config is all via env.
FROM rust:1-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
# curl: run_live's stuck-block alert (metagraphed-indexer-rs#4) shells out to
# it via tokio::process::Command rather than adding an HTTP client crate --
# without it here, alert_stuck_block would silently fail at runtime (a
# missing binary is a caught, logged error, not a crash, but the whole
# point of that fix is the alert actually firing).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/target/release/backfill-rs /app/backfill-rs
# poller (metagraphed-infra#136/#137): the consolidated chain-state polling
# service, a separate process/binary from backfill-rs above -- `cargo build
# --release` with no `--bin` filter already builds both targets, this just
# ships the second one too. Selected via docker_container's `command:` in
# roles/indexer-rust, not this image's own CMD (which stays backfill-rs's
# entrypoint.sh, unchanged).
COPY --from=build /app/target/release/poller /app/poller
COPY entrypoint.sh /app/entrypoint.sh
# entrypoint shards [FROM,TO) into BACKFILL_SHARDS independent conc=1 processes
# (sidesteps subxt's intra-client concurrency deadlock). Runtime env on the service:
# DATABASE_URL, EVENTS_RPC_URL, BACKFILL_FROM, BACKFILL_TO, BACKFILL_SHARDS, BACKFILL_CHUNK.
CMD ["bash", "/app/entrypoint.sh"]
