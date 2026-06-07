/**
 * Per-mount script runtime attachment — isolated plot buffer and lifecycle (MMT parity).
 */
import type { ScriptIndicatorId } from '../indicators/indicatorCatalog';
import { symKeyFromSymbol } from '../constants';
import {
  createScriptRuntime,
  cancelPendingRuntime,
  updateScriptInputs,
} from '../engine/feedHubClient';
import { USE_SESSION_MUX } from '../config/featureFlags';

const MAX_PLOT_PRICES = 64;

export type AttachmentState = 'pending' | 'live' | 'error' | 'released';

export class ScriptRuntimeAttachment {
  readonly key: string;
  readonly scopeId: string;
  readonly localId: string;
  readonly templateId: ScriptIndicatorId;
  readonly createToken: number;
  readonly pane: 'overlay' | 'window';
  readonly parentChartWidgetId?: string;
  readonly anchorId?: string;

  state: AttachmentState = 'pending';
  runtimeId: string | null = null;
  errorMessage?: string;
  readonly plotPrices = new Float64Array(MAX_PLOT_PRICES);
  plotCount = 0;
  plotRoles: Uint8Array | null = null;

  private symbol = '';
  private timeframe = '1h';

  constructor(opts: {
    scopeId: string;
    localId: string;
    templateId: ScriptIndicatorId;
    createToken: number;
    pane: 'overlay' | 'window';
    parentChartWidgetId?: string;
    anchorId?: string;
  }) {
    this.scopeId = opts.scopeId;
    this.localId = opts.localId;
    this.templateId = opts.templateId;
    this.createToken = opts.createToken;
    this.pane = opts.pane;
    this.parentChartWidgetId = opts.parentChartWidgetId;
    this.anchorId = opts.anchorId;
    this.key = `${opts.scopeId}:${opts.localId}`;
  }

  mount(symbol: string, timeframe: string, bucketGroup = 6): void {
    if (!USE_SESSION_MUX) {
      this.state = 'error';
      this.errorMessage = 'Script session disabled';
      return;
    }
    if (this.state === 'live' || this.state === 'pending') return;
    this.symbol = symbol;
    this.timeframe = timeframe;
    this.state = 'pending';
    createScriptRuntime(
      this.templateId,
      {
        symbol: symKeyFromSymbol(symbol),
        tf: timeframe,
        bucket_group: bucketGroup,
        createToken: this.createToken,
      },
      this.createToken,
    );
  }

  promoteLive(runtimeId: string): void {
    this.runtimeId = runtimeId;
    this.state = 'live';
  }

  onPlot(prices: Float64Array, roles?: Uint8Array): void {
    const n = Math.min(prices.length, MAX_PLOT_PRICES);
    this.plotPrices.set(prices.subarray(0, n));
    this.plotCount = n;
    this.plotRoles = roles && roles.length >= n ? roles.subarray(0, n) : null;
    this.state = 'live';
  }

  updateInputs(overrides: Record<string, unknown>): void {
    if (this.runtimeId) updateScriptInputs(this.runtimeId, overrides);
  }

  release(): void {
    if (this.state === 'released') return;
    if (this.state === 'pending') {
      cancelPendingRuntime(this.createToken);
    }
    this.runtimeId = null;
    this.plotCount = 0;
    this.state = 'released';
  }
}
