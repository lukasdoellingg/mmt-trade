/**
 * Server-side indicator runtime mount — proxies create_runtime via FeedHubWorker.
 * Supports widget-scoped mounts (MMT ScriptRuntimeMount per chart pane).
 */
import { computed, ref, shallowRef } from 'vue';
import {
  createScriptRuntime,
  destroyScriptRuntime,
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
import {
  chartPaneFindMountByRuntimeId,
  chartPaneUpsertMount,
} from '../app/chartObjectTree';

export type ScriptRuntimeMount = {
  /** Scoped key `${scopeId}:${localId}`. */
  key: string;
  scopeId: string;
  localId: string;
  runtimeId: string | null;
  templateId: string;
  createToken: number;
  streamKey: string;
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
    '1m': 60, '5m': 300, '15m': 900, '30m': 1800,
    '1h': 3600, '4h': 14400, '1D': 86400, '1d': 86400,
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

function releaseRuntimeSubscription(runtimeId: string): void {
  const unsub = runtimeUnsubs.get(runtimeId);
  if (unsub) {
    unsub();
    runtimeUnsubs.delete(runtimeId);
  }
}

function applyPlotToMount(runtimeId: string, prices: Float64Array, roles?: Uint8Array): void {
  const next = new Map(mounts.value);
  let changed = false;
  for (const [id, mount] of next) {
    if (mount.runtimeId === runtimeId) {
      next.set(id, { ...mount, plotPrices: prices, plotRoles: roles ?? null });
      changed = true;
    }
  }
  if (changed) mounts.value = next;
}

function syncRuntimeCreated(runtimeId: string, createToken: number): void {
  clearMountTimeout(createToken);
  const next = new Map(mounts.value);
  for (const [id, mount] of next) {
    if (mount.createToken === createToken) {
      next.set(id, { ...mount, runtimeId, status: 'live' });
      if (!runtimeUnsubs.has(runtimeId)) {
        runtimeUnsubs.set(runtimeId, subscribeRuntimeStream(runtimeId));
      }
      const found = chartPaneFindMountByRuntimeId(runtimeId);
      if (!found) {
        for (const [, m] of next) {
          if (m.createToken === createToken) {
            const chartWidgetId = m.parentChartWidgetId ?? m.scopeId;
            chartPaneUpsertMount(chartWidgetId, {
              localId: m.localId,
              scriptId: m.templateId,
              runtimeId,
              status: 'live',
              createToken,
              pane: m.pane,
              windowWidgetId: m.pane === 'window' ? m.scopeId : undefined,
            });
            break;
          }
        }
      }
    }
  }
  mounts.value = next;
}

function ensureListeners(): void {
  if (!USE_SESSION_MUX) return;
  if (!statusListenerInstalled) {
    statusListenerInstalled = true;
    onSessionStatus((status) => {
      sessionConnectionStatus.value = status;
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
      } catch { /* ignore */ }
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
        status: 'mounting',
        pane,
        parentChartWidgetId: pane === 'window' ? parentChartWidgetId : undefined,
        plotPrices: null,
      });
      mounts.value = next;
      if (USE_SESSION_MUX) {
        scheduleMountTimeout(createToken);
        createScriptRuntime(templateId, {
          symbol: symKeyFromSymbol(symbol),
          tf: timeframe,
          bucket_group: bucketGroup,
          createToken,
        }, createToken);
      }
      return key;
    },

    unmount(key: string): void {
      const mount = mounts.value.get(key);
      if (mount) clearMountTimeout(mount.createToken);
      if (mount?.runtimeId) {
        releaseRuntimeSubscription(mount.runtimeId);
        destroyScriptRuntime(mount.runtimeId);
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
          } catch { /* ignore */ }
        },
      );
    },
  };
}
