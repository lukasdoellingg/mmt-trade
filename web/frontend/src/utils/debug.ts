/**
 * Debug logger gated by build mode. Stripped by Vite in production.
 *
 * Usage:
 *   import { debug } from '@/utils/debug';
 *   debug('[Chart] worker error:', message);
 *
 * The `import.meta.env.DEV` constant is replaced at build time, so the
 * console call is dead-code-eliminated in production builds.
 */

const isDevelopmentBuild = (() => {
  try {
    return import.meta.env?.DEV === true;
  } catch {
    return false;
  }
})();

export function debug(...args: unknown[]): void {
  if (!isDevelopmentBuild) return;
  console.log(...args);
}

export function debugWarn(...args: unknown[]): void {
  if (!isDevelopmentBuild) return;
  console.warn(...args);
}

export function debugError(...args: unknown[]): void {
  // Errors are kept in production too — they signal real failures.
  console.error(...args);
}
