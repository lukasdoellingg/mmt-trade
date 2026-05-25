import type { ChartRuntimeAttachment, ChartWidgetRuntimeProps } from './chartRuntimeTypes';

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function parseAttachment(raw: unknown): ChartRuntimeAttachment | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const scriptId = asString(o.scriptId);
  const localId = asString(o.localId) || scriptId;
  if (!scriptId) return null;
  const statusRaw = asString(o.status);
  const status =
    statusRaw === 'live' || statusRaw === 'error' || statusRaw === 'idle'
      ? statusRaw
      : 'mounting';
  return {
    localId,
    scriptId,
    runtimeId: asString(o.runtimeId) || undefined,
    status,
    createToken: typeof o.createToken === 'number' ? o.createToken : undefined,
  };
}

export function parseChartRuntimeProps(
  props: Record<string, unknown> | undefined,
): ChartWidgetRuntimeProps {
  if (!props) return { runtimes: [] };
  const raw = props.runtimes;
  if (!Array.isArray(raw)) return { runtimes: [] };
  const runtimes: ChartRuntimeAttachment[] = [];
  for (const item of raw) {
    const att = parseAttachment(item);
    if (att) runtimes.push(att);
  }
  return { runtimes };
}

export function serializeChartRuntimeProps(props: ChartWidgetRuntimeProps): Record<string, unknown> {
  return { runtimes: props.runtimes ?? [] };
}
