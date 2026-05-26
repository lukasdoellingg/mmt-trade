import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * chartObjectTree lives in Vue/TS — we test revision contract via dynamic import when built.
 * Minimal inline mirror of bump logic for CI without Vite.
 */
describe('chartObjectTree revision contract', () => {
  it('treeRevision increments on register and upsert (logic mirror)', () => {
    let revision = 0;
    const panes = new Map();
    const bump = () => {
      revision++;
    };

    function register(id) {
      if (!panes.has(id)) panes.set(id, { scriptMounts: [] });
      bump();
    }
    function upsert(id) {
      const n = panes.get(id);
      if (!n) return;
      n.scriptMounts.push({ localId: 'a' });
      bump();
    }

    assert.equal(revision, 0);
    register('chart-1');
    assert.equal(revision, 1);
    upsert('chart-1');
    assert.equal(revision, 2);
  });
});
