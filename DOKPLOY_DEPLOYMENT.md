# NeonDB Dokploy Deployment Guide

## Overview

[Dokploy](https://dokploy.com) is a **free, open-source** self-hosted PaaS that runs on any
Linux machine you already own — a spare PC, a home server, or any hardware you control.
It uses **Traefik** for reverse-proxy / TLS termination and a simple web dashboard for
configuration.  There are **zero cloud fees** because everything runs on your own hardware.

NeonDB is also **built from source** via Dokploy's Git integration — no registry account,
no image hosting fees, no paid services of any kind.

This guide covers deploying NeonDB on your self-hosted Dokploy instance.

> **Cost**: $0.  Dokploy is MIT-licensed.  NeonDB is built from your own source repo.
> The only cost is your own electricity and hardware.

---

## Prerequisites

| Item | Requirement |
|---|---|
| Machine | Any Linux x86_64 — spare PC, home server, mini PC, etc. |
| RAM | ≥ 1 GB (2 GB recommended for comfortable operation) |
| Docker | Installed automatically by the Dokploy installer |
| Domain (optional) | For TLS — point an A record at your machine's public IP |

> **No cloud account required.** Dokploy and NeonDB both run entirely on hardware you own.

### Install Dokploy on your machine

```bash
# Run once on your Linux machine (installs Docker + Dokploy automatically)
curl -sSL https://dokploy.com/install.sh | sh
```

Access the dashboard at `http://<your-machine-ip>:3000` and create your admin account.

---

## Option A — Deploy from Git Repository (Recommended)

Dokploy can build and deploy directly from your Git repository whenever you push.

### Step 1 — Create a project and service

1. In the Dokploy dashboard → **Projects** → **Create Project** → name it `neondb`
2. Inside the project → **Add Service** → **Application**
3. Connect your Git provider (GitHub / GitLab / Gitea) and select the NeonDB repository
4. Set **Build Type** to `Dockerfile`
5. Dokploy will auto-detect the `Dockerfile` at the repository root

### Step 2 — Configure environment variables

In the service settings → **Environment** tab, add:

```env
NEONDB_HOST=0.0.0.0
NEONDB_PORT=8000
NEONDB_METRICS_PORT=8001
NEONDB_WAL_PATH=/data/wal/neondb.wal
NEONDB_WAL_BATCH_SIZE=100000
NEONDB_WAL_BATCH_INTERVAL_MS=100
NEONDB_UNSAFE_NO_FSYNC=false
NEONDB_MAX_CONNECTIONS=200
NEONDB_REDUCER_TIMEOUT_MS=5000
NEONDB_SNAPSHOT_INTERVAL=1000000
NEONDB_SNAPSHOT_DIR=/data/snapshots
RUST_LOG=info
```

Set these only if you need them:
```env
NEONDB_API_KEY=your-secure-api-key-here
NEONDB_SHARD_ID=0
NEONDB_SHARD_COUNT=1
```

### Step 3 — Configure persistent storage

In the service settings → **Mounts** tab, add two volume mounts:

| Volume Name | Mount Path | Purpose |
|---|---|---|
| `neondb-wal` | `/data/wal` | WAL files — survives container restarts |
| `neondb-snapshots` | `/data/snapshots` | Snapshot files — bounds WAL replay time |

### Step 4 — Configure domain and TLS (optional)

In the service settings → **Domains** tab:

1. Add your domain, e.g. `db.yourgame.com`
2. Enable **HTTPS** (Dokploy provisions a Let's Encrypt cert automatically via Traefik)
3. Set **Port** to `8000`

> **WebSocket support** is enabled automatically by Traefik — no extra configuration needed.

### Step 5 — Deploy

Click **Deploy**. Dokploy builds the Docker image, pushes it, and starts the container.
Monitor the build log in **Deployments** tab.

---

## Option B — Deploy via Docker Compose

If you prefer to manage configuration as code, use the `docker-compose.yml` at the repository
root. In Dokploy:

1. **Add Service** → **Docker Compose**
2. Paste the contents of `docker-compose.yml`
3. Add the `dokploy-network` to the service (see `docker-compose.yml` labels section)
4. Set environment variables in the **Environment** tab or via a `.env` file

The compose file already includes Traefik labels for routing via Dokploy.

---

## Port Reference

| Port | Protocol | Purpose | Expose? |
|---|---|---|---|
| `8000` | WebSocket (HTTP upgrade) | Client connections | ✅ Yes — via Traefik |
| `8001` | HTTP | Metrics endpoint | ❌ No — keep internal |

---

## New Environment Variables (post-Session 13)

These variables were added as features were implemented and are not in older deployment guides:

| Variable | Default | Description |
|---|---|---|
| `NEONDB_API_KEY` | _(unset)_ | If set, clients must send `Authorization: Bearer <key>` |
| `NEONDB_SNAPSHOT_INTERVAL` | `1000000` | Transactions between automatic snapshots |
| `NEONDB_SNAPSHOT_DIR` | `/tmp/neondb_snapshots` | Snapshot storage directory |

---

## Health Check

The container exposes a TCP health check on port 8000 (WebSocket port). Dokploy monitors this
automatically. You can also query the metrics endpoint:

```bash
curl http://<vps-ip>:8001/metrics
```

---

## Performance Tuning

### Maximum throughput (⚠️ data loss risk on crash)
```env
NEONDB_WAL_BATCH_SIZE=500000
NEONDB_WAL_BATCH_INTERVAL_MS=50
NEONDB_UNSAFE_NO_FSYNC=true
```

### Maximum reliability
```env
NEONDB_WAL_BATCH_SIZE=10000
NEONDB_WAL_BATCH_INTERVAL_MS=10
NEONDB_UNSAFE_NO_FSYNC=false
```

### Balanced (default — recommended for most deployments)
```env
NEONDB_WAL_BATCH_SIZE=100000
NEONDB_WAL_BATCH_INTERVAL_MS=100
NEONDB_UNSAFE_NO_FSYNC=false
```

---

## Sharded Deployment (Multi-Node)

Deploy multiple NeonDB services with different shard IDs and route via a load balancer:

```
          Clients
             |
      Traefik (Dokploy)
      /      |      \
  Shard0  Shard1  Shard2
```

Set per-service environment:

| Node | `NEONDB_SHARD_ID` | `NEONDB_SHARD_COUNT` |
|---|---|---|
| Node 1 | `0` | `3` |
| Node 2 | `1` | `3` |
| Node 3 | `2` | `3` |

---

## Monitoring

```bash
# Metrics (Prometheus format)
curl http://<vps-ip>:8001/metrics

# Logs via Dokploy dashboard
# Projects → neondb → Logs tab

# Container health
docker ps --filter name=neondb
```

Watch for these log lines:
- `Recovered N entries from WAL` — normal on startup
- `Snapshot saved: N rows` — snapshot written successfully
- `Scheduler: 'X' every Yms` — scheduled reducers registered
- `ERROR` prefix — investigate immediately

---

## Troubleshooting

### Container won't start
```bash
# Check logs in Dokploy dashboard: Projects → neondb → Logs
# Or on the VPS directly:
docker logs $(docker ps -q --filter name=neondb)
```
Common causes:
- Volume mount permissions (`chmod 755 /data/wal /data/snapshots`)
- Port 8000 already in use on the host

### High memory usage
- Reduce `NEONDB_WAL_BATCH_SIZE` to `50000`
- Check active subscription count via `/metrics`

### WAL corruption
```bash
# Backup and reset WAL
docker exec <container> cp /data/wal/neondb.wal /data/wal/neondb.wal.bak
docker exec <container> rm /data/wal/neondb.wal
docker restart <container>
```

### Lost data after crash
- If `NEONDB_UNSAFE_NO_FSYNC=true`: expected behavior — switch to `false`
- If `NEONDB_UNSAFE_NO_FSYNC=false`: check volume persistence in Dokploy

---

## Security

### API Key
```env
NEONDB_API_KEY=your-long-random-secret-here
```
Clients must then connect with:
```
Authorization: Bearer your-long-random-secret-here
```

### Network
- Port `8000` is exposed via Traefik (with TLS if domain configured)
- Port `8001` (metrics) should **not** be exposed publicly — keep it internal
- Use Dokploy's built-in Traefik TLS for encrypted WebSocket (`wss://`)

### Backup
```bash
# Snapshot WAL (run on VPS)
docker exec <container> cp /data/wal/neondb.wal /backup/neondb_$(date +%s).wal

# Or mount a backup volume and copy periodically
```

---

## Quick Reference

| Task | How |
|---|---|
| View logs | Dokploy dashboard → Projects → neondb → Logs |
| Redeploy | Dokploy dashboard → Projects → neondb → Deploy |
| Update env var | Dokploy dashboard → Service → Environment → Save & Redeploy |
| Scale vertically | Dokploy dashboard → Service → Resources |
| Check health | `curl http://<vps>:8001/metrics` |
| Restart container | `docker restart $(docker ps -q --filter name=neondb)` |

---

**Ready for production deployment to Dokploy.**
