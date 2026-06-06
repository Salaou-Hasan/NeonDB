# NeonDB → Local Dokploy Deployment Guide

## Your Setup
- **Hardware**: Windows 11 (self-hosted)
- **Dokploy Location**: VPS (or WSL2 Ubuntu / Linux VM)
- **NeonDB Container**: Built and managed by Dokploy
- **Network**: Domain or IP access

---

## Installing Dokploy on Your Server

Run this on any Linux server (Ubuntu / Debian / Rocky Linux):

```bash
curl -sSL https://dokploy.com/install.sh | sh
```

The installer configures Docker, Traefik, and the Dokploy web dashboard.
Access the dashboard at: `http://<server-ip>:3000`

---

## Adding NeonDB to Dokploy

### Step 1: Create a project
1. Dokploy dashboard → **Projects** → **Create Project**
2. Name it `neondb`

### Step 2: Add the application service
1. Inside the project → **Add Service** → **Application**
2. Choose **GitHub / GitLab / Gitea** and connect your NeonDB repository
3. Set **Build Type** to `Dockerfile`

### Step 3: Configure environment variables
In the service → **Environment** tab, add:

```
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

Optional (for production security):
```
NEONDB_API_KEY=your-long-random-secret
```

### Step 4: Configure persistent mounts
In the service → **Mounts** tab, add:

| Volume Name | Mount Path |
|---|---|
| `neondb-wal` | `/data/wal` |
| `neondb-snapshots` | `/data/snapshots` |

### Step 5: Configure domain (optional, for TLS)
In the service → **Domains** tab:
1. Add your domain (e.g. `db.yourgame.com`)
2. Enable HTTPS — Dokploy provisions Let's Encrypt TLS via Traefik
3. Set **Port** to `8000`

### Step 6: Deploy
Click **Deploy**. Monitor the build in the **Deployments** tab.

---

## Verify Deployment

```bash
# Check metrics endpoint
curl http://<server>:8001/metrics

# Check WebSocket (should return "Upgrade Required")
curl http://<server>:8000
```

---

## Key NeonDB Settings

| Setting | Value | Purpose |
|---|---|---|
| WAL Batch Size | 100,000 | Optimize write throughput |
| Batch Interval | 100ms | Balance latency vs. batching |
| Snapshot Interval | 1,000,000 | Bound WAL replay time on restart |
| Max Connections | 200 | Handle concurrent clients |
| Shard Config | 0/1 | Single node (ready to scale) |

---

## Monitoring

### From Dokploy Dashboard
- **Projects → neondb → Logs**: real-time container logs
- **Projects → neondb → Metrics**: CPU and memory usage

### From the command line (on the server)
```bash
# View container logs
docker logs $(docker ps -q --filter name=neondb) -f

# Check metrics
curl http://localhost:8001/metrics
```

---

## Scaling to Multiple Nodes

Once comfortable with single-node:
1. Add more NeonDB services with different `NEONDB_SHARD_ID` (0, 1, 2 …)
2. Set `NEONDB_SHARD_COUNT` to the total shard count on all nodes
3. Add a Traefik load balancer rule to distribute clients across shards

---

## Troubleshooting

### Dokploy won't start
```bash
# Check Docker on server
docker ps

# Check Dokploy service
systemctl status dokploy
```

### NeonDB container not starting
- Check **Deployments** tab in Dokploy for build/start errors
- Verify volume mount paths exist and are writable
- Ensure port 8000 is not occupied by another service

### Connection issues
- Verify the Traefik domain route is configured correctly
- Check firewall: ports 80, 443, 8000 must be reachable
- For direct IP access (no domain), connect to `ws://<server-ip>:8000`
