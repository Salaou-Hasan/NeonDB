# NeonDB Deployment Guide

This document explains how to deploy NeonDB locally or in a containerized environment.

## Environment Variables

### Core Configuration

- `NEONDB_HOST`: WebSocket listen address (`127.0.0.1` by default)
- `NEONDB_PORT`: WebSocket listen port (`3000` by default)
- `NEONDB_METRICS_PORT`: HTTP metrics port (`3001` by default)
- `NEONDB_WAL_PATH`: Path to the Write-Ahead Log file
- `NEONDB_FSYNC_INTERVAL_MS`: WAL fsync interval in milliseconds

### Performance Optimization

- `NEONDB_WAL_BATCH_SIZE`: Number of WAL entries to batch before flushing (`100000` by default)
- `NEONDB_WAL_BATCH_INTERVAL_MS`: Maximum time to wait before flushing WAL batch (`100` by default)
- `NEONDB_UNSAFE_NO_FSYNC`: Disable fsync for maximum throughput (⚠️ data loss risk on crash) (`false` by default)

### Sharding Configuration

- `NEONDB_SHARD_ID`: Shard ID for distributed deployments (`0` by default)
- `NEONDB_SHARD_COUNT`: Total number of shards in cluster (`1` by default)

### Server Configuration

- `NEONDB_MAX_CONNECTIONS`: Maximum active WebSocket clients (`100` by default)
- `NEONDB_REDUCER_TIMEOUT_MS`: Reducer execution timeout in milliseconds (`5000` by default)
- `NEONDB_API_KEY`: Optional API key required by WebSocket clients
- `RUST_LOG`: Logging level (`info` by default)

### Snapshot Configuration

- `NEONDB_SNAPSHOT_INTERVAL`: Transactions between automatic snapshots (`1000000` by default). Set to `0` to disable.
- `NEONDB_SNAPSHOT_DIR`: Directory for snapshot files (`/tmp/neondb_snapshots` by default — override in production)

## Local deployment

Build and run the server locally:

```bash
cargo build --release
NEONDB_PORT=3000 NEONDB_WAL_PATH=/tmp/neondb.wal NEONDB_METRICS_PORT=3001 cargo run --release -- start
```

### Example with optimization enabled

```bash
NEONDB_WAL_BATCH_SIZE=100000 \
NEONDB_WAL_BATCH_INTERVAL_MS=100 \
NEONDB_PORT=3000 \
NEONDB_METRICS_PORT=3001 \
cargo run --release -- start
```

### Example with API key

```bash
NEONDB_API_KEY=secretkey NEONDB_PORT=3000 NEONDB_METRICS_PORT=3001 cargo run --release -- start
```

## Docker deployment

Build the Docker image:

```bash
docker build -t neondb:latest .
```

Run NeonDB in Docker:

```bash
docker run -d \
  -p 8000:8000 \
  -p 8001:8001 \
  -e NEONDB_HOST=0.0.0.0 \
  -e NEONDB_PORT=8000 \
  -e NEONDB_METRICS_PORT=8001 \
  -e NEONDB_WAL_BATCH_SIZE=100000 \
  -e NEONDB_WAL_BATCH_INTERVAL_MS=100 \
  -v neondb-data:/data/wal \
  neondb:latest
```

### Docker Compose

Start multi-container stack:

```bash
docker-compose up -d
```

View logs:

```bash
docker-compose logs -f neondb
```

Stop:

```bash
docker-compose down
```

## Dokploy Deployment

### Prerequisites

- Dokploy instance running and accessible (install: `curl -sSL https://dokploy.com/install.sh | sh`)
- VPS with Docker (configured automatically by Dokploy installer)
- Optional: domain pointed at your VPS for TLS

### Deployment Steps

1. **Create a project** in Dokploy dashboard → **Projects** → **Create Project**

2. **Add service** → **Application** → connect your Git repo → Build Type: `Dockerfile`

3. **Configure environment variables** (see list below) in the service **Environment** tab

4. **Add volume mounts** in the **Mounts** tab:
   - `neondb-wal` → `/data/wal`
   - `neondb-snapshots` → `/data/snapshots`

5. **Configure domain / TLS** in the **Domains** tab (optional — auto TLS via Traefik)

6. **Deploy** — monitor in the **Deployments** tab

See `DOKPLOY_DEPLOYMENT.md` for the full step-by-step guide and Docker Compose option.

### Health Check Endpoint

The container includes a health check that probes the WebSocket port. You can also monitor via metrics:

```bash
curl http://your-neondb-host:8001/metrics
```

## Performance Tuning

### For High Throughput

```bash
NEONDB_WAL_BATCH_SIZE=500000 \
NEONDB_WAL_BATCH_INTERVAL_MS=50 \
NEONDB_UNSAFE_NO_FSYNC=true  # ⚠️ Only if data loss on crash is acceptable
```

### For High Reliability

```bash
NEONDB_WAL_BATCH_SIZE=10000 \
NEONDB_WAL_BATCH_INTERVAL_MS=10 \
NEONDB_UNSAFE_NO_FSYNC=false
```

### For Distributed Sharding

```bash
# Node 1
NEONDB_SHARD_ID=0 NEONDB_SHARD_COUNT=3

# Node 2
NEONDB_SHARD_ID=1 NEONDB_SHARD_COUNT=3

# Node 3
NEONDB_SHARD_ID=2 NEONDB_SHARD_COUNT=3
```

## Monitoring

View server metrics and health:

```bash
# WebSocket status
curl -w "\nStatus: %{http_code}\n" http://localhost:8001/metrics

# Check container health
docker ps --format "table {{.Names}}\t{{.Status}}" | grep neondb
```

## Troubleshooting

### Server won't start

Check logs:
```bash
docker-compose logs neondb
```

### High memory usage

Reduce batch sizes or enable compression:
```bash
NEONDB_WAL_BATCH_SIZE=50000
```

### WAL corruption

Move WAL file and restart:
```bash
docker-compose exec neondb rm /data/wal/neondb.wal
docker-compose restart neondb
```
  -e NEONDB_WAL_PATH=/data/neondb.wal \
  -e NEONDB_MAX_CONNECTIONS=200 \
  -e NEONDB_API_KEY=secretkey \
  -v $(pwd)/data:/data \
  --name neondb neondb:latest
```

## Docker Compose

If you want compose support, use the existing `docker-compose.yml` and pass env vars through the shell or a `.env` file.

## Metrics and health

- Metrics endpoint: `http://<host>:<metrics_port>/metrics`
- Health endpoint: `http://<host>:<metrics_port>/healthz`

## Notes

- The WAL path must be writable by the server process.
- For production, run with `cargo build --release` and `RUST_LOG=info`.
- Keep `NEONDB_MAX_CONNECTIONS` set to a safe limit for your deployment.
