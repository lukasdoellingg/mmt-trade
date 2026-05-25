#!/usr/bin/env node
/**
 * Mirrors feedHubWorker pendingJson queue — create_runtime must not drop before OPEN.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('pendingJson queue flushes when socket becomes open', () => {
  const pendingJson = [];
  let open = false;
  const sent = [];

  function flushPendingJson() {
    if (!open) return;
    while (pendingJson.length > 0) {
      const obj = pendingJson.shift();
      if (obj) sent.push(obj);
    }
  }

  function sendJson(obj) {
    if (open) {
      sent.push(obj);
      return;
    }
    pendingJson.push(obj);
  }

  sendJson({ op: 'create_runtime', scriptId: 'aggregated-ob-imbalance', createToken: 42 });
  assert.equal(sent.length, 0);
  assert.equal(pendingJson.length, 1);

  open = true;
  flushPendingJson();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].op, 'create_runtime');
  assert.equal(sent[0].createToken, 42);
  assert.equal(pendingJson.length, 0);
});

test('feedHubWorker supports detach and stream filter', () => {
  const src = readFileSync(join(root, 'web/frontend/src/workers/feedHubWorker.ts'), 'utf8');
  assert.match(src, /type: 'detach'/);
  assert.match(src, /function detachPort/);
  assert.match(src, /e\.streams\.size === 0 \|\| e\.streams\.has/);
});
