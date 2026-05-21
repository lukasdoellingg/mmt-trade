import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { waitForHttp } from '../helpers/server.mjs';

const BACKEND_DIR = fileURLToPath(new URL('../../web/backend', import.meta.url));

test('API_KEY gate rejects missing credentials', async () => {
  const port = 15_000 + Math.floor(Math.random() * 2_000);
  const child = spawn('node', ['index.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      API_KEY: 'test-secret-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForHttp(`http://127.0.0.1:${port}/api/health`);
    const blocked = await fetch(`http://127.0.0.1:${port}/api/exchanges`);
    assert.equal(blocked.status, 401);

    const allowed = await fetch(`http://127.0.0.1:${port}/api/exchanges`, {
      headers: { 'X-API-Key': 'test-secret-key' },
    });
    assert.equal(allowed.status, 200);

    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      child.on('exit', resolve);
      setTimeout(resolve, 2_000);
    });
  }
});
