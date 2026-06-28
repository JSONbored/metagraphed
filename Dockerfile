# Rust genesis backfill — runs on Railway (and later the archive box unchanged).
# subxt uses rustls (no system openssl); tokio-postgres talks plaintext to the
# private Railway Postgres (postgres.railway.internal). Config is all via env.
FROM rust:1-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/target/release/backfill-rs /app/backfill-rs
COPY entrypoint.sh /app/entrypoint.sh
# entrypoint shards [FROM,TO) into BACKFILL_SHARDS independent conc=1 processes
# (sidesteps subxt's intra-client concurrency deadlock). Runtime env on the service:
# DATABASE_URL, EVENTS_RPC_URL, BACKFILL_FROM, BACKFILL_TO, BACKFILL_SHARDS, BACKFILL_CHUNK.
CMD ["bash", "/app/entrypoint.sh"]
