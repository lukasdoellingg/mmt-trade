/**
 * Server-side indicator runtime mount — proxies create_runtime via FeedHubWorker.
 */
import { computed, shallowRef } from 'vue';
import { createScriptRuntime, onSessionJson, subscribeFeedStream } from '../engine/feedHubClient';
import { USE_SESSION_MUX } from '../config/featureFlags';
import { symKeyFromSymbol } from '../constants';

export type ScriptRuntimeMount = {
  runtimeId: string | null;
  templateId: string;
  createToken: number;
  streamKey: string;
  status: 'idle' | 'mounting' | 'live' | 'error';
};

const mounts = shallowRef<Map<string, ScriptRuntimeMount>>(new Map());
let jsonListenerInstalled = false;

function timeframeToSec(tf: string): number {
  const map: Record<string, number> = {
    '1m': 60, '5m': 300, '15m': 900, '30m': 1800,
    '1h': 3600, '4h': 14400, '1D': 86400, '1d': 86400,
  };
  return map[tf] ?? 3600;
}

function ensureJsonListener(): void {
  if (jsonListenerInstalled || !USE_SESSION_MUX) return;
  jsonListenerInstalled = true;
  onSessionJson((text) => {
    try {
      const msg = JSON.parse(text) as {
        type?: string;
        runtime_id?: string;
        createToken?: number | null;
        message?: string;
      };
      if (msg.type === 'runtime_created' && msg.runtime_id) {
        const next = new Map(mounts.value);
        for (const [id, mount] of next) {
          if (msg.createToken != null && mount.createToken === msg.createToken) {
            next.set(id, { ...mount, runtimeId: msg.runtime_id, status: 'live' });
          }
        }
        mounts.value = next;
      } else if (msg.type === 'error') {
        const next = new Map(mounts.value);
        for (const [id, mount] of next) {
          if (mount.status === 'mounting') {
            next.set(id, { ...mount, status: 'error' });
          }
        }
        mounts.value = next;
      }
    } catch { /* ignore */ }
  });
}

export function useScriptRuntime() {
  ensureJsonListener();
  return {
    mounts: computed(() => mounts.value),

    mount(templateId: string, symbol: string, timeframe: string, bucketGroup = 6): string {
      const mountId = `${templateId}:${symbol}:${timeframe}`;
      const createToken = (mounts.value.size + 1) | 0;
      const next = new Map(mounts.value);
      next.set(mountId, {
        runtimeId: null,
        templateId,
        createToken,
        streamKey: `barstats:${symKeyFromSymbol(symbol)}:13:${timeframeToSec(timeframe)}:${bucketGroup}`,
        status: 'mounting',
      });
      mounts.value = next;
      if (USE_SESSION_MUX) {
        createScriptRuntime(templateId, {
          symbol: symKeyFromSymbol(symbol),
          tf: timeframe,
          bucket_group: bucketGroup,
          createToken,
        });
      }
      return mountId;
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

    unmount(mountId: string): void {
      if (!mounts.value.has(mountId)) return;
      const next = new Map(mounts.value);
      next.delete(mountId);
      mounts.value = next;
    },
  };
}
