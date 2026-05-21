#!/usr/bin/env node
/**
 * Write MMT_WS_TOKEN into web/backend/.env (never committed if .env is gitignored).
 *
 * Usage:
 *   node scripts/setup-mmt-token.mjs <JWT>
 *   MMT_WS_TOKEN=eyJ... node scripts/setup-mmt-token.mjs
 *
 * Token source: app.mmt.gg → DevTools → Network → WS → ?token=...
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../web/backend/.env');
const examplePath = resolve(__dirname, '../web/backend/.env.example');

function tokenFromArgv() {
  const arg = process.argv[2]?.trim();
  if (arg && arg !== '--help' && arg !== '-h') return arg;
  const env = process.env.MMT_WS_TOKEN?.trim();
  if (env) return env;
  return null;
}

const token = tokenFromArgv();
if (!token) {
  console.error(`Usage: node scripts/setup-mmt-token.mjs <JWT-from-mmt.gg-ws-url>
Or:    MMT_WS_TOKEN=eyJ... node scripts/setup-mmt-token.mjs

Get the token from DevTools on app.mmt.gg:
  Network → WS → wss://eu-central-2.mmt.gg/api/v2/ws?token=<copy-this>

Then restart: npm run dev:backend`);
  process.exit(1);
}

if (!/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
  console.warn('[setup-mmt] Warning: token does not look like a JWT (expected eyJ...). Continuing anyway.');
}

let body = existsSync(envPath) ? readFileSync(envPath, 'utf8') : readFileSync(examplePath, 'utf8');

const line = `MMT_WS_TOKEN=${token}`;
if (/^MMT_WS_TOKEN=.*$/m.test(body)) {
  body = body.replace(/^MMT_WS_TOKEN=.*$/m, line);
} else {
  body = body.trimEnd() + '\n\n' + line + '\n';
}

if (!/^MMT_WS_HOST=/m.test(body)) {
  body += 'MMT_WS_HOST=eu-central-2.mmt.gg\n';
}
if (!/^MMT_APP_VERSION=/m.test(body)) {
  body += 'MMT_APP_VERSION=4.2.2\n';
}

writeFileSync(envPath, body, { mode: 0o600 });
console.log(`[setup-mmt] Wrote MMT_WS_TOKEN to ${envPath}`);
console.log('[setup-mmt] Restart backend: npm run dev:backend');
console.log('[setup-mmt] Verify: curl -s http://localhost:3001/api/health | jq .heatmapSource');
