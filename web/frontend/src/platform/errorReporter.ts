/**
 * Sanitized client error reports → POST /api/client-errors (prod or opt-in).
 */

let reportingEnabled = import.meta.env.PROD || import.meta.env.VITE_ERROR_REPORTING === '1';

const recentKeys = new Map<string, number>();
const DEDUPE_MS = 60_000;

function shouldReport(dedupeKey: string): boolean {
  const now = Date.now();
  const last = recentKeys.get(dedupeKey) ?? 0;
  if (now - last < DEDUPE_MS) return false;
  recentKeys.set(dedupeKey, now);
  return true;
}

export function setClientErrorReporting(enabled: boolean): void {
  reportingEnabled = enabled;
}

export function reportClientError(
  message: string,
  context?: { route?: string; component?: string; stack?: string },
): void {
  if (!reportingEnabled || typeof message !== 'string') return;
  const key = `${context?.component ?? ''}:${message.slice(0, 80)}`;
  if (!shouldReport(key)) return;

  const body = {
    message: message.slice(0, 500),
    route: context?.route?.slice(0, 200),
    component: context?.component?.slice(0, 120),
    stack: context?.stack?.slice(0, 2000),
  };

  void fetch('/api/client-errors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {
    /* fire-and-forget */
  });
}
