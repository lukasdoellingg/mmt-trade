# Public read-only deployment

## Requirements

- Node.js 20+
- TLS reverse proxy (Caddy or nginx) in front of static frontend + API
- `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on HTML (Vite build + backend already set headers for API)

## Backend

```bash
cp deploy/.env.production.example web/backend/.env
# Edit CORS_ALLOWED_ORIGINS

npm ci
npm run start:backend
```

Health checks:

- `GET /health` — liveness
- `GET /ready` — readiness (feeds + CCXT)

## Monitoring

```bash
npm run monitor
```

Logs append to `logs/health.jsonl`. Optional `MONITOR_ALERT_WEBHOOK` for failures.

## PM2 (24/7)

```bash
npm install -g pm2
pm2 start deploy/backend.ecosystem.config.cjs
pm2 save
```

## Frontend

```bash
# Session mux (script indicators, bar stats) is on by default; override only to disable:
# VITE_USE_SESSION_MUX=0 npm run build
npm run build
# Serve web/frontend/dist behind TLS; proxy /api and /ws to backend :3001
```

`web/frontend/.env.production` sets `VITE_USE_SESSION_MUX=1`. CI builds with the same flag.

## Security checklist

- Set `CORS_ALLOWED_ORIGINS` to your domain only
- Do not enable `?mmt_direct=1` in production (shell build gates this)
- `/ws/session` and `/ws/heatmap` are first-party — no external WS token required
- Terminate TLS at the proxy; enable HSTS there
