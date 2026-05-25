# Public read-only deployment

## Requirements

- Node.js 20+
- TLS reverse proxy (Caddy or nginx) in front of static frontend + API
- `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on HTML (Vite build + backend already set headers for API)

## Backend

```bash
cp deploy/.env.production.example web/backend/.env
# Edit CORS_ALLOWED_ORIGINS and optional MMT_WS_TOKEN

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
npm run build
# Serve web/frontend/dist behind TLS; proxy /api and /ws to backend :3001
```

## Security checklist

- Set `CORS_ALLOWED_ORIGINS` to your domain only
- Do not enable `?mmt_direct=1` in production (shell build gates this)
- Keep `MMT_WS_TOKEN` only on the server
- Terminate TLS at the proxy; enable HSTS there
