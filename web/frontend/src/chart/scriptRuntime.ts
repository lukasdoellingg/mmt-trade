/**
 * Server-side indicator runtime mount — proxies create_runtime via FeedHubWorker.
 * Supports widget-scoped mounts (MMT ScriptRuntimeMount per chart pane).
 */
import { computed, ref, shallowRef } from 'vue';
import {
  createScriptRuntime,
  cancelPendingRuntime,
  onSessionJson,
  onSessionStatus,
  onScriptPlotUpdate,
  subscribeFeedStream,
  subscribeRuntimeStream,
  updateScriptInputs,
  type SessionConnectionStatus,
} from '../engine/feedHubClient';
import { USE_SESSION_MUX } from '../config/featureFlags';
import type { ScriptIndicatorId } from '../indicators/indicatorCatalog';
import { symKeyFromSymbol } from '../constants';
import { chartPaneFindMountByRuntimeId, chartPaneUpsertMount } from '../app/chartObjectTree';
import { ScriptRuntimeAttachment } from './scriptRuntimeAttachment';
import { getLease } from '../workspace/runtimeLockRegistry';

const attachmentRegistry = new Map<string, ScriptRuntimeAttachment>();

export type ScriptRuntimeMount = {
  /** Scoped key `${scopeId}:${localId}`. */
  key: string;
  scopeId: string;
  localId: string;
  runtimeId: string | null;
  templateId: string;
  createToken: number;
  streamKey: string;
  symbol: string;
  timeframe: string;
  status: 'idle' | 'mounting' | 'live' | 'error';
  errorMessage?: string;
  pane: 'overlay' | 'window';
  /** When pane=window — chart widget that owns the object-tree mount row. */
  parentChartWidgetId?: string;
  plotPrices: Float64Array | null;
  plotRoles?: Uint8Array | null;
};

const mounts = shallowRef<Map<string, ScriptRuntimeMount>>(new Map());
const runtimeUnsubs = new Map<string, () => void>();
let jsonListenerInstalled = false;
let plotListenerInstalled = false;
let statusListenerInstalled = false;
let mountSeq = 0;
const mountTimeouts = new Map<number, ReturnType<typeof setTimeout>>();

/** Shared /ws/session connection state from FeedHubWorker. */
export const sessionConnectionStatus = ref<SessionConnectionStatus>('unknown');

const MOUNT_TIMEOUT_MS = 15_000;

function timeframeToSec(tf: string): number {
  const map: Record<string, number> = {
    '1m': 60,
    '5m': 300,
    '15m': 900,
    '30m': 1800,
    '1h': 3600,
    '4h': 14400,
    '1D': 86400,
    '1d': 86400,
  };
  return map[tf] ?? 3600;
}

function mountKey(scopeId: string, localId: string): string {
  return `${scopeId}:${localId}`;
}

function nextCreateToken(): number {
  mountSeq = (mountSeq + 1) & 0xff;
  return ((Date.now() & 0xffffff) << 8) | mountSeq;
}

function clearMountTimeout(token: number): void {
  const t = mountTimeouts.get(token);
  if (t) {
    clearTimeout(t);
    mountTimeouts.delete(token);
  }
}

function scheduleMountTimeout(token: number): void {
  clearMountTimeout(token);
  if (sessionConnectionStatus.value !== 'live') return;
  mountTimeouts.set(
    token,
    setTimeout(() => {
      mountTimeouts.delete(token);
      const next = new Map(mounts.value);
      let matched = false;
      for (const [id, mount] of next) {
        if (mount.createToken === token && mount.status === 'mounting') {
          next.set(id, {
            ...mount,
            status: 'error',
            errorMessage: 'Runtime timeout — check backend /ws/session',
          });
          matched = true;
        }
      }
      if (matched) mounts.value = next;
    }, MOUNT_TIMEOUT_MS),
  );
}

function schedulePendingMountTimeouts(): void {
  for (const mount of mounts.value.values()) {
    if (mount.status === 'mounting' && !mountTimeouts.has(mount.createToken)) {
      scheduleMountTimeout(mount.createToken);
    }
  }
}

function parseCreateTokenFromRuntimeId(runtimeId: string): number | null {
  const last = runtimeId.split(':').pop();
  if (!last) return null;
  const n = Number(last);
  return Number.isFinite(n) ? n : null;
}

function ensureRuntimeSubscription(runtimeId: string): void {
  if (!runtimeUnsubs.has(runtimeId)) {
    runtimeUnsubs.set(runtimeId, subscribeRuntimeStream(runtimeId));
  }
}

function getLeaseForRuntime(runtimeId: string) {
  for (const att of attachmentRegistry.values()) {
    if (att.runtimeId === runtimeId && att.anchorId) {
      return getLease(att.anchorId);
    }
  }
  return undefined;
}

function ensureAttachment(mount: ScriptRuntimeMount, anchorId?: string): ScriptRuntimeAttachment {
  let att = attachmentRegistry.get(mount.key);
  if (!att) {
    att = new ScriptRuntimeAttachment({
      scopeId: mount.scopeId,
      localId: mount.localId,
      templateId: mount.templateId as ScriptIndicatorId,
      createToken: mount.createToken,
      pane: mount.pane,
      parentChartWidgetId: mount.parentChartWidgetId,
      anchorId,
    });
    attachmentRegistry.set(mount.key, att);
  }
  return att;
}

function promoteMountLive(
  next: Map<string, ScriptRuntimeMount>,
  id: string,
  mount: ScriptRuntimeMount,
  runtimeId: string,
): void {
  clearMountTimeout(mount.createToken);
  next.set(id, { ...mount, runtimeId, status: 'live' });
  const att = ensureAttachment(mount);
  att.promoteLive(runtimeId);
  ensureRuntimeSubscription(runtimeId);
  const found = chartPaneFindMountByRuntimeId(runtimeId);
  if (!found) {
    const chartWidgetId = mount.parentChartWidgetId ?? mount.scopeId;
    chartPaneUpsertMount(chartWidgetId, {
      localId: mount.localId,
      scriptId: mount.templateId,
      runtimeId,
      status: 'live',
      createToken: mount.createToken,
      pane: mount.pane,
      windowWidgetId: mount.pane === 'window' ? mount.scopeId : undefined,
    });
  }
}

function releaseRuntimeSubscription(runtimeId: string): void {
  const unsub = runtimeUnsubs.get(runtimeId);
  if (unsub) {
    unsub();
    runtimeUnsubs.delete(runtimeId);
  }
}

function applyPlotToMount(runtimeId: string, prices: Float64Array, roles?: Uint8Array): void {
  const lease = getLeaseForRuntime(runtimeId);
  if (lease?.state === 'suspended') return;

  for (const att of attachmentRegistry.values()) {
    if (
      att.runtimeId === runtimeId ||
      (att.state === 'pending' && att.createToken === parseCreateTokenFromRuntimeId(runtimeId))
    ) {
      att.onPlot(prices, roles);
    }
  }

  const next = new Map(mounts.value);
  let changed = false;
  const tokenFromId = parseCreateTokenFromRuntimeId(runtimeId);
  for (const [id, mount] of next) {
    const byRuntime = mount.runtimeId === runtimeId;
    const byToken = mount.status === 'mounting' && tokenFromId != null && mount.createToken === tokenFromId;
    if (!byRuntime && !byToken) continue;
    if (byToken && !mount.runtimeId) {
      promoteMountLive(next, id, mount, runtimeId);
    }
    const cur = next.get(id)!;
    next.set(id, { ...cur, plotPrices: prices, plotRoles: roles ?? null, status: 'live' });
    changed = true;
  }
  if (changed) mounts.value = next;
}

function syncRuntimeCreated(runtimeId: string, createToken: number): void {
  clearMountTimeout(createToken);
  const next = new Map(mounts.value);
  for (const [id, mount] of next) {
    if (mount.createToken === createToken) {
      promoteMountLive(next, id, mount, runtimeId);
    }
  }
  mounts.value = next;
}

function replayPendingMounts(): void {
  if (!USE_SESSION_MUX) return;
  for (const mount of mounts.value.values()) {
    if (mount.status !== 'mounting' && mount.status !== 'error') continue;
    if (!mount.createToken) continue;
    scheduleMountTimeout(mount.createToken);
    createScriptRuntime(
      mount.templateId,
      {
        symbol: symKeyFromSymbol(mount.symbol),
        tf: mount.timeframe,
        bucket_group: 6,
        createToken: mount.createToken,
      },
      mount.createToken,
    );
  }
}

function ensureListeners(): void {
  if (!USE_SESSION_MUX) return;
  if (!statusListenerInstalled) {
    statusListenerInstalled = true;
    onSessionStatus((status) => {
      sessionConnectionStatus.value = status;
      if (status === 'live') {
        schedulePendingMountTimeouts();
        replayPendingMounts();
      }
    });
  }
  if (!jsonListenerInstalled) {
    jsonListenerInstalled = true;
    onSessionJson((text) => {
      try {
        const msg = JSON.parse(text) as {
          type?: string;
          runtime_id?: string;
          createToken?: number | null;
          message?: string;
        };
        if (msg.type === 'runtime_created' && msg.runtime_id && msg.createToken != null) {
          syncRuntimeCreated(msg.runtime_id, msg.createToken);
        } else if (msg.type === 'error') {
          const token = msg.createToken;
          if (token == null) return;
          clearMountTimeout(token);
          const next = new Map(mounts.value);
          let matched = false;
          for (const [id, mount] of next) {
            if (mount.status === 'mounting' && mount.createToken === token) {
              next.set(id, { ...mount, status: 'error', errorMessage: msg.message ?? 'error' });
              matched = true;
            }
          }
          if (matched) mounts.value = next;
        }
      } catch {
        /* ignore */
      }
    });
  }
  if (!plotListenerInstalled) {
    plotListenerInstalled = true;
    onScriptPlotUpdate((runtimeId, prices, roles) => {
      applyPlotToMount(runtimeId, prices, roles);
    });
  }
}

export function useScriptRuntime() {
  ensureListeners();
  return {
    mounts: computed(() => mounts.value),
    sessionConnectionStatus: computed(() => sessionConnectionStatus.value),

    mount(
      templateId: ScriptIndicatorId,
      symbol: string,
      timeframe: string,
      scopeId = 'global',
      localId?: string,
      pane: 'overlay' | 'window' = 'overlay',
      bucketGroup = 6,
      parentChartWidgetId?: string,
    ): string {
      const lid = localId ?? templateId;
      const key = mountKey(scopeId, lid);
      const existing = mounts.value.get(key);
      if (existing && (existing.status === 'mounting' || existing.status === 'live')) {
        return key;
      }

      if (!USE_SESSION_MUX) {
        const next = new Map(mounts.value);
        next.set(key, {
          key,
          scopeId,
          localId: lid,
          runtimeId: null,
          templateId,
          createToken: 0,
          streamKey: '',
          symbol,
          timeframe,
          status: 'error',
          errorMessage: 'Script session disabled in build (set VITE_USE_SESSION_MUX=1)',
          pane,
          parentChartWidgetId: pane === 'window' ? parentChartWidgetId : undefined,
          plotPrices: null,
        });
        mounts.value = next;
        return key;
      }

      const createToken = nextCreateToken();
      const next = new Map(mounts.value);
      next.set(key, {
        key,
        scopeId,
        localId: lid,
        runtimeId: null,
        templateId,
        createToken,
        streamKey: `runtime:pending:${templateId}:${symKeyFromSymbol(symbol)}:${timeframeToSec(timeframe)}`,
        symbol,
        timeframe,
        status: 'mounting',
        pane,
        parentChartWidgetId: pane === 'window' ? parentChartWidgetId : undefined,
        plotPrices: null,
      });
      mounts.value = next;
      const mountRecord = next.get(key)!;
      ensureAttachment(mountRecord).mount(symbol, timeframe, bucketGroup);
      scheduleMountTimeout(createToken);
      return key;
    },

    unmount(key: string): void {
      const mount = mounts.value.get(key);
      if (mount) clearMountTimeout(mount.createToken);
      const att = attachmentRegistry.get(key);
      if (att) {
        att.release();
        attachmentRegistry.delete(key);
      }
      if (mount?.runtimeId) {
        releaseRuntimeSubscription(mount.runtimeId);
      } else if (mount?.status === 'mounting' && mount.createToken) {
        cancelPendingRuntime(mount.createToken);
      }
      if (!mounts.value.has(key)) return;
      const next = new Map(mounts.value);
      next.delete(key);
      mounts.value = next;
    },

    unmountScope(scopeId: string): void {
      for (const [key, mount] of [...mounts.value.entries()]) {
        if (mount.scopeId === scopeId) this.unmount(key);
      }
    },

    unmountScopeOverlays(scopeId: string): void {
      for (const [key, mount] of [...mounts.value.entries()]) {
        if (mount.scopeId === scopeId && mount.pane === 'overlay') this.unmount(key);
      }
    },

    getMount(key: string): ScriptRuntimeMount | undefined {
      return mounts.value.get(key);
    },

    mountsForScope(scopeId: string, pane?: 'overlay' | 'window'): ScriptRuntimeMount[] {
      const out: ScriptRuntimeMount[] = [];
      for (const m of mounts.value.values()) {
        if (m.scopeId !== scopeId) continue;
        if (pane && m.pane !== pane) continue;
        out.push(m);
      }
      return out;
    },

    updateInputs(runtimeId: string, overrides: Record<string, unknown>): void {
      if (!USE_SESSION_MUX || !runtimeId) return;
      updateScriptInputs(runtimeId, overrides);
    },

    remountAll(
      active: Partial<Record<ScriptIndicatorId, boolean>>,
      symbol: string,
      timeframe: string,
      scopeId = 'global',
    ): void {
      for (const [key, mount] of [...mounts.value.entries()]) {
        if (mount.scopeId === scopeId && mount.pane === 'overlay') this.unmount(key);
      }
      for (const templateId of ['key-levels', 'net-positioning', 'aggregated-ob-imbalance'] as const) {
        if (active[templateId]) this.mount(templateId, symbol, timeframe, scopeId, templateId, 'overlay');
      }
    },

    subscribeBarStats(
      symbol: string,
      timeframe: string,
      onJson: (text: string) => void,
      bucketGroup = 6,
    ): () => void {
      if (!USE_SESSION_MUX) return () => {};
      return subscribeFeedStream(
        {
          symbol: symKeyFromSymbol(symbol),
          timeframe,
          stream: 13,
          bucketGroup,
        },
        (_key, buffer) => {
          try {
            onJson(new TextDecoder().decode(new Uint8Array(buffer)));
          } catch {
            /* ignore */
          }
        },
      );
    },
  };
}
