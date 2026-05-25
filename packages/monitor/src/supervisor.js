#!/usr/bin/env node
/**
 * Ops supervisor — polls backend /health, /ready, and heatmap WS every 30s.
 * Logs JSON lines to logs/health.jsonl (relative to repo root).
 */
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBackendHealth } from './checks/backendHealth.js';
import { probeHeatmapWebSocket } from './checks/upstreamWs.js';
import { probeSessionWebSocket } from './checks/upstreamSessionWs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const LOG_DIR = join(REPO_ROOT, 'logs');
const LOG_FILE = join(LOG_DIR, 'health.jsonl');

const BACKEND_URL = process.env.MONITOR_BACKEND_URL || 'http://localhost:3001';
const WS_BASE = process.env.MONITOR_WS_BASE || 'ws://localhost:3001';
const INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS || 30_000);
const ALERT_WEBHOOK = process.env.MONITOR_ALERT_WEBHOOK || '';

function appendLog(entry) {
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
}

async function runCheck() {
  const ts = new Date().toISOString();
  const mem = process.memoryUsage();

  const http = await checkBackendHealth(BACKEND_URL);
  const ws = await probeHeatmapWebSocket(WS_BASE, { symbol: 'BTCUSDT', tf: '1h', timeoutMs: 6000 });
  const sessionWs = await probeSessionWebSocket(WS_BASE, { symbol: 'BTCUSDT', tf: '1h', timeoutMs: 6000 });

  const ok = http.healthOk && http.readyOk && ws.ok;
  const entry = {
    ts,
    ok,
    backend: BACKEND_URL,
    http,
    ws,
    sessionWs,
    memoryMb: Math.round(mem.rss / 1024 / 1024),
  };

  appendLog(entry);

  if (!ok) {
    const summary = `monitor alert: health=${http.healthOk} ready=${http.readyOk} ws=${ws.ok}`;
    console.error(JSON.stringify({ ts, level: 'error', msg: summary, entry }));
    if (ALERT_WEBHOOK) {
      try {
        await fetch(ALERT_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: summary, entry }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        /* webhook optional */
      }
    }
  } else {
    console.log(JSON.stringify({ ts, level: 'info', msg: 'monitor ok', wsFrames: ws.frames }));
  }
}

console.log(JSON.stringify({
  ts: new Date().toISOString(),
  level: 'info',
  msg: 'monitor supervisor started',
  intervalMs: INTERVAL_MS,
  backend: BACKEND_URL,
}));

void runCheck();
setInterval(() => {
  void runCheck();
}, INTERVAL_MS);
