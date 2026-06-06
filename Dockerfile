# Multi-stage build for NeonDB Server
# Compatible with Dokploy (builds from source on the VPS via git-connected service)

# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM rust:1.78-slim as builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends pkg-config libssl-dev && \
    rm -rf /var/lib/apt/lists/*

# Copy source files needed for build
COPY Cargo.toml ./
COPY src src/
COPY benches benches/
COPY tests tests/
COPY modules modules/

# Build release binary
RUN cargo build --release

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM debian:bookworm-slim

# Install minimal runtime dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        libssl3 \
        netcat-openbsd && \
    rm -rf /var/lib/apt/lists/*

# Copy binary from builder
COPY --from=builder /app/target/release/neondb /usr/local/bin/neondb

# Copy reducer modules (JS + WASM reducers loaded at runtime)
COPY --from=builder /app/modules /modules

# Create data directories
RUN mkdir -p /data/wal /data/snapshots

# ── Environment defaults ──────────────────────────────────────────────────────
# All values can be overridden via Dokploy environment variable settings.
ENV NEONDB_HOST=0.0.0.0
ENV NEONDB_PORT=8000
ENV NEONDB_METRICS_PORT=8001
ENV NEONDB_WAL_PATH=/data/wal/neondb.wal
ENV NEONDB_FSYNC_INTERVAL_MS=0
ENV NEONDB_WAL_BATCH_SIZE=100000
ENV NEONDB_WAL_BATCH_INTERVAL_MS=100
ENV NEONDB_UNSAFE_NO_FSYNC=false
ENV NEONDB_SHARD_ID=0
ENV NEONDB_SHARD_COUNT=1
ENV NEONDB_MAX_CONNECTIONS=200
ENV NEONDB_REDUCER_TIMEOUT_MS=5000
ENV NEONDB_SNAPSHOT_INTERVAL=1000000
ENV NEONDB_SNAPSHOT_DIR=/data/snapshots
ENV RUST_LOG=info

# Expose ports (actual binding via Dokploy/Traefik configuration)
EXPOSE 8000 8001

# Health check — probes the WebSocket port
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD nc -z localhost 8000 || exit 1

# Working directory for module loading (ReducerRegistry scans ./modules/)
WORKDIR /

ENTRYPOINT ["neondb", "start"]
