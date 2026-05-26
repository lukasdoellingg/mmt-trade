/**
 * Extract horizontal plot prices from script-runtime JSON (create_runtime / updates).
 */
export type ScriptPlotLine = {
  price: number;
  color?: string;
  label?: string;
};

export type ParsedScriptRuntimePayload = {
  runtimeId: string | null;
  lines: ScriptPlotLine[];
};

function isFinitePrice(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function pushPrice(lines: ScriptPlotLine[], price: unknown, color?: string, label?: string): void {
  if (!isFinitePrice(price)) return;
  lines.push({ price, color, label });
}

function collectFromPlotObject(lines: ScriptPlotLine[], plot: Record<string, unknown>): void {
  const price = plot.price ?? plot.y ?? plot.value ?? plot.level;
  const color = typeof plot.color === 'string' ? plot.color : undefined;
  const label =
    typeof plot.label === 'string' ? plot.label : typeof plot.text === 'string' ? plot.text : undefined;
  pushPrice(lines, price, color, label);
  if (Array.isArray(plot.points)) {
    for (const pt of plot.points) {
      if (pt && typeof pt === 'object') collectFromPlotObject(lines, pt as Record<string, unknown>);
    }
  }
}

function collectFromArray(lines: ScriptPlotLine[], arr: unknown[]): void {
  for (const item of arr) {
    if (typeof item === 'number') {
      pushPrice(lines, item);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (Array.isArray(row.levels)) collectFromArray(lines, row.levels);
    if (Array.isArray(row.lines)) collectFromArray(lines, row.lines);
    if (Array.isArray(row.plots)) {
      for (const p of row.plots) {
        if (p && typeof p === 'object') collectFromPlotObject(lines, p as Record<string, unknown>);
      }
    }
    collectFromPlotObject(lines, row);
  }
}

function walkObject(lines: ScriptPlotLine[], obj: Record<string, unknown>, depth: number): void {
  if (depth > 6) return;
  for (const key of ['levels', 'lines', 'plots', 'hlines', 'horizontal_lines', 'series', 'data']) {
    const v = obj[key];
    if (Array.isArray(v)) collectFromArray(lines, v);
  }
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) collectFromArray(lines, v);
    else if (v && typeof v === 'object' && depth < 5) {
      walkObject(lines, v as Record<string, unknown>, depth + 1);
    }
  }
}

/** Parse UTF-8 JSON from a runtime:* session envelope. */
export function parseScriptRuntimePayload(
  text: string,
  streamRuntimeId?: string,
): ParsedScriptRuntimePayload | null {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }

  const data = (msg.data && typeof msg.data === 'object' ? msg.data : msg) as Record<string, unknown>;
  const runtimeId =
    (typeof data.runtime_id === 'string' ? data.runtime_id : null) ??
    (typeof streamRuntimeId === 'string' && streamRuntimeId.startsWith('runtime:')
      ? streamRuntimeId.slice('runtime:'.length)
      : null);

  const lines: ScriptPlotLine[] = [];
  walkObject(lines, data, 0);
  walkObject(lines, msg, 0);

  if (!lines.length && !runtimeId) return null;
  return { runtimeId, lines };
}

/** Flat prices for ring buffer / worker handoff (dedupe by price, no Set alloc). */
export function plotLinesToPrices(lines: ScriptPlotLine[], out: Float64Array, max: number): number {
  let n = 0;
  outer: for (let i = 0; i < lines.length && n < max; i++) {
    const p = lines[i].price;
    const key = Math.round(p * 1e4);
    for (let j = 0; j < n; j++) {
      if (Math.round(out[j] * 1e4) === key) continue outer;
    }
    out[n++] = p;
  }
  return n;
}
