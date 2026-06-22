# Realtime chain-event streamer (#1361, epic #1345) — Option B.
# A tiny always-on container. Subscribes to finalized finney heads, decodes the
# SubtensorModule events, and POSTs them to the Worker ingest endpoint (#1360).
# Cost on Railway is RAM-dominated (idle WebSocket between blocks → near-zero CPU);
# kept lean (~150 MB) so it fits a tight free-credit budget. See
# docs/realtime-streamer.md for the cost caps.
#
# Build (from the repo root):
#   docker build -f deploy/streamer.Dockerfile -t metagraphed-streamer .
FROM python:3.12-slim

# Run as a non-root user (least privilege).
RUN useradd --create-home --uid 10001 streamer
WORKDIR /app

# Single pinned dep (matches the CI poller) — never auto-pull a future release.
RUN pip install --no-cache-dir "substrate-interface==1.8.1"

# The streamer imports the verified decode from fetch-events.py — copy both.
COPY scripts/fetch-events.py scripts/stream-events.py /app/scripts/

ENV EVENTS_RPC_URL=wss://entrypoint-finney.opentensor.ai:443 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

USER streamer
# Provide at runtime (NOT baked in): EVENTS_INGEST_URL, METAGRAPH_EVENTS_INGEST_SECRET
CMD ["python", "scripts/stream-events.py"]
