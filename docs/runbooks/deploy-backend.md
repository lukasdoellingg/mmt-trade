# Runbook: Deploy Backend

## Prerequisites

- Node.js ≥ 20
- Reverse proxy with TLS (nginx, Caddy, Cloudflare)
- Environment secrets configured

## Steps

1. **Clone and install**

   ```bash
   git clone https://github.com/lukas/mmt-trade.git
   cd mmt-trade
   npm ci --omit=dev
   ```

2. **Configure environment**

   ```bash
   cp web/backend/.env.example web/backend/.env
   ```

   Required production values:

   | Variable               | Example                    |
   | ---------------------- | -------------------------- |
   | `CORS_ALLOWED_ORIGINS` | `https://desk.example.com` |
   | `PORT`                 | `3001`                     |
   | `MMT_WS_TOKEN`         | _(secret — never log)_     |

3. **Start process**

   ```bash
   npm --workspace web/backend run start
   ```

   Use systemd, PM2, or Docker for supervision.

4. **Verify**

   ```bash
   curl -sf http://127.0.0.1:3001/api/exchanges | jq .
   ```

5. **Proxy**

   Route `/api` and `/ws` from your public origin to the backend. Preserve
   WebSocket upgrade headers.

## Rollback

Redeploy previous git tag. No database migrations in current backend.

## Related

- [`SECURITY.md`](../../SECURITY.md)
- [`docs/API.md`](../API.md)
