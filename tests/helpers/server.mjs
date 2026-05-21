import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BACKEND_DIR = fileURLToPath(new URL('../../web/backend', import.meta.url));

/**
 * Wait until `fetch(url)` succeeds or timeoutMs elapses.
 * @param {string} url
 * @param {number} timeoutMs
 */
export async function waitForHttp(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw lastError ?? new Error(`timeout waiting for ${url}`);
}

/**
 * Start the Express backend on a random port; run fn(port); then stop.
 * @param {(port: number) => Promise<void>} fn
 */
export async function withBackend(fn) {
  const port = 14_000 + Math.floor(Math.random() * 4_000);
  const child = spawn('node', ['index.js'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForHttp(`http://127.0.0.1:${port}/api/exchanges`);
    await fn(port);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      child.on('exit', resolve);
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve(undefined);
      }, 3_000);
    });
    if (stderr && process.env.DEBUG_BACKEND) {
      process.stderr.write(stderr);
    }
  }
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {string} cwd
 * @param {number} port
 */
export async function waitForVitePreview(child, cwd, port) {
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`preview exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) return url;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for vite preview at ${url} (cwd=${path.basename(cwd)})`);
}
